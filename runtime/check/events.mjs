// `/events`: steps that run on Entity.created / .updated / .deleted, on
// <roles.entity>.login (row = the user who just signed in), or on
// <Entity>.viewed (row = the row a GET detail just read — a write on read,
// still inside a transaction; see docs/FORMAT.md's «Events»).
const TRIGGERS = ['created', 'updated', 'deleted', 'login', 'viewed'];

export const NODES = ['events'];

export function check(graph, h) {
  const { err, checkEntity, checkSteps, entities } = h;
  (graph.events || []).forEach((ev, i) => {
    const p = `/events/${i}`;
    const m = /^(\w+)\.(\w+)$/.exec(ev.on || '');
    if (!m || !TRIGGERS.includes(m[2])) { err(`${p}/on`, `unsupported trigger "${ev.on}"`, `triggers: <Entity>.${TRIGGERS.join(', <Entity>.')}`); return; }
    const known = checkEntity(m[1], `${p}/on`);
    if (known && m[2] === 'login' && m[1] !== graph.roles?.entity)
      err(`${p}/on`, `"login" fires on the roles entity; ${m[1]} is not it`, graph.roles ? `use "${graph.roles.entity}.login"` : 'declare /roles first');
    checkSteps(ev.do, `${p}/do`, known ? m[1] : null);
  });
}
