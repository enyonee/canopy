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
};

export const search = (query) => {
  const q = query.toLowerCase();
  return Object.entries(CATALOG)
    .filter(([name, b]) => name.includes(q) || b.summary.toLowerCase().includes(q))
    .map(([name, b]) => `${name}(${(b.requires || []).join(', ')}) — ${b.summary} [${b.effects.join(',')}]`);
};
