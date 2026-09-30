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
import { prepare } from './connectors/engine.mjs';
import { checkCall } from './check/calls.mjs';

// A step's "where" is the author's own filter, so a key that resolved to undefined or '' (an empty form field) ("@values.order"
// with no order submitted, "@me" with nobody signed in) must never fall out of it: the store reads an
// absent filter as "no filter" (right for a list's ?field= query, wrong here). Returns the path of the
// first unresolved key ("order", "n.gte", "status.in.1"), or null. null itself stays IS NULL.
function unresolvedKey(where, prefix = '') {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined || v === '') return prefix + k;
    if (v && typeof v === 'object') { const deep = unresolvedKey(v, `${prefix}${k}.`); if (deep) return deep; }
  }
  return null;
}

// Resolve a step's "where" and refuse an unresolved key: a read block matches no rows (the trace says
// why), a write block throws, so the action is refused and rolled back instead of acting on a guess.
async function resolvedWhere(ctx, block, write) {
  const where = await ctx.resolve(ctx.step.where || {});
  const key = unresolvedKey(where);
  if (key === null) return where;
  ctx.trace({ kind: 'where_unresolved', block, key });
  if (write) throw new Error(`${block}: "where" key "${key}" resolved to nothing; refusing to act on every row`);
  return null;
}

