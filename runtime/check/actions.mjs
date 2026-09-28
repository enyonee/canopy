// `/actions`: named step sequences, on a row (`in`) or global.
export const NODES = ['actions'];

// Item 19: an action may declare "fields" like a transition does — real, stored
// fields of `in` for a row action (typed, rendered and required exactly like a
// transition's own `fields`); a global action has no entity to check them
// against, so its fields are free-form named inputs (plain text, still required).
function checkActionFields(entity, a, path, h) {
  const { err, checkField } = h;
  if (!Array.isArray(a.fields)) return err(path, '"fields" must be an array of field names');
  a.fields.forEach((f, k) => {
    if (entity) checkField(entity, f, `${path}/${k}`, { stored: true });
    else if (typeof f !== 'string' || !f) err(`${path}/${k}`, 'a global action\'s field needs a name');
  });
}

export function check(graph, h) {
  const { err, checkEntity, checkSteps } = h;
  (graph.actions || []).forEach((a, i) => {
    const p = `/actions/${i}`;
    if (!a.name) err(`${p}/name`, 'action needs a name');
    if (a.in !== undefined && a.in !== null) checkEntity(a.in, `${p}/in`);
    if (!Array.isArray(a.do) || !a.do.length) err(`${p}/do`, 'action needs at least one step');
    if (a.fields !== undefined) checkActionFields(a.in, a, `${p}/fields`, h);
    checkSteps(a.do, `${p}/do`, a.in);
  });
}
