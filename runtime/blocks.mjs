// The catalog. A block declares its effects and requirements; the graph never
// reaches past this list. Adding a block — here or in a plugin — is the only way
// the language grows. One entry is the whole life of a block:
//
//   summary, effects, requires   — what the model reads in the catalog
//   connector                    — the transport kind a "connector" parameter must have
//   check(step, h)               — extra checker rules; h.err(path, message, hint), h.fields, h.entity
//   exposes(step)                — names the block adds to the step context: { found: 'Entity' }
//   nested(step)                 — step lists inside the block, each with the names it adds
//   run(ctx)                     — the effect, inside the action's transaction; ctx has
//     store, graph, entity, id, values, step, resolve(obj), text(str), run(steps, extra), user
import { toMinor } from './fields.mjs';

/** @type {Record<string, import('./types.d.ts').BlockType>} */
export const CATALOG = {
  'db.create': {
    summary: 'create a row of the action entity from submitted values',
    effects: ['db.write'], requires: [],
    run: ({ store, entity, values, fireCreated }) => { const id = store.insert(entity, values); fireCreated(entity, id, values); return { id }; },
  },
  'db.update': {
    summary: 'update the current row with the given "set" values',
    effects: ['db.write'], requires: ['set'],
    run: ({ store, entity, id, step, resolve = (x) => x }) => { store.update(entity, id, resolve(step.set)); return {}; },
  },
  'db.set': {
    summary: 'update "set" values of an arbitrary row named by "entity" + "id" (e.g. "@found.id", "@each.id", "@row.ref") — like db.update, but not limited to the current row',
    effects: ['db.write'], requires: ['entity', 'id', 'set'],
    run: ({ store, step, resolve }) => { store.update(step.entity, resolve({ v: step.id }).v, resolve(step.set)); return {}; },
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
    exposes: (step) => ({ picked: step.from }),
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
    summary: 'create a row of "entity" from literal "values" ("@field" reads the current row); fires its "created" event, like any other create',
    effects: ['db.write'], requires: ['entity', 'values'],
    run: ({ store, step, resolve, fireCreated }) => {
      const values = resolve(step.values);
      const id = store.insert(step.entity, values);
      fireCreated(step.entity, id, values);
      return { id };
    },
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
    summary: 'add "by" (a number or "= expr") to a numeric "field" — stock, counters, balances — of the current row, or of "entity" + "id" ("@row.product"); "min" refuses below a floor',
    effects: ['db.write'], requires: ['field', 'by'],
    check: (step, h) => {
      const target = step.entity || h.entity;
      const f = target && h.fields[target]?.[step.field];
      if (f && !f.type.numeric) h.err(`${h.path}/field`, `db.adjust needs a numeric field; ${target}.${step.field} is ${f.kind}`);
      if (step.entity && step.id === undefined) h.err(`${h.path}/id`, 'db.adjust on another entity needs "id" ("@row.product")');
    },
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
    summary: 'find the first row of "entity" matching "where", or create it from where + "values"; exposes it as @found, and @made says whether it was created — a made row fires its "created" event',
    effects: ['db.write'], requires: ['entity', 'where'],
    exposes: (step) => ({ found: step.entity }),
    run: ({ store, step, resolve, fireCreated }) => {
      const where = resolve(step.where);
      const [hit] = store.list(step.entity, { where, sort: { field: 'id', dir: 'asc' } });
      if (hit) return { found: hit, made: false };
      const values = { ...where, ...resolve(step.values || {}) };
      const id = store.insert(step.entity, values);
      fireCreated(step.entity, id, values);
      return { found: store.get(step.entity, id), made: true };
    },
  },
  'db.each': {
    summary: 'run the nested "do" steps once per row of "from" matching "where"; the row is @each',
    effects: ['db.read'], requires: ['from', 'do'],
    nested: (step) => [{ steps: step.do, path: 'do', adds: { each: step.from } }],
    run: ({ store, step, resolve, run }) => {
      const rows = store.list(step.from, { where: resolve(step.where || {}), sort: { field: 'id', dir: 'asc' } });
      for (const row of rows) run(step.do, { each: row, eachEntity: step.from });
      return { count: rows.length };
    },
  },
  'http.send': {
    summary: 'queue a JSON "body" to the http "connector" (optional "path" appended to its url); delivered after commit, visible in /outbox as @delivery',
    effects: ['http.out'], requires: ['connector', 'body'], connector: 'http',
    run: ({ store, graph, step, resolve }) => {
      const c = graph.connectors[step.connector];
      const target = c.url + (step.path ? resolve({ v: step.path }).v : '');
      return { delivery: store.enqueue({ kind: 'http', connector: step.connector, target, payload: resolve(step.body) }) };
    },
  },
  'connector.send': {
    summary: 'queue a JSON "body" to any "connector"; the connector\'s kind picks the transport (a plugin transport needs no block of its own)',
    effects: ['out'], requires: ['connector', 'body'],
    run: ({ store, graph, step, resolve }) => {
      const c = graph.connectors[step.connector];
      return { delivery: store.enqueue({ kind: c.kind, connector: step.connector, target: String(c.url || c.file || c.to || step.connector), payload: resolve(step.body) }) };
    },
  },
  'mail.send': {
    summary: 'queue a letter through the mail "connector": "to" (an address or "@row.email"), "subject", "text" with {row.field} placeholders',
    effects: ['mail.out'], requires: ['connector', 'to', 'subject'], connector: 'mail',
    run: ({ store, graph, step, resolve, text }) => {
      const c = graph.connectors[step.connector];
      const to = resolve({ v: step.to }).v;
      const payload = { from: c.from || null, to, subject: text(step.subject), text: text(step.text || '') };
      return { delivery: store.enqueue({ kind: 'mail', connector: step.connector, target: String(to ?? ''), payload }) };
    },
  },
};

export const search = (query, catalog = CATALOG) => {
  const q = query.toLowerCase();
  return Object.entries(catalog)
    .filter(([name, b]) => name.includes(q) || b.summary.toLowerCase().includes(q))
    .map(([name, b]) => `${name}(${b.requires.join(', ')}) — ${b.summary} [${b.effects.join(',')}]`);
};
