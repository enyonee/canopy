// Home redirect, static /page/<id>, /dashboard/<id> (with its CSV export),
// /list/<id> and /search — every read that is not a declared entity's own
// routes (routes/entity.mjs) or a row action (routes/rows.mjs).
import { formatMoney } from '../spec.mjs';
import { errorPage, rowJSON } from '../render.mjs';
import { staticPage } from '../render/pages.mjs';
import { dashboardView } from '../render/dashboard.mjs';
import { listView } from '../render/list.mjs';
import { searchView } from '../render/search.mjs';

function dashboardCsv(ctx, d, mine, period) {
  const { store, sendCsv } = ctx;
  const lines = [];
  const inPeriod = (entity, where) => {
    const f = d.period?.[entity];
    if (!f || (!period.from && !period.to)) return where;
    const kind = store.field(entity, f).kind;
    const r = {};
    if (period.from) r.gte = kind === 'time' ? `${period.from}T00:00:00` : period.from;
    if (period.to) r.lte = kind === 'time' ? `${period.to}T23:59:59.999Z` : period.to;
    return { ...where, [f]: r };
  };
  for (const c of mine.cards) {
    const [row] = store.aggregate(c.entity, { metrics: [{ fn: c.fn || 'count', field: c.field, as: 'v' }], where: inPeriod(c.entity, c.where) });
    const f = c.field && store.field(c.entity, c.field);
    lines.push(['card', c.title, '', f?.kind === 'money' && c.fn !== 'count' ? formatMoney(Math.round(row?.v ?? 0)) : (row?.v ?? 0)]);
  }
  for (const t of mine.tables) for (const r of store.aggregate(t.entity, { ...t, where: inPeriod(t.entity, t.where) })) {
    const g = t.groupBy ? store.field(t.entity, t.groupBy) : null;
    let grp = r.grp;
    if (g?.kind === 'ref') grp = store.label(g.target, store.get(g.target, grp));
    if (g?.kind === 'bool') grp = grp ? 'Yes' : 'No';
    for (const m of t.metrics || []) {
      const mf = m.field && store.field(t.entity, m.field);
      lines.push([t.title, m.title ?? m.as, grp ?? '', mf?.kind === 'money' && m.fn !== 'count' && r[m.as] != null ? formatMoney(Math.round(r[m.as])) : (r[m.as] ?? '')]);
    }
  }
  for (const c of mine.charts || []) for (const r of store.aggregate(c.entity, { groupBy: c.groupBy, groupUnit: c.groupUnit,
    metrics: [{ fn: c.metric.fn, field: c.metric.field, as: 'v' }], sort: c.sort, limit: c.limit, where: inPeriod(c.entity, c.where) })) {
    const g = c.groupBy ? store.field(c.entity, c.groupBy) : null;
    let grp = r.grp;
    if (g?.kind === 'ref') grp = store.label(g.target, store.get(g.target, grp));
    if (g?.kind === 'bool') grp = grp ? 'Yes' : 'No';
    const mf = c.metric.field && store.field(c.entity, c.metric.field);
    lines.push([c.title, c.metric.fn, grp ?? '', mf?.kind === 'money' && c.metric.fn !== 'count' && r.v != null ? formatMoney(Math.round(r.v)) : (r.v ?? '')]);
  }
  return sendCsv(d.id, ['Section', 'Metric', 'Group', 'Value'], lines);
}

// The same numbers dashboardView()/dashboardCsv() compute, as JSON: one
// metric per card/chart, one row per group in a table/chart.
function dashboardJson(ctx, d, mine, period) {
  const { store } = ctx;
  const inPeriod = (entity, where) => {
    const f = d.period?.[entity];
    if (!f || (!period.from && !period.to)) return where;
    const kind = store.field(entity, f).kind;
    const r = {};
    if (period.from) r.gte = kind === 'time' ? `${period.from}T00:00:00` : period.from;
    if (period.to) r.lte = kind === 'time' ? `${period.to}T23:59:59.999Z` : period.to;
    return { ...where, [f]: r };
  };
  const cards = mine.cards.map((c) => {
    const [row] = store.aggregate(c.entity, { metrics: [{ fn: c.fn || 'count', field: c.field, as: 'v' }], where: inPeriod(c.entity, c.where) });
    return { title: c.title, value: row?.v ?? 0 };
  });
  const grouped = (t) => store.aggregate(t.entity, { ...t, where: inPeriod(t.entity, t.where) });
  const tables = mine.tables.map((t) => ({ title: t.title, rows: grouped(t) }));
  const charts = (mine.charts || []).map((c) => ({ title: c.title, type: c.type,
    rows: store.aggregate(c.entity, { groupBy: c.groupBy, groupUnit: c.groupUnit, metrics: [{ fn: c.metric.fn, field: c.metric.field, as: 'v' }], sort: c.sort, limit: c.limit, where: inPeriod(c.entity, c.where) }) }));
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
  const { graph, store, parts, send, flash, vc, resolveTop } = ctx;
  const p = (graph.pages || []).find((x) => x.id === parts[1]);
  if (!p) { send(404, errorPage(graph, `no page ${parts[1]}`)); return true; }
  if (!vc.canSee(p)) { ctx.deny(); return true; }
  send(200, staticPage(graph, p, flash, vc, store, resolveTop));
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
  if (wantsCsv) { dashboardCsv(ctx, d, mine, period); return true; }
  if (ctx.wantsJSON) { dashboardJson(ctx, d, mine, period); return true; }
  ctx.send(200, dashboardView(graph, store, mine, flash, vc, period));
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
  const all = store.list(l.entity, { where, sort, search: l.search || [], q: url.searchParams.get('q') || '' });
  const cols = view.columns || store.fields[l.entity].filter((f) => !f.type.secret).map((f) => f.name);
  if (wantsCsv) { exportRows(l.id, l.entity, all, cols, view.labels || {}); return true; }
  const pg = paged(all, view);
  if (ctx.wantsJSON) { ctx.sendJson(200, { rows: pg.rows.map((r) => rowJSON(store, l.entity, store.fields[l.entity], r, vc)), total: pg.total, page: pg.page, pages: pg.pages }); return true; }
  const g = { ...graph, override: { ...graph.override, [`${l.entity}.list`]: view } };
  ctx.send(200, listView(g, store, l.entity, store.fields[l.entity], pg.rows, { q: url.searchParams.get('q') || '', where: {}, flash, vc, path: `/list/${l.id}`,
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
  ctx.send(200, searchView(graph, store, q, results, vc));
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
