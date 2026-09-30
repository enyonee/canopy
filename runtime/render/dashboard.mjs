// The dashboard view: metric cards, grouped tables and charts, all narrowable
// by a from/to period form when the dashboard declares one.
import { formatMoney } from '../spec.mjs';
import { esc, label, anyone, noPre, page } from '../render.mjs';

const metricValue = (store, entity, fieldName, v) => {
  if (v === null || v === undefined) return '—';
  const f = fieldName ? store.field(entity, fieldName) : null;
  if (f?.kind === 'money') return formatMoney(Math.round(v));
  return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v;
};

// One row's category label, the same rules a dashboard table already uses for
// its "grp" column (a ref renders its label, an enum its title-case name, a
// bool Yes/No).
function groupLabel(groupField, g, pre) {
  if (groupField?.kind === 'ref') return pre.label(groupField.target, g) || '—';
  if (groupField?.kind === 'enum') return g === null ? '—' : label(g);
  if (groupField?.kind === 'bool') return g ? 'Yes' : 'No';
  return String(g ?? '—');
}

// The rows a chart draws, loaded by the route with the same store.aggregate() a table
// uses — one metric named "v" — with each row's category labelled here
// and its value display-formatted (money, decimals), so the SVG and
// the accessible data table below it read the same numbers.
function chartRows(store, chart, rows, pre) {
  const groupField = chart.groupBy ? store.field(chart.entity, chart.groupBy) : null;
  return rows.map((r) => ({ label: groupLabel(groupField, r.grp, pre), v: r.v,
    display: metricValue(store, chart.entity, chart.metric.fn === 'count' ? null : chart.metric.field, r.v) }));
}

const CHART_W = 480, CHART_H = 220, PAD = 32;
// No design system hands this template a categorical palette — only one
// theme accent — so every mark is the accent at a lightness step and is
// always paired with a direct text label (never color-alone identity); the
// `<table class="chart-data">` right after each chart is the required table
// view, standing in for the hover/tooltip layer this no-client-JS scaffold
// cannot ship.
const shade = (i) => (1 - (i % 5) * 0.15).toFixed(2);

function barsAndLine(chart, data, accent, maxDisplay) {
  const max = Math.max(1, ...data.map((d) => d.v ?? 0));
  const n = Math.max(1, data.length);
  const plotW = CHART_W - PAD * 2, plotH = CHART_H - PAD * 2;
  const slot = plotW / n;
  const xAt = (i) => PAD + slot * i + slot / 2;
  const yAt = (v) => PAD + plotH - (Math.max(0, v ?? 0) / max) * plotH;
  const marks = chart.type === 'line'
    ? `<polyline fill="none" stroke="${esc(accent)}" stroke-width="2" points="${data.map((d, i) => `${xAt(i).toFixed(1)},${yAt(d.v).toFixed(1)}`).join(' ')}"/>` +
      data.map((d, i) => `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(d.v).toFixed(1)}" r="4" fill="${esc(accent)}"><title>${esc(d.label)}: ${esc(d.display)}</title></circle>`).join('')
    : data.map((d, i) => { const h = plotH - (yAt(d.v) - PAD); const w = Math.max(4, slot - 8);
        return `<rect x="${(xAt(i) - w / 2).toFixed(1)}" y="${yAt(d.v).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${esc(accent)}" fill-opacity="${shade(i)}"><title>${esc(d.label)}: ${esc(d.display)}</title></rect>`; }).join('');
  const axis = data.map((d, i) => `<text x="${xAt(i).toFixed(1)}" y="${CHART_H - 6}" font-size="10" text-anchor="middle">${esc(d.label)}</text>`).join('') +
    `<text x="4" y="${(PAD - 2).toFixed(1)}" font-size="10">${esc(maxDisplay)}</text><text x="4" y="${CHART_H - PAD + 12}" font-size="10">0</text>`;
  return marks + axis;
}

