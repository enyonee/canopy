// Home redirect, static /page/<id>, /dashboard/<id> (with its CSV export),
// /list/<id> and /search — every read that is not a declared entity's own
// routes (routes/entity.mjs) or a row action (routes/rows.mjs).
import { formatMoney } from '../spec.mjs';
import { errorPage, rowJSON } from '../render.mjs';
import { staticPage } from '../render/pages.mjs';
import { dashboardView } from '../render/dashboard.mjs';
import { listView } from '../render/list.mjs';
import { searchView } from '../render/search.mjs';
import { listPre, pagePre, searchPre, dashboardPre } from './load.mjs';

// The CSV of a dashboard: the aggregates and labels the route loaded (routes/load.mjs), one line per value.
function dashboardCsv(ctx, d, mine, pre) {
  const { store, sendCsv } = ctx;
  const lines = [];
  mine.cards.forEach((c, i) => {
    const v = pre.dash.cards[i];
    const f = c.field && store.field(c.entity, c.field);
    lines.push(['card', c.title, '', f?.kind === 'money' && c.fn !== 'count' ? formatMoney(Math.round(v ?? 0)) : (v ?? 0)]);
  });
  const group = (g, grp) => {
    if (g?.kind === 'ref') return pre.label(g.target, grp);
    return g?.kind === 'bool' ? (grp ? 'Yes' : 'No') : grp;
  };
  mine.tables.forEach((t, i) => {
    const g = t.groupBy ? store.field(t.entity, t.groupBy) : null;
    for (const r of pre.dash.tables[i]) {
      const grp = group(g, r.grp);
      for (const m of t.metrics || []) {
        const mf = m.field && store.field(t.entity, m.field);
        lines.push([t.title, m.title ?? m.as, grp ?? '', mf?.kind === 'money' && m.fn !== 'count' && r[m.as] != null ? formatMoney(Math.round(r[m.as])) : (r[m.as] ?? '')]);
      }
    }
  });
  (mine.charts || []).forEach((c, i) => {
    const g = c.groupBy ? store.field(c.entity, c.groupBy) : null;
    const mf = c.metric.field && store.field(c.entity, c.metric.field);
    for (const r of pre.dash.charts[i]) {
      lines.push([c.title, c.metric.fn, group(g, r.grp) ?? '', mf?.kind === 'money' && c.metric.fn !== 'count' && r.v != null ? formatMoney(Math.round(r.v)) : (r.v ?? '')]);
    }
  });
  return sendCsv(d.id, ['Section', 'Metric', 'Group', 'Value'], lines);
}

// A money aggregate, converted to the major-unit number every JSON row
// already promises (docs/FORMAT.md's «JSON answers»: money is `12.34`, never
// `1234`) — `count` names no field and is never money. Rounded first, like
// the HTML (`metricValue()` in render/dashboard.mjs) and CSV paths above,
// because `avg` can land between minor units.
function moneyAggregate(store, entity, fieldName, fn, v) {
  if (v === null || v === undefined) return v;
  const f = fieldName && fn !== 'count' ? store.field(entity, fieldName) : null;
  return f?.kind === 'money' ? Number(formatMoney(Math.round(v))) : v;
}

// The same numbers dashboardView()/dashboardCsv() show, as JSON: one
// metric per card/chart, one row per group in a table/chart.
function dashboardJson(ctx, mine, pre) {
  const { store } = ctx;
  const cards = mine.cards.map((c, i) => ({ title: c.title, value: moneyAggregate(store, c.entity, c.field, c.fn || 'count', pre.dash.cards[i]) ?? 0 }));
  const tables = mine.tables.map((t, i) => ({ title: t.title, rows: pre.dash.tables[i]
    .map((r) => { const out = { ...r }; for (const m of t.metrics || []) out[m.as] = moneyAggregate(store, t.entity, m.field, m.fn, r[m.as]); return out; }) }));
  const charts = (mine.charts || []).map((c, i) => ({ title: c.title, type: c.type,
    rows: pre.dash.charts[i].map((r) => ({ ...r, v: moneyAggregate(store, c.entity, c.metric.field, c.metric.fn, r.v) })) }));
  ctx.sendJson(200, { cards, tables, charts });
}

