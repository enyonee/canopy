// GET /widget/_api.mjs (the shared client helper) and GET /widget/<name>.mjs
// (a plugin's own declared client file, content-type text/javascript). The
// requested name is only ever a lookup key into `registry.widgets` — never
// concatenated into a filesystem path — so there is no traversal past what a
// loaded plugin declared, and an unknown name is a plain 404.
import fs from 'node:fs';

const API_FILE = new URL('../client/api.mjs', import.meta.url);

function sendJs(ctx, body) {
  ctx.res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...ctx.headers });
  ctx.res.end(body);
}
function notFound(ctx, message) {
  ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...ctx.headers });
  ctx.res.end(message);
}

export function handle(ctx) {
  const { parts, req, registry } = ctx;
  if (parts[0] !== 'widget' || parts.length !== 2 || req.method !== 'GET' || !parts[1].endsWith('.mjs')) return undefined;
  const file = parts[1];
  if (file === '_api.mjs') { sendJs(ctx, fs.readFileSync(API_FILE, 'utf8')); return true; }
  const name = file.slice(0, -4);
  const w = registry.widgets[name];
  if (!w) { notFound(ctx, `no widget "${name}"`); return true; }
  sendJs(ctx, fs.readFileSync(w.client, 'utf8'));
  return true;
}