function pieSlices(data, accent) {
  const total = data.reduce((a, d) => a + Math.max(0, d.v ?? 0), 0) || 1;
  const cx = CHART_W / 2, cy = CHART_H / 2, r = Math.min(cx, cy) - PAD / 2;
  let angle = -Math.PI / 2;
  return data.map((d, i) => {
    const frac = Math.max(0, d.v ?? 0) / total;
    const next = angle + frac * 2 * Math.PI;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(next), y2 = cy + r * Math.sin(next);
    const path = `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`;
    angle = next;
    return `<path d="${path}" fill="${esc(accent)}" fill-opacity="${shade(i)}"><title>${esc(d.label)}: ${esc(d.display)}</title></path>`;
  }).join('');
}

function chartTable(chart, data) {
  return `<table class="chart-data"><caption>${esc(chart.title)}</caption>
    <thead><tr><th>${esc(label(chart.groupBy))}</th><th>Value</th></tr></thead>
    <tbody>${data.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(d.display)}</td></tr>`).join('')}</tbody></table>`;
}

// `<svg role="img" aria-label=…>` + `<title>`, bars/points/slices in the theme
// accent, axis labels — followed by the same numbers as a data table, so
// checks and screen readers read values without decoding the SVG.
export function chartBlock(store, chart, accent, rows, pre) {
  const data = chartRows(store, chart, rows, pre);
  const max = Math.max(1, ...data.map((d) => d.v ?? 0));
  const maxDisplay = metricValue(store, chart.entity, chart.metric.fn === 'count' ? null : chart.metric.field, max);
  const body = chart.type === 'pie' ? pieSlices(data, accent) : barsAndLine(chart, data, accent, maxDisplay);
  return `<h3>${esc(chart.title)}</h3>
    <svg role="img" aria-label="${esc(chart.title)}" viewBox="0 0 ${CHART_W} ${CHART_H}" width="${CHART_W}" height="${CHART_H}">
      <title>${esc(chart.title)}</title>${body}</svg>
    ${chartTable(chart, data)}`;
}

export function dashboardView(graph, store, dash, flash, vc = anyone, period = {}, pre = noPre) {
  const data = pre.dash;
  if (!data) throw new Error(`not loaded: dashboard ${dash.id}`);
  const periodForm = dash.period ? `<form class="card" method="get" action="/dashboard/${dash.id}"><div class="range">
      <div><label for="from">From</label><input type="date" id="from" name="from" value="${esc(period.from || '')}"></div>
      <div><label for="to">To</label><input type="date" id="to" name="to" value="${esc(period.to || '')}"></div>
      <div><button type="submit">Apply</button> <a class="btn" href="/dashboard/${dash.id}">All time</a></div></div></form>` : '';
  const cards = (dash.cards || []).map((c, i) => {
    const v = data.cards[i] ?? 0;
    return `<div class="metric"><b>${esc(metricValue(store, c.entity, c.fn === 'count' || !c.fn ? null : c.field, v))}</b>${esc(c.title)}</div>`;
  }).join('');
  const tables = (dash.tables || []).map((t, i) => {
    const groupField = t.groupBy ? store.field(t.entity, t.groupBy) : null;
    const head = (t.groupBy ? `<th>${esc(t.groupTitle || label(t.groupBy))}</th>` : '') +
      (t.metrics || []).map((m) => `<th>${esc(m.title ?? label(m.as))}</th>`).join('');
    const body = data.tables[i].map((r) => {
      let g = r.grp;
      if (groupField?.kind === 'ref') g = pre.label(groupField.target, g) || null;
      if (groupField?.kind === 'enum') g = g === null ? null : label(g);
      if (groupField?.kind === 'bool') g = g ? 'Yes' : 'No';
      return `<tr>${t.groupBy ? `<td>${esc(g ?? '—')}</td>` : ''}${
        (t.metrics ?? []).map((m) => `<td>${esc(metricValue(store, t.entity, m.fn === 'count' ? null : m.field, r[m.as]))}</td>`).join('')}</tr>`;
    }).join('');
    return `<h3>${esc(t.title)}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }).join('');
  const accent = graph.theme?.accent || 'navy';
  const charts = (dash.charts || []).map((c, i) => chartBlock(store, c, accent, data.charts[i], pre)).join('');
  return page(graph, {
    title: dash.title, flash, vc, refresh: dash.refresh,
    body: `<h2>${esc(dash.title)}</h2>${dash.intro ? `<p>${esc(dash.intro)}</p>` : ''}${periodForm}
      <div class="metrics">${cards}</div>${tables}${charts}`,
  });
}
