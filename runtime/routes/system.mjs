// /outbox (+ retry), /file/Entity/:id/<field> downloads, and global
// POST /action/<name> (an action with no "in").
import fs from 'node:fs';
import path from 'node:path';
import { errorPage, noticePage } from '../render.mjs';
import { outboxView } from '../render/pages.mjs';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv' };

// An operator's word on a delivery. Retry starts it over (attempts and schedule cleared); "mark sent" settles a
// delivery of unknown outcome (the request may have landed) as done, and only that.
async function outboxAction(ctx, row, action) {
  const { store, ok, interp } = ctx;
  if (action === 'retry') {
    store.outboxUpdate(row.id, { status: 'queued', nextAttemptAt: null, attempts: 0 });
    await interp.flushNow();
    ok('/outbox', `Delivery #${row.id} retried: ${store.outboxGet(row.id).status}`);
  } else if (store.outboxMark(row.id, 'unknown', { status: 'sent', error: null })) ok('/outbox', `Delivery #${row.id} marked as sent`);
  else ok('/outbox', `Delivery #${row.id} is not waiting for a decision`);
}

async function outbox(ctx) {
  const { graph, store, parts, req, send, vc } = ctx;
  if (!vc.outbox) { ctx.deny(); return true; }
  if (['retry', 'sent'].includes(parts[2]) && req.method === 'POST') {
    const row = store.outboxGet(parts[1]);
    if (!row) { send(404, errorPage(graph, `no delivery #${parts[1]}`)); return true; }
    await outboxAction(ctx, row, parts[2]);
    return true;
  }
  send(200, outboxView(graph, store.outbox(), ctx.flash, vc, store.breakers()));
  return true;
}

function file(ctx) {
  const { graph, store, parts, send, vc, filesDir, headers, res, url } = ctx;
  const [, e, id, fieldName] = parts;
  const entity = Object.keys(graph.data).find((x) => x.toLowerCase() === e.toLowerCase());
  const f = entity && store.field(entity, fieldName);
  if (!entity || !f || !f.type.upload) { send(404, errorPage(graph, 'no such file')); return true; }
  if (!vc.can(entity, 'view')) { ctx.deny(); return true; }
  const row = store.get(entity, id);
  if (!row || !row[fieldName]) { send(404, errorPage(graph, 'no such file')); return true; }
  if (!vc.can(entity, 'view', row)) { ctx.deny(); return true; }
  const at = path.join(filesDir, path.basename(row[fieldName]));
  if (!fs.existsSync(at)) { send(404, errorPage(graph, 'file is missing on disk')); return true; }
  const ext = path.extname(at).slice(1).toLowerCase();
  const mime = MIME[ext];
  const inline = url.searchParams.get('inline') === '1' && mime;
  res.writeHead(200, { 'content-type': inline ? mime : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(row[fieldName]).replace(/^\d+-/, '').replace(/"/g, '')}"`, ...headers });
  fs.createReadStream(at).pipe(res);
  return true;
}

async function globalAction(ctx) {
  const { graph, parts, req, ok, vc, role, perms, interp, trace, user } = ctx;
  if (req.method !== 'POST') return undefined;
  const action = (graph.actions || []).find((a) => a.name === parts[1] && !a.in);
  if (!action) { ctx.answer(404, errorPage(graph, `no global action ${parts[1]}`), { ok: false, status: 404, errors: [`no global action ${parts[1]}`] }); return true; }
  if (action.by ? !action.by.includes(role) : perms.enabled && !vc.can('*', `do:${action.name}`)) { ctx.deny(); return true; }
  const values = await ctx.body();
  if (action.fields?.length) {
    // Item 19: no entity to type-check against for a global action, so its
    // declared fields are just required (plain text) named inputs.
    const problems = action.fields.filter((f) => values[f] === undefined || String(values[f]).trim() === '').map((f) => `${f} is required`);
    if (problems.length) { ctx.answer(400, noticePage(graph, vc, 'Not done', problems.join('; ')), { ok: false, status: 400, errors: problems }); return true; }
  }
  let out;
  try { out = await interp.attempt(() => interp.runSteps(action.do, { rowEntity: null, id: null, values, user })); }
  catch (e) {
    trace({ kind: 'refused', action: action.name, message: e.message });
    ctx.answer(400, noticePage(graph, vc, 'Not done', e.message), { ok: false, status: 400, errors: [e.message] });
    return true;
  }
  const flash = action.confirm ? interp.interpolate(action.confirm, out) : '';
  if (ctx.wantsJSON) { ctx.sendJson(200, { ok: true, created: out.created, flash }); return true; }
  ok(interp.afterPath(action.after || '/', null, null, { created: out.created }), flash);
  return true;
}

export function handle(ctx) {
  const { parts } = ctx;
  if (parts[0] === 'outbox') return outbox(ctx);
  if (parts[0] === 'file' && parts.length === 4) return file(ctx);
  if (parts[0] === 'action') return globalAction(ctx);
  return undefined;
}
