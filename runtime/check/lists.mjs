// `/lists`: named saved lists at /list/<id>.
export const NODES = ['lists'];

export function check(graph, h) {
  const { err, checkEntity, checkField, checkWhere, checkRoles } = h;
  (graph.lists || []).forEach((l, i) => {
    const p = `/lists/${i}`;
    if (!l.id) err(`${p}/id`, 'list needs an id (it becomes /list/<id>)');
    checkRoles(l, p);
    if (!checkEntity(l.entity, `${p}/entity`)) return;
    (l.columns || []).forEach((c) => c === 'id' || checkField(l.entity, c, `${p}/columns`, { secret: true }));
    checkWhere(l.entity, l.where, `${p}/where`);
    if (l.sort) checkField(l.entity, l.sort.field, `${p}/sort/field`);
  });
}
