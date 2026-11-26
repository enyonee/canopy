// The request context: everything a route module needs, built once per
// request. `vc` (view context) is the read-only "who is looking, what may
// they do" object render.mjs already expects; `send`/`redirect`/`ok`/`deny`
// are the only ways a route module answers the client.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { forbiddenPage, csv, plain, label, prefetched, refPairs } from '../render.mjs';

const readText = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
});

export class TooBig extends Error {}
// A JSON body (/api) that is not one flat object of plain values: the answer is a 400, never a guess.
export class BadBody extends Error {}

// The largest body a webhook may send.
const MAX_RAW = 1024 * 1024;

/**
 * The request body as bytes, exactly as sent (a signature is over these, not over what a parser makes of them).
 * Throws TooBig as soon as the declared length or the bytes read pass `cap`; nothing past the cap is kept.
 * @param {import('node:http').IncomingMessage} req
 */
export function rawBody(req, cap = MAX_RAW) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > cap) { reject(new TooBig(`the body is larger than ${cap} bytes`)); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (size > cap) return; // already refused: what still arrives is dropped, never kept
      size += c.length;
      if (size > cap) { chunks.length = 0; reject(new TooBig(`the body is larger than ${cap} bytes`)); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MAX_UPLOAD = Number(process.env.AG_MAX_UPLOAD || 8 * 1024 * 1024);

// The files this request uploaded, by field name: the name each was stored under (routes may store no other).
/** @param {Map<string, string>} uploads */
function parseBody(req, filesDir, uploads) {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) {
    return new Response(Readable.toWeb(req), { headers: { 'content-type': ct } }).formData().then(async (fd) => {
      const out = {};
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') { out[k] = v; continue; }
        // An empty upload still sends a part: record it as "" rather than dropping the
        // key outright (item 13) — interp.mjs's dropEmptyUploads is what then decides,
        // per field, whether that means "unchanged"/"none" or a required-field error.
        if (!v.size) { out[k] = ''; continue; }
        if (v.size > MAX_UPLOAD) throw new TooBig(`${v.name || 'file'} is larger than ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB`);
        fs.mkdirSync(filesDir, { recursive: true });
        const name = `${Date.now()}-${String(v.name || 'file').replace(/[^\w.-]/g, '_')}`;
        fs.writeFileSync(path.join(filesDir, name), Buffer.from(await v.arrayBuffer()));
        uploads.set(k, name);
        out[k] = name;
      }
      return out;
    });
  }
  return readText(req).then((text) => Object.fromEntries(new URLSearchParams(text)));
}

/** Is this POST from the page's own site? The Origin (else the Referer) names the same host the request was sent to. */
export function sameOrigin(req) {
  const from = req.headers.origin ?? req.headers.referer;
  if (!from) return false;
  try { return new URL(from).host === req.headers.host; } catch { return false; } // allow-swallow: a header that is not a URL is a cross-site request, refused
}

// The largest JSON body /api reads.
const MAX_JSON = 1024 * 1024;

// A JSON body as the values a form would have posted: every value a string, as on the form path, so one validation path
// reads both. A number or a boolean is its text ("12.5", "true"), null is the empty value; an array or an object is refused.
async function jsonBody(req) {
  const text = (await rawBody(req, MAX_JSON)).toString('utf8');
  let data;
  try { data = JSON.parse(text); } catch { throw new BadBody('the body is not JSON'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new BadBody('the body must be a JSON object');
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object') throw new BadBody(`"${k}" must be a string, a number, a boolean or null`);
    out[k] = v === null ? '' : String(v);
  }
  return out;
}

// With a front (runtime/web.mjs), the scaffold answers under a base path: every root-absolute link, form target
// and script source of a page, and every redirect, is written for the base here, at the one place a page or a
// redirect leaves the server, so no screen knows it. Without a front `base` is '' and nothing is touched.
// Values are escaped (`"` is `&quot;`), so only real attributes match; "//host" and "/\\host" are not paths, and a
// path already under the base (`/admin`, `/admin/…`, `/admin?…`) is not given it twice.
const LINK = /(\s(?:href|src|action|formaction)=")(\/[^"]*)/g;
const under = (to, base) => to.startsWith(base) && (to.length === base.length || '/?#'.includes(to[base.length]));
const rebased = (to, base) => /^\/(?![/\\])/.test(to) && !under(to, base);
export const rebase = (html, base) => html.replace(LINK, (m, attr, to) => (rebased(to, base) ? `${attr}${base}${to}` : m));
export const rebaseTo = (to, base) => (rebased(to, base) ? base + to : to);

// "//evil.test" and "/\evil.test" are links off this site; only a single-slash path stays.
const safeNext = (to) => (typeof to === 'string' && /^\/(?![/\\])[^\s\x00-\x1f]*$/.test(to) ? to : '/');