/** @type {Record<string, import('./types.d.ts').BlockType>} */
export const CATALOG = {
  'db.create': {
    summary: 'create a row of the action entity from submitted values',
    effects: ['db.write'], requires: [],
    run: async ({ store, entity, values, fireCreated }) => { const id = await store.insert(entity, values); await fireCreated(entity, id, values); return { id }; },
  },
  'db.update': {
    summary: 'update the current row with the given "set" values',
    effects: ['db.write'], requires: ['set'],
    run: async ({ store, entity, id, step, resolve = (x) => x }) => { await store.update(entity, id, await resolve(step.set)); return {}; },
  },
  'db.set': {
    summary: 'update "set" values of an arbitrary row named by "entity" + "id" (e.g. "@found.id", "@each.id", "@row.ref") — like db.update, but not limited to the current row',
    effects: ['db.write'], requires: ['entity', 'id', 'set'],
    run: async ({ store, step, resolve }) => { await store.update(step.entity, (await resolve({ v: step.id })).v, await resolve(step.set)); return {}; },
  },
  'db.delete': {
    summary: 'delete the current row',
    effects: ['db.write'], requires: [],
    run: async ({ store, entity, id }) => { await store.remove(entity, id); return {}; },
  },
  'db.toggle': {
    summary: 'flip a boolean field of the current row; needs "field"',
    effects: ['db.write'], requires: ['field'],
    run: async ({ store, entity, id, step }) => {
      const row = await store.get(entity, id);
      await store.update(entity, id, { [step.field]: row[step.field] ? 0 : 1 });
      return {};
    },
  },
  // --- added while modelling apps 2..11; every entry here is a recorded catalog miss ---
  'random.pick': {
    summary: 'pick a random row of "from" (weighted by "weight" if given) and expose it as @picked',
    effects: ['random'], requires: ['from'],
    exposes: (step) => ({ picked: step.from }),
    run: async ({ store, step }) => {
      const rows = await store.list(step.from, {});
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
    run: async ({ store, step, resolve, fireCreated }) => {
      const values = await resolve(step.values);
      const id = await store.insert(step.entity, values);
      await fireCreated(step.entity, id, values);
      return { id };
    },
  },
  'check.matchRef': {
    summary: 'compare "field" of the current row with "against" on the row it references through "ref"; write 1/0 into "into"',
    effects: ['db.write'], requires: ['ref', 'field', 'against', 'into'],
    run: async ({ store, entity, id, step }) => {
      const row = await store.get(entity, id);
      const refField = store.field(entity, step.ref);
      const target = await store.get(refField.target, row[step.ref]);
      const ok = target && String(target[step.against]).trim().toLowerCase()
        === String(row[step.field]).trim().toLowerCase() ? 1 : 0;
      await store.update(entity, id, { [step.into]: ok });
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
    run: async ({ store, entity, id, step, resolve }) => {
      const target = step.entity || entity;
      const targetId = step.id === undefined ? id : (await resolve({ v: step.id })).v;
      const row = await store.get(target, targetId);
      if (!row) throw new Error(`db.adjust: no ${target} #${targetId}`);
      const f = store.field(target, step.field);
      let by = Number((await resolve({ v: step.by })).v);
      if (Number.isNaN(by)) throw new Error(`db.adjust: "by" is not a number`);
      if (f.kind === 'money') by = toMinor(by);
      const next = (row[step.field] ?? 0) + by;
      if (step.min !== undefined && next < step.min) throw new Error(step.message || `${target}.${step.field} cannot go below ${step.min}`);
      await store.update(target, targetId, { [step.field]: f.kind === 'money' ? next / 100 : next });
      return { adjusted: next };
    },
  },
  'db.ensure': {
    summary: 'find the first row of "entity" matching "where", or create it from where + "values"; exposes it as @found, and @made says whether it was created — a made row fires its "created" event',
    effects: ['db.write'], requires: ['entity', 'where'],
    exposes: (step) => ({ found: step.entity }),
    run: async (ctx) => {
      const { store, step, resolve, fireCreated } = ctx;
      const where = await resolvedWhere(ctx, 'db.ensure', true);
      const [hit] = await store.list(step.entity, { where, sort: { field: 'id', dir: 'asc' } });
      if (hit) return { found: hit, made: false };
      const values = { ...where, ...await resolve(step.values || {}) };
      const id = await store.insert(step.entity, values);
      await fireCreated(step.entity, id, values);
      return { found: await store.get(step.entity, id), made: true };
    },
  },
  'db.each': {
    summary: 'run the nested "do" steps once per row of "from" matching "where"; the row is @each',
    effects: ['db.read'], requires: ['from', 'do'],
    nested: (step) => [{ steps: step.do, path: 'do', adds: { each: step.from } }],
    run: async (ctx) => {
      const { store, step, run } = ctx;
      const where = await resolvedWhere(ctx, 'db.each', false);
      const rows = where ? await store.list(step.from, { where, sort: { field: 'id', dir: 'asc' } }) : [];
      for (const row of rows) await run(step.do, { each: row, eachEntity: step.from });
      return { count: rows.length };
    },
  },
  'http.send': {
    summary: 'queue a JSON "body" to the http "connector" (optional "path" appended to its url); delivered after commit, visible in /outbox as @delivery',
    effects: ['http.out'], requires: ['connector', 'body'], connector: 'http',
    run: async ({ store, graph, step, resolve }) => {
      const c = graph.connectors[step.connector];
      const target = c.url + (step.path ? (await resolve({ v: step.path })).v : '');
      return { delivery: await store.enqueue({ kind: 'http', connector: step.connector, target, payload: await resolve(step.body) }) };
    },
  },
  'connector.send': {
    summary: 'queue a JSON "body" to any "connector"; the connector\'s kind picks the transport (a plugin transport needs no block of its own)',
    effects: ['out'], requires: ['connector', 'body'],
    run: async ({ store, graph, step, resolve }) => {
      const c = graph.connectors[step.connector];
      return { delivery: await store.enqueue({ kind: c.kind, connector: step.connector, target: String(c.url || c.file || c.to || step.connector), payload: await resolve(step.body) }) };
    },
  },
  'connector.call': {
    summary: 'call an operation "op" of a descriptor "connector" with "input" (an object, checked against the operation\'s schema before anything is queued; "ref" names the row the call is about); delivered after commit, visible in /outbox as @delivery',
    effects: ['out'], requires: ['connector', 'op', 'input'],
    check: checkCall,
    run: async ({ store, graph, registry, step, resolve }) => {
      const c = graph.connectors[step.connector];
      const d = registry.descriptors[c.kind];
      if (!d) throw new Error(`connector.call: "${step.connector}" is ${c.kind}, which has no descriptor`);
      const { input, target } = prepare(d, c, step.op, await resolve(step.input));
      return { delivery: await store.enqueue({ kind: c.kind, connector: step.connector, target, payload: input, op: step.op }) };
    },
  },
  'mail.send': {
    summary: 'queue a letter through the mail "connector": "to" (an address or "@row.email"), "subject", "text" with {row.field} placeholders',
    effects: ['mail.out'], requires: ['connector', 'to', 'subject'], connector: 'mail',
    run: async ({ store, graph, step, resolve, text }) => {
      const c = graph.connectors[step.connector];
      const to = (await resolve({ v: step.to })).v;
      const payload = { from: c.from || null, to, subject: await text(step.subject), text: await text(step.text || '') };
      return { delivery: await store.enqueue({ kind: 'mail', connector: step.connector, target: String(to ?? ''), payload }) };
    },
  },
};

export const search = (query, catalog = CATALOG) => {
  const q = query.toLowerCase();
  return Object.entries(catalog)
    .filter(([name, b]) => name.includes(q) || b.summary.toLowerCase().includes(q))
    .map(([name, b]) => `${name}(${b.requires.join(', ')}) — ${b.summary} [${b.effects.join(',')}]`);
};
