// `/states`: status transitions per entity, guarded by status and role.
export const NODES = ['states'];

export function check(graph, h) {
  const { err, checkEntity, checkField, checkSteps, fields, roles, roleNames } = h;
  for (const [entity, st] of Object.entries(graph.states || {})) {
    const p = `/states/${entity}`;
    if (!checkEntity(entity, p)) continue;
    if (!st.field) { err(`${p}/field`, 'states need "field": the enum field that holds the status'); continue; }
    if (!checkField(entity, st.field, `${p}/field`)) continue;
    const f = fields[entity][st.field];
    if (f.kind !== 'enum') { err(`${p}/field`, `"${st.field}" is ${f.kind}; a status field must be an enum with a default`); continue; }
    if (f.def === null) { err(`${p}/field`, `"${st.field}" needs a default: it is the initial status`, `e.g. "enum[${f.options.join(',')}]=${f.options[0]}"`); continue; }
    const names = new Set();
    const reach = new Set([f.def]);
    (st.transitions || []).forEach((t, i) => {
      const tp = `${p}/transitions/${i}`;
      if (!t.name) err(`${tp}/name`, 'transition needs a name (it becomes the button and the go:<name> operation)');
      else if (names.has(t.name)) err(`${tp}/name`, `transition "${t.name}" is declared twice`);
      names.add(t.name);
      if (!f.options.includes(t.to)) err(`${tp}/to`, `"${t.to}" is not a status of ${entity}`, `statuses: ${f.options.join(', ')}`);
      const from = t.from === undefined || t.from === '*' ? f.options : Array.isArray(t.from) ? t.from : [t.from];
      from.forEach((s, k) => { if (!f.options.includes(s)) err(`${tp}/from/${k}`, `"${s}" is not a status of ${entity}`, `statuses: ${f.options.join(', ')}`); });
      if (t.by !== undefined) {
        if (!roles) err(`${tp}/by`, 'no /roles declared, so "by" cannot restrict who may transition');
        else (t.by || []).forEach((r, k) => { if (!roleNames.includes(r)) err(`${tp}/by/${k}`, `"${r}" is not a role`, `roles: ${roleNames.join(', ')}`); });
      }
      (t.fields || []).forEach((x) => checkField(entity, x, `${tp}/fields`, { stored: true }));
      checkSteps(t.do, `${tp}/do`, entity);
    });
    // Every status must be reachable from the initial one, or it is dead weight in the enum.
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of st.transitions || []) {
        const from = t.from === undefined || t.from === '*' ? f.options : Array.isArray(t.from) ? t.from : [t.from];
        if (from.some((s) => reach.has(s)) && !reach.has(t.to)) { reach.add(t.to); grew = true; }
      }
    }
    const dead = f.options.filter((o) => !reach.has(o));
    if (dead.length) err(`${p}/transitions`, `no transition leads to: ${dead.join(', ')}`, `add a transition "to" each, or drop it from ${entity}.${st.field}`);
  }
}
