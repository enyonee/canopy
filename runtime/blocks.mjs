// The catalog. A block declares its effects and requirements; the graph never
// reaches past this list. Adding a block here is the only way the language grows.
export const CATALOG = {
  'db.create': {
    summary: 'create a row of the action entity from submitted values',
    effects: ['db.write'], requires: [],
    run: ({ store, entity, values }) => ({ id: store.insert(entity, values) }),
  },
  'db.update': {
    summary: 'update the current row with the given "set" values',
    effects: ['db.write'], requires: ['set'],
    run: ({ store, entity, id, step }) => { store.update(entity, id, step.set); return {}; },
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
      const hit = rows.find((_, i) => (n -= weights[i] || 1) <= 0) || rows[0];
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
};

export const search = (query) => {
  const q = query.toLowerCase();
  return Object.entries(CATALOG)
    .filter(([name, b]) => name.includes(q) || b.summary.toLowerCase().includes(q))
    .map(([name, b]) => `${name}(${(b.requires || []).join(', ')}) — ${b.summary} [${b.effects.join(',') || 'pure'}]`);
};
