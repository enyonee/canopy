// The dashboard view: metric cards and grouped tables, both narrowable by a
// from/to period form when the dashboard declares one.
import { formatMoney } from '../spec.mjs';
import { esc, label, anyone, page } from '../render.mjs';

const metricValue = (store, entity, fieldName, v) => {
  if (v === null || v === undefined) return '—';
  const f = fieldName ? store.field(entity, fieldName) : null;
  if (f?.kind === 'money') return formatMoney(Math.round(v));
  return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v;
};

export function dashboardView(graph, store, dash, flash, vc = anyone, period = {}) {
  const inPeriod = (entity, where = {}) => {
    const f = dash.period?.[entity];
    if (!f || (!period.from && !period.to)) return where;
    const kind = store.field(entity, f).kind;
    const range = {};
    if (period.from) range.gte = kind === 'time' ? `${period.from}T00:00:00` : period.from;
    if (period.to) range.lte = kind === 'time' ? `${period.to}T23:59:59.999Z` : period.to;
    return { ...where, [f]: range };
  };
  const periodForm = dash.period ? `<form class="card" method="get" action="/dashboard/${dash.id}"><div class="range">
      <div><label for="from">From</label><input type="date" id="from" name="from" value="${esc(period.from || '')}"></div>
      <div><label for="to">To</label><input type="date" id="to" name="to" value="${esc(period.to || '')}"></div>
      <div><button type="submit">Apply</button> <a class="btn" href="/dashboard/${dash.id}">All time</a></div></div></form>` : '';
  const cards = (dash.cards || []).map((c) => {
    const [row] = store.aggregate(c.entity, { metrics: [{ fn: c.fn || 'count', field: c.field, as: 'v' }], where: inPeriod(c.entity, c.where || {}) });
    const v = row?.v ?? 0;
    return `<div class="metric"><b>${esc(metricValue(store, c.entity, c.fn === 'count' || !c.fn ? null : c.field, v))}</b>${esc(c.title)}</div>`;
  }).join('');
  const tables = (dash.tables || []).map((t) => {
    const rows = store.aggregate(t.entity, { ...t, where: inPeriod(t.entity, t.where || {}) });
    const groupField = t.groupBy ? store.field(t.entity, t.groupBy) : null;
    const head = (t.groupBy ? `<th>${esc(t.groupTitle || label(t.groupBy))}</th>` : '') +
      (t.metrics || []).map((m) => `<th>${esc(m.title ?? label(m.as))}</th>`).join('');
    const body = rows.map((r) => {
      let g = r.grp;
      if (groupField?.kind === 'ref') g = store.label(groupField.target, store.get(groupField.target, g)) || null;
      if (groupField?.kind === 'enum') g = g === null ? null : label(g);
      if (groupField?.kind === 'bool') g = g ? 'Yes' : 'No';
      return `<tr>${t.groupBy ? `<td>${esc(g ?? '—')}</td>` : ''}${
        (t.metrics ?? []).map((m) => `<td>${esc(metricValue(store, t.entity, m.fn === 'count' ? null : m.field, r[m.as]))}</td>`).join('')}</tr>`;
    }).join('');
    return `<h3>${esc(t.title)}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }).join('');
  return page(graph, {
    title: dash.title, flash, vc,
    body: `<h2>${esc(dash.title)}</h2>${dash.intro ? `<p>${esc(dash.intro)}</p>` : ''}${periodForm}
      <div class="metrics">${cards}</div>${tables}`,
  });
}