function home(ctx) {
  const { graph, vc, flash, redirect, deny } = ctx;
  const keep = (to) => (flash ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(flash)}` : to);
  const p = (graph.pages || []).find((x) => vc.canSee(x));
  const e = Object.keys(graph.data).find((x) => vc.can(x, 'view') && !graph.override?.[`${x}.list`]?.hidden);
  const d = (graph.dashboards || []).find((x) => vc.canSee(x));
  if (graph.home) redirect(keep(graph.home));
  else if (p) redirect(keep(`/page/${p.id}`));
  else if (e) redirect(keep(`/${e}`));
  else if (d) redirect(keep(`/dashboard/${d.id}`));
  else deny('Nothing here for your role.');
  return true;
}

function page(ctx) {
  const { graph, store, parts, send, flash, vc } = ctx;
  const p = (graph.pages || []).find((x) => x.id === parts[1]);
  if (!p) { send(404, errorPage(graph, `no page ${parts[1]}`)); return true; }
  if (!vc.canSee(p)) { ctx.deny(); return true; }
  send(200, staticPage(graph, p, flash, vc, store, pagePre(ctx, p)));
  return true;
}

function dashboard(ctx) {
  const { graph, store, parts, flash, vc, url, trace, wantsCsv, resolveTop, ownWhere } = ctx;
  const d = (graph.dashboards || []).find((x) => x.id === parts[1]);
  if (!d) { ctx.answer(404, errorPage(graph, `no dashboard ${parts[1]}`), { ok: false, status: 404, errors: [`no dashboard ${parts[1]}`] }); return true; }
  if (!vc.canSee(d)) { ctx.deny(); return true; }
  const period = { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' };
  trace({ kind: 'dashboard', id: d.id, period });
  // A card is a read like any other: an own-scoped role counts its own rows, and a
  // card over an entity the role may not view is not on its dashboard at all.
  const scoped = (x) => ({ ...x, where: { ...resolveTop(x.where || {}), ...ownWhere(x.entity) } });
  const mine = { ...d, cards: (d.cards || []).map(scoped), tables: (d.tables || []).map(scoped), charts: (d.charts || []).map(scoped) };
  const pre = dashboardPre(ctx, d, mine, period);
  if (wantsCsv) { dashboardCsv(ctx, d, mine, pre); return true; }
  if (ctx.wantsJSON) { dashboardJson(ctx, mine, pre); return true; }
  ctx.send(200, dashboardView(graph, store, mine, flash, vc, period, pre));
  return true;
}

function list(ctx) {
  const { graph, store, parts, flash, vc, url, wantsCsv, resolveTop, ownWhere, sortOf, paged, exportRows } = ctx;
  const l = (graph.lists || []).find((x) => x.id === parts[1]);
  if (!l) { ctx.answer(404, errorPage(graph, `no list ${parts[1]}`), { ok: false, status: 404, errors: [`no list ${parts[1]}`] }); return true; }
  if (!vc.canSee(l) || !vc.can(l.entity, 'view')) { ctx.deny(); return true; }
  const where = { ...resolveTop(l.where || {}), ...ownWhere(l.entity) };
  const view = { ...(graph.override?.[`${l.entity}.list`] || {}), ...l, create: l.create ?? false };
  const sort = sortOf(l.entity, view);
  const opts = { where, sort, search: l.search || [], q: url.searchParams.get('q') || '' };
  const cols = view.columns || store.fields[l.entity].filter((f) => !f.type.secret).map((f) => f.name);
  if (wantsCsv) { exportRows(l.id, l.entity, store.list(l.entity, opts), cols, view.labels || {}); return true; }
  const pg = paged(l.entity, opts, view);
  if (ctx.wantsJSON) { ctx.sendJson(200, { rows: pg.rows.map((r) => rowJSON(store, l.entity, store.fields[l.entity], r, vc)), total: pg.total, page: pg.page, pages: pg.pages }); return true; }
  const g = { ...graph, override: { ...graph.override, [`${l.entity}.list`]: view } };
  const pre = listPre(ctx, l.entity, store.fields[l.entity], view, pg.rows);
  ctx.send(200, listView(g, store, l.entity, store.fields[l.entity], pg.rows, { q: url.searchParams.get('q') || '', where: {}, flash, vc, pre, path: `/list/${l.id}`,
    query: url.searchParams.toString(), sort: sort?.field, dir: sort?.dir, ...pg }));
  return true;
}

// One result section per /search entity (item 7): each entity's own
// Entity.list "search" fields, scoped by the viewer's own permissions —
// nothing is queried until a real "q" arrives.
function search(ctx) {
  const { graph, store, vc, url } = ctx;
  const q = url.searchParams.get('q') || '';
  const results = graph.search.entities.filter((e) => vc.can(e, 'view')).map((entity) => {
    const ov = graph.override?.[`${entity}.list`] || {};
    const rows = q && (ov.search || []).length ? store.list(entity, { search: ov.search, q, where: vc.ownWhere(entity) }) : [];
    return { entity, rows };
  });
  if (ctx.wantsJSON) {
    ctx.sendJson(200, { results: results.map(({ entity, rows }) => ({ entity, rows: rows.map((r) => rowJSON(store, entity, store.fields[entity], r, vc)) })) });
    return true;
  }
  ctx.send(200, searchView(graph, store, q, results, vc, searchPre(ctx, results)));
  return true;
}

export function handle(ctx) {
  const { parts, graph } = ctx;
  if (!parts.length) return home(ctx);
  if (parts[0] === 'page') return page(ctx);
  if (parts[0] === 'dashboard') return dashboard(ctx);
  if (parts[0] === 'list') return list(ctx);
  if (parts[0] === 'search' && graph.search) return search(ctx);
  return undefined;
}
