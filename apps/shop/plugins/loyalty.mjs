// A plugin: classic code next to the application, declared in app.json under
// "plugins". It registers with the same contracts the built-ins use, so the
// checker, the store, the renderer and the interpreter treat it as their own.
// The graph stays closed: it can only name what this file declares.
//
//   field kind  percent          0–100, rendered "15 %", range-filterable
//   function    discount(a, pct) money after a percentage off
//   block       loyalty.award    adds floor(amount) points to a user row
export default {
  async: true, // its blocks await store.*, resolve and text (docs/FORMAT.md "Plugins")
  fields: {
    percent: {
      sql: 'INTEGER', exprKind: 'number', numeric: true, derivable: true,
      def: (f) => Number(f.def),
      coerce: (raw) => (raw === '' || raw === undefined || raw === null ? null : Math.round(Number(raw))),
      validate: (v, f) => (v !== undefined && v !== '' && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100) ? `${f.name} must be between 0 and 100` : null),
      fromExpr: (v) => (v === null || v === undefined ? null : Math.round(v)),
      format: (v, f, { esc }) => (v === null || v === undefined ? '' : esc(`${v} %`)),
      input: (f, v, { esc }) => `<input type="number" min="0" max="100" id="f_${f.name}" name="${f.name}" value="${esc(v)}"${f.required ? ' required' : ''}>`,
    },
  },
  functions: {
    discount: {
      arity: 2,
      kind: (ks) => { if (ks[0] !== 'money' && ks[0] !== 'any') throw new Error(`discount() needs money first, got ${ks[0]}`); return 'money'; },
      run: ([amount, pct]) => (amount == null ? null : Math.round(amount * (100 - (pct || 0))) / 100),
    },
  },
  blocks: {
    'loyalty.award': {
      summary: 'add floor("amount") points to "field" of the user row "id" ("@row.customer")',
      effects: ['db.write'], requires: ['entity', 'id', 'field', 'amount'],
      check: (step, h) => {
        const f = h.fields[step.entity]?.[step.field];
        if (f && !f.type.numeric) h.err(`${h.path}/field`, `loyalty.award needs a numeric field; ${step.entity}.${step.field} is ${f.kind}`);
      },
      run: async ({ store, step, resolve }) => {
        const id = (await resolve({ v: step.id })).v;
        const row = await store.get(step.entity, id);
        if (!row) throw new Error(`loyalty.award: no ${step.entity} #${id}`);
        const points = Math.floor(Number((await resolve({ v: step.amount })).v) || 0);
        await store.update(step.entity, id, { [step.field]: (row[step.field] || 0) + points });
        return { points };
      },
    },
  },
};
