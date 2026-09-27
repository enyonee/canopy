// `/actions`: named step sequences, on a row (`in`) or global.
export const NODES = ['actions'];

export function check(graph, h) {
  const { err, checkEntity, checkSteps } = h;
  (graph.actions || []).forEach((a, i) => {
    if (!a.name) err(`/actions/${i}/name`, 'action needs a name');
    if (a.in !== undefined && a.in !== null) checkEntity(a.in, `/actions/${i}/in`);
    if (!Array.isArray(a.do) || !a.do.length) err(`/actions/${i}/do`, 'action needs at least one step');
    checkSteps(a.do, `/actions/${i}/do`, a.in);
  });
}
