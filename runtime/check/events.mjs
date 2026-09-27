// `/events`: steps that run on Entity.created / .updated / .deleted.
const TRIGGERS = ['created', 'updated', 'deleted'];

export const NODES = ['events'];

export function check(graph, h) {
  const { err, checkEntity, checkSteps, entities } = h;
  (graph.events || []).forEach((ev, i) => {
    const p = `/events/${i}`;
    const m = /^(\w+)\.(\w+)$/.exec(ev.on || '');
    if (!m || !TRIGGERS.includes(m[2])) err(`${p}/on`, `unsupported trigger "${ev.on}"`, `triggers: <Entity>.${TRIGGERS.join(', <Entity>.')}`);
    else checkEntity(m[1], `${p}/on`);
    checkSteps(ev.do, `${p}/do`, m && entities.includes(m[1]) ? m[1] : null);
  });
}
