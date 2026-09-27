// `/dashboards`: cards and grouped tables at /dashboard/<id>.
const FNS = ['count', 'sum', 'avg', 'min', 'max'];
const UNITS = ['day', 'month', 'year'];

export const NODES = ['dashboards'];

export function check(graph, h) {
  const { err, checkEntity, checkField, checkWhere, checkRoles, fields } = h;
  (graph.dashboards || []).forEach((d, i) => {
    const p = `/dashboards/${i}`;
    if (!d.id) err(`${p}/id`, 'dashboard needs an id (it becomes /dashboard/<id>)');
    checkRoles(d, p);
    for (const [e, f] of Object.entries(d.period || {})) {
      if (!checkEntity(e, `${p}/period/${e}`)) continue;
      if (checkField(e, f, `${p}/period/${e}`) && !fields[e][f].type.temporal)
        err(`${p}/period/${e}`, `period field "${f}" must be a date or time; it is ${fields[e][f].kind}`);
    }
    (d.cards || []).forEach((c, j) => {
      const cp = `${p}/cards/${j}`;
      if (!checkEntity(c.entity, `${cp}/entity`)) return;
      if (c.fn && !FNS.includes(c.fn)) err(`${cp}/fn`, `unknown function "${c.fn}"`, `known: ${FNS.join(', ')}`);
      if (c.fn && c.fn !== 'count' && !c.field) err(`${cp}/field`, `"${c.fn}" needs a field`);
      if (c.field) checkField(c.entity, c.field, `${cp}/field`);
      checkWhere(c.entity, c.where, `${cp}/where`);
    });
    (d.tables || []).forEach((t, j) => {
      const tp = `${p}/tables/${j}`;
      if (!checkEntity(t.entity, `${tp}/entity`)) return;
      if (t.groupBy) checkField(t.entity, t.groupBy, `${tp}/groupBy`);
      if (t.groupUnit) {
        if (!UNITS.includes(t.groupUnit)) err(`${tp}/groupUnit`, `unknown unit "${t.groupUnit}"`, `units: ${UNITS.join(', ')}`);
        const g = t.groupBy && fields[t.entity]?.[t.groupBy];
        if (g && !g.type.temporal) err(`${tp}/groupUnit`, `groupUnit needs a date or time groupBy; "${t.groupBy}" is ${g.kind}`);
      }
      checkWhere(t.entity, t.where, `${tp}/where`);
      (t.metrics ?? []).forEach((m, k) => {
        if (!m.as) err(`${tp}/metrics/${k}/as`, 'metric needs a name in "as"');
        if (!FNS.includes(m.fn)) err(`${tp}/metrics/${k}/fn`, `unknown function "${m.fn}"`, `known: ${FNS.join(', ')}`);
        if (m.fn !== 'count') checkField(t.entity, m.field, `${tp}/metrics/${k}/field`);
      });
      if (t.sort && !(t.metrics ?? []).some((m) => m.as === t.sort.field) && t.sort.field !== 'grp')
        err(`${tp}/sort/field`, `sort must name a metric or "grp"`,
          `metrics here: ${(t.metrics || []).map((m) => m.as).join(', ')}`);
    });
  });
}
