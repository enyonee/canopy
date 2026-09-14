// The catalog. A block declares its effects and requirements; the graph never
// reaches past this list. Adding a block here is the only way the language grows.
//
// A block runs inside the action's transaction and sees:
//   store, graph, entity, id, values  — the current row and the submitted form
//   step                              — its own node in the graph
//   resolve(obj)                      — "@row.x", "@me", "@created", "= expr" inside values
//   text(str)                         — "{row.title}" interpolation for human text
//   run(steps, extraCtx)              — nested steps (db.each)
import { toMinor } from './spec.mjs';

export const CATALOG = {
  'db.create': {
    summary: 'create a row of the action entity from submitted values',
    effects: ['db.write'], requires: [],
    run: ({ store, entity, values }) => ({ id: store.insert(entity, values) }),
  },
  'db.update': {
    summary: 'update the current row with the given "set" values',
    effects: ['db.write'], requires: ['set'],
    run: ({ store, entity, id, step, resolve = (x) => x }) => { store.update(entity, id, resolve(step.set)); return {}; },
  },
  'db.delete': {
    summary: 'delete the current row',
    effects: ['db.write'], requires: [],
    run: ({ store, entity, id }) => { store.remove(entity, id); return {}; },
  },
  'db.toggle': {
    summary: 'flip a boolean field of the current row; needs "field"',
    effects: ['db.write'], requires: ['field'],
    run: ({ store, entity, id, step }) => {
      const row = store.get(entity, id);
      store.update(entity, id, { [step.field]: row[step.field] ? 0 : 1 });
      return {};
    },
  },
  // --- added while modelling apps 2..11; every entry here is a recorded catalog miss ---
  'random.pick': {
    summary: 'pick a random row of "from" (weighted by "weight" if given) and expose it as @picked',
    effects: ['random'], requires: ['from'],
    run: ({ store, step }) => {
      const rows = store.list(step.from, {});
      if (!rows.length) throw new Error(`random.pick: ${step.from} is empty`);
      const weights = rows.map((r) => (step.weight ? Math.max(0, Number(r[step.weight]) || 0) : 1));
      const total = weights.reduce((a, b) => a + b, 0) || rows.length;
      let n = Math.random() * total;
      const hit = rows.find((_, i) => (n -= weights[i] || 1) <= 0);
      return { picked: hit };
    },
  },
  'db.createRow': {
    summary: 'create a row of "entity" from literal "values" ("@field" reads the current row)',
    effects: ['db.write'], requires: ['entity', 'values'],
    run: ({ store, step, resolve }) => ({ id: store.insert(step.entity, resolve(step.values)) }),
  },
  'check.matchRef': {
    summary: 'compare "field" of the current row with "against" on the row it references through "ref"; write 1/0 into "into"',
    effects: ['db.write'], requires: ['ref', 'field', 'against', 'into'],
    run: ({ store, entity, id, step }) => {
      const row = store.get(entity, id);
      const refField = store.field(entity, step.ref);
      const target = store.get(refField.target, row[step.ref]);
      const ok = target && String(target[step.against]).trim().toLowerCase()
        === String(row[step.field]).trim().toLowerCase() ? 1 : 0;
      store.update(entity, id, { [step.into]: ok });
      return { matched: ok };
    },
  },
  // --- added for the CRM / shop class: money, stock, carts, and effects that leave the process ---
  'db.adjust': {
    summary: 'add "by" (a number or "= expr") to numeric "field" of a row: the current one, or "entity" + "id" ("@row.product")',
    effects: ['db.write'], requires: ['field', 'by'],
    run: ({ store, entity, id, step, resolve }) => {
      const target = step.entity || entity;
      const targetId = step.id === undefined ? id : resolve({ v: step.id }).v;
      const row = store.get(target, targetId);
      if (!row) throw new Error(`db.adjust: no ${target} #${targetId}`);
      const f = store.field(target, step.field);
      let by = Number(resolve({ v: step.by }).v);
      if (Number.isNaN(by)) throw new Error(`db.adjust: "by" is not a number`);
      if (f.kind === 'money') by = toMinor(by);
      const next = (row[step.field] ?? 0) + by;
      if (step.min !== undefined && next < step.min) throw new Error(step.message || `${target}.${step.field} cannot go below ${step.min}`);
      store.update(target, targetId, { [step.field]: f.kind === 'money' ? next / 100 : next });
      return { adjusted: next };
    },
  },
  'db.ensure': {
    summary: 'find the first row of "entity" matching "where", or create it from where + "values"; exposes it as @found',
    effects: ['db.write'], requires: ['entity', 'where'],
    run: ({ store, step, resolve }) => {
      const where = resolve(step.where);
      const [hit] = store.list(step.entity, { where, sort: { field: 'id', dir: 'asc' } });
      if (hit) return { found: hit, created: false };
      const id = store.insert(step.entity, { ...where, ...resolve(step.values || {}) });
      return { found: store.get(step.entity, id), created: true };
    },
  },
  'db.each': {
    summary: 'run the nested "do" steps once per row of "from" matching "where"; the row is @each',
    effects: ['db.read'], requires: ['from', 'do'],
    run: ({ store, step, resolve, run }) => {
      const rows = store.list(step.from, { where: resolve(step.where || {}), sort: { field: 'id', dir: 'asc' } });
      for (const row of rows) run(step.do, { each: row, eachEntity: step.from });
      return { count: rows.length };
    },
  },
  'http.send': {
    summary: 'queue a JSON "body" to the http "connector" (optional "path" appended to its url); delivered after commit, visible in /outbox as @delivery',
    effects: ['http.out'], requires: ['connector', 'body'],
    run: ({ store, graph, step, resolve }) => {
      const c = graph.connectors[step.connector];
      const target = c.url + (step.path ? resolve({ v: step.path }).v : '');
      return { delivery: store.enqueue({ kind: 'http', connector: step.connector, target, payload: resolve(step.body) }) };
    },
  },
  'mail.send': {
    summary: 'queue a letter through the mail "connector": "to" (an address or "@row.email"), "subject", "text" with {row.field} placeholders',
    effects: ['mail.out'], requires: ['connector', 'to', 'subject'],
    run: ({ store, graph, step, resolve, text }) => {
      const c = graph.connectors[step.connector];
      const to = resolve({ v: step.to }).v;
      const payload = { from: c.from || null, to, subject: text(step.subject), text: text(step.text || '') };
      return { delivery: store.enqueue({ kind: 'mail', connector: step.connector, target: String(to ?? ''), payload }) };
    },
  },
};

export const search = (query) => {
  const q = query.toLowerCase();
  return Object.entries(CATALOG)
    .filter(([name, b]) => name.includes(q) || b.summary.toLowerCase().includes(q))
    .map(([name, b]) => `${name}(${b.requires.join(', ')}) — ${b.summary} [${b.effects.join(',')}]`);
};
