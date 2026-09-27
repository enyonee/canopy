// /Entity list/new/detail/edit (GET) and create/update/delete (POST) — the
// bulk of the scaffold's surface. The terminal route module: by the time
// server.mjs reaches it, /page, /dashboard, /list, /outbox, /file and
// /action have already been ruled out, so an unresolved parts[0] here really
// is "no entity at /X", and an unmatched shape under a real entity really is
// "no route". Row actions/transitions/related-add are routes/rows.mjs, called
// from here once the row itself is resolved.
import { errorPage, label } from '../render.mjs';
import { listView } from '../render/list.mjs';
import { formView } from '../render/form.mjs';
import { detailView } from '../render/detail.mjs';
import { handleRow } from './rows.mjs';

function listRoute(ctx, entity, fields, ov) {
  const { store, vc, url, ownWhere, resolveTop, sortOf, paged, exportRows, wantsCsv, trace, user, flash, graph, send } = ctx;
  if (!vc.can(entity, 'view')) { ctx.deny(); return true; }
  const where = { ...resolveTop(ov.where || {}) };
  const range = {};
  for (const f of ov.filters || []) {
    if (f.range) {
      const from = url.searchParams.get(`${f.field}_from`) || '', to = url.searchParams.get(`${f.field}_to`) || '';
      range[`${f.field}_from`] = from; range[`${f.field}_to`] = to;
      const kind = store.field(entity, f.field).kind;
      if (from || to) where[f.field] = { gte: from ? (kind === 'time' ? `${from}T00:00:00` : from) : undefined, lte: to ? (kind === 'time' ? `${to}T23:59:59.999Z` : to) : undefined };
      continue;
    }
    const v = url.searchParams.get(f.field);
    if (v !== null && v !== '') where[f.field] = v;
  }
  Object.assign(where, ownWhere(entity)); // a filter may narrow the row set, never widen it
  const q = url.searchParams.get('q') || '';
  const sort = sortOf(entity, ov);
  const all = store.list(entity, { search: ov.search || [], q, where, sort });
  trace({ kind: 'query', entity, q, where, rows: all.length, who: user?.id ?? null });
  if (wantsCsv) { exportRows(entity, entity, all, ov.columns || fields.filter((f) => !f.type.secret).map((f) => f.name), ov.labels || {}); return true; }
  const pg = paged(all, ov);
  send(200, listView(graph, store, entity, fields, pg.rows, { q, where, flash, vc, range, query: url.searchParams.toString(), sort: sort?.field, dir: sort?.dir, ...pg }));
  return true;
}

async function createRoute(ctx, entity, fields, formOv) {
  const { store, vc, user, perms, interp, trace, send, ok, graph } = ctx;
  if (!vc.can(entity, 'create')) { ctx.deny(); return true; }
  const submitted = interp.onlyWritable(entity, user, await ctx.body(), formOv.fields);
  interp.checkboxes(entity, submitted);
  const values = { ...submitted, ...ctx.resolveTop(formOv.fill || {}) };
  const own = perms.ownField(user, entity);
  if (own) values[own] = user.id;
  const problems = interp.validateValues(entity, values);
  if (problems.length) { trace({ kind: 'rejected', entity, problems }); send(400, formView(graph, store, entity, fields, submitted, 'new', problems, vc)); return true; }
  let id;
  try {
    id = await interp.attempt(() => {
      const n = store.insert(entity, values);
      trace({ kind: 'create', entity, id: n, effects: ['db.write'], who: user?.id ?? null });
      interp.fireEvents('created', entity, n, values, user);
      return n;
    });
  } catch (e) { trace({ kind: 'refused', entity, message: e.message }); send(400, formView(graph, store, entity, fields, submitted, 'new', [e.message], vc)); return true; }
  const after = interp.afterPath(formOv.after || `/${entity}`, entity, id, { created: id });
  ok(after, formOv.confirm || `${label(entity)} saved successfully`);
  return true;
}

