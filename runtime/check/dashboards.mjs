// `/dashboards`: cards, grouped tables and charts at /dashboard/<id>.
const FNS = ['count', 'sum', 'avg', 'min', 'max'];
const UNITS = ['day', 'month', 'year'];
const CHART_TYPES = ['bar', 'line', 'pie'];

export const NODES = ['dashboards'];

// One metric, one grouping, one chart — the same shape a table's single
// metric would have, checked the same way (unknown fn, groupUnit needs a
// temporal groupBy, a where clause like any other).
function checkCharts(d, p, h) {
  const { err, checkEntity, checkField, checkWhere, fields } = h;
  (d.charts || []).forEach((c, j) => {
    const cp = `${p}/charts/${j}`;
    if (!c.title) err(`${cp}/title`, 'chart needs a title');
    if (!checkEntity(c.entity, `${cp}/entity`)) return;
    if (!CHART_TYPES.includes(c.type)) err(`${cp}/type`, `unknown chart type "${c.type}"`, `types: ${CHART_TYPES.join(', ')}`);
    if (!c.groupBy) err(`${cp}/groupBy`, 'chart needs "groupBy"');
    else checkField(c.entity, c.groupBy, `${cp}/groupBy`);
    if (c.groupUnit) {
      if (!UNITS.includes(c.groupUnit)) err(`${cp}/groupUnit`, `unknown unit "${c.groupUnit}"`, `units: ${UNITS.join(', ')}`);
      const g = c.groupBy && fields[c.entity]?.[c.groupBy];
      if (g && !g.type.temporal) err(`${cp}/groupUnit`, `groupUnit needs a date or time groupBy; "${c.groupBy}" is ${g.kind}`);
    }
    if (!c.metric || !FNS.includes(c.metric.fn)) err(`${cp}/metric/fn`, `unknown function "${c.metric?.fn}"`, `known: ${FNS.join(', ')}`);
    else if (c.metric.fn !== 'count' && !c.metric.field) err(`${cp}/metric/field`, `"${c.metric.fn}" needs a field`);
    if (c.metric?.field) checkField(c.entity, c.metric.field, `${cp}/metric/field`);
    checkWhere(c.entity, c.where, `${cp}/where`);
    if (c.limit !== undefined && !(Number.isInteger(c.limit) && c.limit > 0)) err(`${cp}/limit`, 'limit must be a positive integer');
    if (c.sort && !['grp', 'v'].includes(c.sort.field)) err(`${cp}/sort/field`, 'sort must name "grp" or "v" (the chart\'s only metric)');
  });
}

export function check(graph, h) {
  const { err, checkEntity, checkField, checkWhere, checkRoles, fields } = h;
  (graph.dashboards || []).forEach((d, i) => {
    const p = `/dashboards/${i}`;
    if (!d.id) err(`${p}/id`, 'dashboard needs an id (it becomes /dashboard/<id>)');
    checkRoles(d, p);
    if (d.refresh !== undefined && !(Number.isInteger(d.refresh) && d.refresh > 0))
      err(`${p}/refresh`, 'refresh must be a positive integer number of seconds');
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
    checkCharts(d, p, h);
  });
}