// ?sort=&dir=&page= on any list, and its CSV export — split out only to keep
// createContext() under the function-size budget. `paged` hydrates only the
// rows it is about to show (store.listPage — item 2, "page before hydrate"),
// not the whole matching set: it takes the entity and the same query options
// listRaw/list would, never an already-fetched row array.
function createListHelpers(url, store, sendCsv, vc) {
  const paged = async (entity, opts, ov) => {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    return await store.listPage(entity, opts, { page, pageSize: ov.pageSize || 50 });
  };
  const sortOf = (entity, ov) => {
    const field = url.searchParams.get('sort');
    if (field && (field === 'id' || store.field(entity, field))) return { field, dir: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc' };
    return ov.sort || null;
  };
  const exportRows = async (name, entity, rows, cols, labels) => {
    const fields = store.fields[entity];
    // The labels of every reference cell, loaded before the first line is formatted.
    const pre = prefetched(await store.labelsFor(refPairs(fields, cols, rows)));
    const pick = (r, c) => { const f = fields.find((x) => x.name === c); return f ? plain(store, entity, f, r, labels, vc, pre) : r[c]; };
    return sendCsv(name, cols.map(label), rows.map((r) => cols.map((c) => pick(r, c))));
  };
  return { paged, sortOf, exportRows };
}

// What a submitted body says about an entity's fields. A form's unchecked box sends nothing and means false, and its empty
// upload means "unchanged"; a JSON body (/api) says what it means (an absent key is absent, the default or the stored value
// stays) and cannot carry a file, so a file field it names is dropped rather than pointed at a file already on disk.
// A form's upload field likewise takes only the file this request uploaded under its name: a text value (an urlencoded
// body, a text part) naming a stored file would point the field at a file another row owns, so it is dropped.
// The same rule for a body a route writes without a form (a transition's or a row action's fields, db.create): every
// upload field of the entity keeps only this request's own file.
/** @param {Map<string, string>} uploads */
const ownFilesOf = (store, uploads) => (entity, values) => {
  for (const f of store.fields[entity]) {
    const v = values[f.name];
    if (f.type.upload && v !== undefined && v !== '' && uploads.get(f.name) !== v) delete values[f.name];
  }
  return values;
};

const submittedOf = (api, store, interp, ownFiles) => (entity, values) => {
  if (!api) return interp.dropEmptyUploads(entity, interp.checkboxes(entity, ownFiles(entity, values)));
  for (const f of store.fields[entity]) if (f.type.upload) delete values[f.name];
  return values;
};

export async function createContext({ req, res, url, graph, store, perms, sess, interp, trace, registry, filesDir, fetchImpl, clock, env, graphFile, base = '' }) {
  const parts = url.pathname.split('/').filter(Boolean);
  const wantsCsv = parts.length > 0 && parts[parts.length - 1].endsWith('.csv');
  if (wantsCsv) parts[parts.length - 1] = parts[parts.length - 1].slice(0, -4);
  // /api/<path> is <path> answered in JSON whatever the Accept header says: the prefix goes before any route reads `parts`.
  const api = parts[0] === 'api';
  if (api) parts.shift();
  const wantsJSON = api || (req.headers.accept || '').includes('application/json');
  const flash = url.searchParams.get('ok') || '';
  const headers = {};

  const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(base ? rebase(html, base) : html); };
  const redirect = (to) => { res.writeHead(303, { location: base ? rebaseTo(to, base) : to, ...headers }); res.end(); };
  const ok = (to, msg) => redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : to);
  const sendCsv = (name, header, lines) => { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, ...headers }); res.end(csv(header, lines)); };
  const sendJson = (code, data) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); };
  // The one place HTML vs JSON is decided for a route that already built both:
  // called at the exact point a route would otherwise `send(code, html)`.
  const answer = (code, html, json) => (wantsJSON ? sendJson(code, json) : send(code, html));

  const user = sess ? await store.get(graph.roles.entity, await sess.read(req.headers.cookie)) : null;
  const role = perms.enabled ? perms.roleOf(user) : null;
  const ownWhere = async (entity, op = 'view') => await perms.ownWhere(user, entity, op);
  const vc = {
    user, role,
    can: (e, op, row) => perms.can(user, e, op, row),
    canSee: (item) => perms.canSee(user, item),
    isAdmin: !perms.enabled || perms.isAdmin(user),
    ownField: (e) => perms.ownField(user, e),
    ownWhere: async (e, op) => await ownWhere(e, op),
    ownOk: (e, row, op) => perms.ownOk(user, e, row, op),
    prime: async (e, rows) => { await perms.prime(user, e, rows); },
    outbox: !perms.enabled || perms.isAdmin(user),
    settings: !perms.enabled || perms.isAdmin(user),
  };
  const deny = (message) => {
    trace({ kind: 'denied', path: url.pathname, who: user?.id ?? null, role });
    if (wantsJSON) return sendJson(403, { ok: false, status: 403, errors: [message || 'You are not allowed to do this.'] });
    if (perms.enabled && !user && req.method === 'GET') return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    return send(403, forbiddenPage(graph, vc, message));
  };

  let bodyOnce = null;
  const uploads = new Map();
  const ownFiles = ownFilesOf(store, uploads);
  const body = () => (bodyOnce ??= api ? jsonBody(req) : parseBody(req, filesDir, uploads));
  const resolveTop = interp.resolve({ user, values: {} });
  const { paged, sortOf, exportRows } = createListHelpers(url, store, sendCsv, vc);

  return {
    req, res, url, parts, api, flash, wantsCsv, wantsJSON, headers,
    graph, store, perms, sess, registry, interp, trace, filesDir, fetchImpl, clock, env, graphFile, base,
    user, role, vc, ownWhere, deny,
    send, redirect, ok, sendCsv, exportRows, sendJson, answer,
    body, rawBody: () => rawBody(req), resolveTop, paged, sortOf, safeNext, submitted: submittedOf(api, store, interp, ownFiles), ownFiles,
  };
}
