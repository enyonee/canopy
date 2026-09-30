// A plugin block that writes through the store directly — no interp help,
// no validateValues, nothing but store.insert — used to prove a plugin
// cannot skip the rule guard: it lives inside Store#insert itself
// (runtime/store/rules.mjs), not in the interpreter, so there is no path
// around it. See tests/interp.test.mjs.
export default {
  blocks: {
    'raw.insert': {
      summary: 'insert a row of "entity" straight from "values" — the store, nothing else',
      effects: ['db.write'], requires: ['entity', 'values'],
      run: async ({ store, step, resolve }) => ({ id: await store.insert(step.entity, await resolve(step.values)) }),
    },
  },
};
