// The request context: everything a route module needs, built once per
// request. `vc` (view context) is the read-only "who is looking, what may
// they do" object render.mjs already expects; `send`/`redirect`/`ok`/`deny`
// are the only ways a route module answers the client.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { forbiddenPage, csv, plain, label } from '../render.mjs';

const readText = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
});

export class TooBig extends Error {}

const MAX_UPLOAD = Number(process.env.AG_MAX_UPLOAD || 8 * 1024 * 1024);

function parseBody(req, filesDir) {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    return new Response(Readable.toWeb(req), { headers: { 'content-type': ct } }).formData().then(async (fd) => {
      const out = {};
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') { out[k] = v; continue; }
        if (!v.size) continue;
        if (v.size > MAX_UPLOAD) throw new TooBig(`${v.name || 'file'} is larger than ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB`);
        fs.mkdirSync(filesDir, { recursive: true });
        const name = `${Date.now()}-${String(v.name || 'file').replace(/[^\w.-]/g, '_')}`;
        fs.writeFileSync(path.join(filesDir, name), Buffer.from(await v.arrayBuffer()));
        out[k] = name;
      }
      return out;
    });
  }
  return readText(req).then((text) => Object.fromEntries(new URLSearchParams(text)));
}

// "//evil.test" and "/\evil.test" are links off this site; only a single-slash path stays.
const safeNext = (to) => (typeof to === 'string' && /^\/(?![/\\])[^\s\x00-\x1f]*$/.test(to) ? to : '/');

// ?sort=&dir=&page= on any list, and its CSV export — split out only to keep
// createContext() under the function-size budget.
function createListHelpers(url, store, sendCsv) {
  const paged = (rows, ov) => {
    const size = ov.pageSize || 50;
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const at = Math.min(page, pages);
    return { rows: rows.slice((at - 1) * size, at * size), total: rows.length, page: at, pages };
  };
  const sortOf = (entity, ov) => {
    const field = url.searchParams.get('sort');
    if (field && (field === 'id' || store.field(entity, field))) return { field, dir: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc' };
    return ov.sort || null;
  };
  const exportRows = (name, entity, rows, cols, labels) => {
    const fields = store.fields[entity];
    const pick = (r, c) => { const f = fields.find((x) => x.name === c); return f ? plain(store, entity, f, r, labels) : r[c]; };
    return sendCsv(name, cols.map(label), rows.map((r) => cols.map((c) => pick(r, c))));
  };
  return { paged, sortOf, exportRows };
}

export function createContext({ req, res, url, graph, store, perms, sess, interp, trace, registry, filesDir, fetchImpl }) {
  const parts = url.pathname.split('/').filter(Boolean);
  const wantsCsv = parts.length > 0 && parts[parts.length - 1].endsWith('.csv');
  if (wantsCsv) parts[parts.length - 1] = parts[parts.length - 1].slice(0, -4);
  const wantsJSON = (req.headers.accept || '').includes('application/json');
  const flash = url.searchParams.get('ok') || '';
  const headers = {};

  const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  const redirect = (to) => { res.writeHead(303, { location: to, ...headers }); res.end(); };
  const ok = (to, msg) => redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : to);
  const sendCsv = (name, header, lines) => { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, ...headers }); res.end(csv(header, lines)); };
  const sendJson = (code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); };
  // The one place HTML vs JSON is decided for a route that already built both:
  // called at the exact point a route would otherwise `send(code, html)`.
  const answer = (code, html, json) => (wantsJSON ? sendJson(code, json) : send(code, html));

  const user = sess ? store.get(graph.roles.entity, sess.read(req.headers.cookie)) : null;
  const role = perms.enabled ? perms.roleOf(user) : null;
  const ownWhere = (entity) => { const own = perms.ownField(user, entity); return own ? { [own]: user ? user.id : -1 } : {}; };
  const vc = {
    user, role,
    can: (e, op, row) => perms.can(user, e, op, row),
    canSee: (item) => perms.canSee(user, item),
    ownField: (e) => perms.ownField(user, e),
    ownWhere: (e) => ownWhere(e),
    outbox: !perms.enabled || perms.isAdmin(user),
  };
  const deny = (message) => {
    trace({ kind: 'denied', path: url.pathname, who: user?.id ?? null, role });
    if (wantsJSON) return sendJson(403, { ok: false, status: 403, errors: [message || 'You are not allowed to do this.'] });
    if (perms.enabled && !user && req.method === 'GET') return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return send(403, forbiddenPage(graph, vc, message));
  };

  let bodyOnce = null;
  const body = () => (bodyOnce ??= parseBody(req, filesDir));
  const resolveTop = interp.resolve({ user, values: {} });
  const { paged, sortOf, exportRows } = createListHelpers(url, store, sendCsv);

  return {
    req, res, url, parts, flash, wantsCsv, wantsJSON, headers,
    graph, store, perms, sess, registry, interp, trace, filesDir, fetchImpl,
    user, role, vc, ownWhere, deny,
    send, redirect, ok, sendCsv, exportRows, sendJson, answer,
    body, resolveTop, paged, sortOf, safeNext,
  };
}
