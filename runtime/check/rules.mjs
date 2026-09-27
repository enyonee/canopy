// `/rules`: checks (an expression) and uniqueness, per entity, run on create and edit.
export const NODES = ['rules'];

export function check(graph, h) {
  const { err, checkEntity, checkField, fieldScope, checkExpression } = h;
  for (const [entity, list] of Object.entries(graph.rules || {})) {
    const p = `/rules/${entity}`;
    if (!checkEntity(entity, p)) continue;
    if (!Array.isArray(list)) { err(p, 'rules must be an array', '[{"check": "qty > 0", "message": "…"}, {"unique": "email"}]'); continue; }
    list.forEach((r, i) => {
      const rp = `${p}/${i}`;
      if (r.unique !== undefined) return checkField(entity, r.unique, `${rp}/unique`, { stored: true });
      if (r.check === undefined) return err(rp, 'a rule is {"check": <expression>, "message": …} or {"unique": <field>}');
      const kind = checkExpression(r.check, fieldScope(entity), `${rp}/check`);
      if (kind && kind !== 'bool' && kind !== 'any') err(`${rp}/check`, `a check must be a condition; this expression is ${kind}`);
      if (!r.message) err(`${rp}/message`, 'a check needs a "message" the user sees when it fails');
    });
  }
}
