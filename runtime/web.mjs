// The front of an app that declares "web": the built directory it names is served at /, and the scaffold
// (every HTML screen, its forms and their JSON answers) moves under SCAFFOLD. This module decides, before any
// session or store is asked, which of three things a request is: a file of the front (or the front's index.html,
// the SPA fallback), a request for the scaffold (handed back with the base its links and redirects get), or a
// refusal. It only ever reads below the front's own directory: a path is decoded segment by segment, dot-names
// and encoded separators are refused, and the file found is resolved through symlinks and must still lie inside.
import fs from 'node:fs';
import path from 'node:path';

export const SCAFFOLD = '/admin';

// The only first path segments the runtime answers at the root once a front is served; every other path is the
// front's (so it may route /login or /dashboard/3 itself). `api` and `hook` keep their root address (the contract
// and a provider's webhook URL do not move); `file` and `widget` answer at the root with the scaffold's base (a
// widget module imports `/widget/_api.mjs` by its root path, and a front may link an upload by it).
export const RESERVED = ['admin', 'api', 'hook', 'file', 'widget'];

const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};
// A bundler's content-hashed output (Vite: `assets/index-BdX3k9aZ.js`) never changes under its name: cached for a year.
// Everything else, index.html first, is revalidated on every load (its ETag answers 304 when nothing changed).
const HASHED = /^assets\/(?:.+\/)?[^/]+[.-][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** The front's directory: `web` resolved against the directory of app.json. */
export const webRoot = (graphFile, graph) => path.resolve(path.dirname(graphFile), graph.web);

/** What keeps the front from being served: its index.html is missing (it is built, not written). */
export function webProblems(graphFile, graph) {
  const index = path.join(webRoot(graphFile, graph), 'index.html');
  if (fs.existsSync(index) && fs.statSync(index).isFile()) return [];
  return [{ path: '/web', message: `${index} not found: "web" names the built front, and it has not been built`,
    hint: 'build the front into that directory (it must contain index.html), or remove "web" to serve the scaffold at /' }];
}

/**
 * The file of the front a URL path names, or null: undecodable, a dot-name (`.`, `..`, `.env`), an encoded
 * separator or NUL in a segment, missing, a directory, or (through a symlink) outside `real`.
 * @param {string} real the front's directory, already resolved through symlinks
 * @param {string} pathname
 */
export function locate(real, pathname) {
  let segs;
  try { segs = pathname.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { return null; } // a malformed %-escape names no file
  if (segs.some((s) => s.startsWith('.') || /[\\/\0]/.test(s))) return null;
  if (!segs.length) segs = ['index.html'];
  let at;
  try { at = fs.realpathSync(path.join(real, ...segs)); }
  catch { return null; } // ENOENT and friends: no such file
  if (!at.startsWith(real + path.sep) || !fs.statSync(at).isFile()) return null;
  return at;
}

const wantsJSON = (req) => (req.headers.accept || '').includes('application/json');

function refuse(req, res, code, message, extra = {}) {
  const json = wantsJSON(req);
  res.writeHead(code, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...extra });
  res.end(json ? JSON.stringify({ ok: false, status: code, errors: [message] }) : message);
}

function sendFile(req, res, real, file) {
  const st = fs.statSync(file);
  const rel = path.relative(real, file).split(path.sep).join('/');
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'content-type': TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream',
    'cache-control': HASHED.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
    etag, 'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  const body = fs.readFileSync(file);
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(body); // node:http sends no body to a HEAD itself
}

// A file of the front, else (a navigation: GET/HEAD, no extension in the last segment, not asking for JSON) the
// front's index.html, so the SPA's own router reads the path; else 404.
function serveFront(req, res, url, real) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { refuse(req, res, 405, `${req.method} ${url.pathname}: the front only serves files`, { allow: 'GET, HEAD' }); return; }
  const file = locate(real, url.pathname);
  if (file) { sendFile(req, res, real, file); return; }
  const last = url.pathname.split('/').pop();
  if (!path.extname(last) && !wantsJSON(req)) { sendFile(req, res, real, path.join(real, 'index.html')); return; }
  refuse(req, res, 404, `no file ${url.pathname} in the front`);
}

/**
 * The front's request router. Answers the request itself and returns null, or returns `{ url, base }` for the
 * scaffold: `url` as the scaffold's routes read it (SCAFFOLD stripped), `base` what its links and redirects get.
 * @param {string} root the front's directory
 */
export function openFront(root) {
  const real = fs.realpathSync(root);
  return (req, res, url) => {
    const first = url.pathname.split('/')[1];
    if (!RESERVED.includes(first)) { serveFront(req, res, url, real); return null; }
    if (first === 'admin') {
      const inner = new URL(url);
      inner.pathname = url.pathname.slice(SCAFFOLD.length) || '/';
      return { url: inner, base: SCAFFOLD };
    }
    if (first === 'api' || first === 'hook') return { url, base: '' };
    return { url, base: SCAFFOLD }; // file, widget
  };
}