async function updateRoute(ctx, entity, fields, formOv, id, row) {
  const { store, vc, user, interp, trace, send, ok, graph } = ctx;
  if (!vc.can(entity, 'edit', row)) { ctx.deny(); return true; }
  const submitted = interp.onlyWritable(entity, user, await ctx.body(), formOv.fields);
  interp.checkboxes(entity, submitted);
  const problems = interp.validateValues(entity, submitted, { partial: true, existing: store.raw(entity, id) });
  if (problems.length) { send(400, formView(graph, store, entity, fields, { ...row, ...submitted }, 'edit', problems, vc)); return true; }
  try {
    await interp.attempt(() => {
      store.update(entity, id, submitted);
      trace({ kind: 'update', entity, id, effects: ['db.write'], who: user?.id ?? null });
      interp.fireEvents('updated', entity, id, submitted, user);
    });
  } catch (e) { trace({ kind: 'refused', entity, id, message: e.message }); send(400, formView(graph, store, entity, fields, { ...row, ...submitted }, 'edit', [e.message], vc)); return true; }
  ok(interp.afterPath(formOv.afterEdit || `/${entity}`, entity, id), formOv.confirmEdit || `${label(entity)} updated successfully`);
  return true;
}

async function deleteRoute(ctx, entity, fields, id, row) {
  const { store, vc, user, interp, trace, send, ok, graph } = ctx;
  if (!vc.can(entity, 'delete', row)) { ctx.deny(); return true; }
  try {
    await interp.attempt(() => {
      store.remove(entity, id);
      trace({ kind: 'delete', entity, id, effects: ['db.write'], who: user?.id ?? null });
      interp.fireEvents('deleted', entity, id, {}, user, row);
    });
  } catch (e) { trace({ kind: 'refused', entity, id, message: e.message }); send(400, detailView(graph, store, entity, fields, row, e.message, vc)); return true; }
  ok(`/${entity}`, `${label(entity)} deleted`);
  return true;
}

function getRoutes(ctx, entity, fields, ov) {
  const { parts, vc, store, flash, send, graph } = ctx;
  if (parts.length === 1) return listRoute(ctx, entity, fields, ov);
  if (parts[1] === 'new') {
    if (vc.can(entity, 'create')) send(200, formView(graph, store, entity, fields, {}, 'new', [], vc, flash)); else ctx.deny();
    return true;
  }
  if (parts.length === 2 || parts[2] === 'edit') {
    const row = store.get(entity, parts[1]);
    if (!row) { send(404, errorPage(graph, `no ${entity} #${parts[1]}`)); return true; }
    if (parts.length === 2) { if (vc.can(entity, 'view', row)) send(200, detailView(graph, store, entity, fields, row, flash, vc)); else ctx.deny(); return true; }
    if (vc.can(entity, 'edit', row)) send(200, formView(graph, store, entity, fields, row, 'edit', [], vc, flash)); else ctx.deny();
    return true;
  }
  return undefined;
}

export async function handle(ctx) {
  const { graph, parts, req, send } = ctx;
  const entity = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[0].toLowerCase());
  if (!entity) { send(404, errorPage(graph, `no entity at /${parts[0]}`)); return true; }
  const fields = ctx.store.fields[entity];
  const ov = graph.override?.[`${entity}.list`] || {};
  const formOv = graph.override?.[`${entity}.form`] || {};

  if (req.method === 'GET') {
    const handled = getRoutes(ctx, entity, fields, ov);
    if (handled !== undefined) return handled;
  }
  if (req.method !== 'POST') { send(404, errorPage(graph, 'no route')); return true; }

  if (parts.length === 1) return createRoute(ctx, entity, fields, formOv);
  const id = parts[1];
  const row = ctx.store.get(entity, id);
  if (!row) { send(404, errorPage(graph, `no ${entity} #${id}`)); return true; }

  if (parts[2] === 'delete') return deleteRoute(ctx, entity, fields, id, row);
  if (['action', 'go', 'add'].includes(parts[2])) return handleRow(ctx, entity, fields, id, row);
  if (parts.length === 2) return updateRoute(ctx, entity, fields, formOv, id, row);
  send(404, errorPage(graph, 'no route'));
  return true;
}
