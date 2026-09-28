// `/rules`: checks (an expression) and uniqueness (single field or a compound
// list — "unique together"), per entity, run on create and edit.
export const NODES = ['rules'];

export function check(graph, h) {
  const { err, checkEntity, checkField, fieldScope, checkExpression } = h;
  for (const [entity, list] of Object.entries(graph.rules || {})) {
    const p = `/rules/${entity}`;
    if (!checkEntity(entity, p)) continue;
    if (!Array.isArray(list)) { err(p, 'rules must be an array', '[{"check": "qty > 0", "message": "…"}, {"unique": "email"}]'); continue; }
    list.forEach((r, i) => {
      const rp = `${p}/${i}`;
      if (r.unique !== undefined) {
        const names = Array.isArray(r.unique) ? r.unique : [r.unique];
        if (!names.length) return err(`${rp}/unique`, '"unique" needs at least one field');
        return names.forEach((f, j) => checkField(entity, f, `${rp}/unique${Array.isArray(r.unique) ? `/${j}` : ''}`, { stored: true }));
      }
      if (r.check === undefined) return err(rp, 'a rule is {"check": <expression>, "message": …} or {"unique": <field>|[<fields>]}');
      const kind = checkExpression(r.check, fieldScope(entity), `${rp}/check`);
      if (kind && kind !== 'bool' && kind !== 'any') err(`${rp}/check`, `a check must be a condition; this expression is ${kind}`);
      if (!r.message) err(`${rp}/message`, 'a check needs a "message" the user sees when it fails');
    });
  }
}
