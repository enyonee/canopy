// Home redirect, static /page/<id>, /dashboard/<id> (with its CSV export),
// and /list/<id> — every read that is not a declared entity's own routes
// (routes/entity.mjs) or a row action (routes/rows.mjs).
import { formatMoney } from '../spec.mjs';
import { errorPage } from '../render.mjs';
import { staticPage } from '../render/pages.mjs';
import { dashboardView } from '../render/dashboard.mjs';
import { listView } from '../render/list.mjs';

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
  return sendCsv(d.id, ['Section', 'Metric', 'Group', 'Value'], lines);
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
  const { graph, parts, send, flash, vc } = ctx;
  const p = (graph.pages || []).find((x) => x.id === parts[1]);
  if (!p) { send(404, errorPage(graph, `no page ${parts[1]}`)); return true; }
  if (!vc.canSee(p)) { ctx.deny(); return true; }
  send(200, staticPage(graph, p, flash, vc));
  return true;
}

function dashboard(ctx) {
  const { graph, store, parts, send, flash, vc, url, trace, wantsCsv, resolveTop, ownWhere } = ctx;
  const d = (graph.dashboards || []).find((x) => x.id === parts[1]);
  if (!d) { send(404, errorPage(graph, `no dashboard ${parts[1]}`)); return true; }
  if (!vc.canSee(d)) { ctx.deny(); return true; }
  const period = { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' };
  trace({ kind: 'dashboard', id: d.id, period });
  // A card is a read like any other: an own-scoped role counts its own rows, and a
  // card over an entity the role may not view is not on its dashboard at all.
  const scoped = (x) => ({ ...x, where: { ...resolveTop(x.where || {}), ...ownWhere(x.entity) } });
  const mine = { ...d, cards: (d.cards || []).map(scoped), tables: (d.tables || []).map(scoped) };
  if (wantsCsv) { dashboardCsv(ctx, d, mine, period); return true; }
  send(200, dashboardView(graph, store, mine, flash, vc, period));
  return true;
}

function list(ctx) {
  const { graph, store, parts, send, flash, vc, url, wantsCsv, resolveTop, ownWhere, sortOf, paged, exportRows } = ctx;
  const l = (graph.lists || []).find((x) => x.id === parts[1]);
  if (!l) { send(404, errorPage(graph, `no list ${parts[1]}`)); return true; }
  if (!vc.canSee(l) || !vc.can(l.entity, 'view')) { ctx.deny(); return true; }
  const where = { ...resolveTop(l.where || {}), ...ownWhere(l.entity) };
  const view = { ...(graph.override?.[`${l.entity}.list`] || {}), ...l, create: l.create ?? false };
  const sort = sortOf(l.entity, view);
  const all = store.list(l.entity, { where, sort, search: l.search || [], q: url.searchParams.get('q') || '' });
  const cols = view.columns || store.fields[l.entity].filter((f) => !f.type.secret).map((f) => f.name);
  if (wantsCsv) { exportRows(l.id, l.entity, all, cols, view.labels || {}); return true; }
  const pg = paged(all, view);
  const g = { ...graph, override: { ...graph.override, [`${l.entity}.list`]: view } };
  send(200, listView(g, store, l.entity, store.fields[l.entity], pg.rows, { q: url.searchParams.get('q') || '', where: {}, flash, vc, path: `/list/${l.id}`,
    query: url.searchParams.toString(), sort: sort?.field, dir: sort?.dir, ...pg }));
  return true;
}

export function handle(ctx) {
  const { parts } = ctx;
  if (!parts.length) return home(ctx);
  if (parts[0] === 'page') return page(ctx);
  if (parts[0] === 'dashboard') return dashboard(ctx);
  if (parts[0] === 'list') return list(ctx);
  return undefined;
}
