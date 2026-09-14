import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '../runtime/server.mjs';
import { loadPlugins } from '../runtime/registry.mjs';

// A fake network for outgoing HTTP: records calls, answers what the test says.
export const fakeFetch = () => {
  const calls = [];
  const state = { status: 200, throwWith: null };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (state.throwWith) throw new Error(state.throwWith);
    return { ok: state.status >= 200 && state.status < 300, status: state.status };
  };
  return { fetchImpl, calls, state };
};

export async function boot(graphFile = 'tests/fixtures/kitchen.json', opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-srv-'));
  const traceFile = path.join(dir, 'trace.jsonl');
  const net = fakeFetch();
  const { registry, errors: pluginErrors } = await loadPlugins(JSON.parse(fs.readFileSync(graphFile, 'utf8')), path.dirname(path.resolve(graphFile)));
  const app = serve({ graphFile, dbFile: path.join(dir, 'data.sqlite'), traceFile, port: 0, fetchImpl: net.fetchImpl, registry, pluginErrors, ...opts });
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const keep = (r) => { const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; };
  const headers = () => (cookie ? { cookie } : {});
  const get = async (p) => { const r = await fetch(base + p, { redirect: 'manual', headers: headers() }); keep(r); return { status: r.status, location: r.headers.get('location') || '', html: await r.text(), headers: r.headers }; };
  const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers() },
      body: new URLSearchParams(body).toString() });
    keep(r);
    return { status: r.status, location: r.headers.get('location') || '', html: await r.text() };
  };
  const upload = async (p, fields = {}, file = null) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field, new Blob([file.content]), file.name);
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: headers(), body: fd });
    keep(r);
    return { status: r.status, location: r.headers.get('location') || '', html: await r.text() };
  };
  const follow = async (p, body) => { const r = await post(p, body); return get(r.location || p); };
  const login = (user, password) => post('/login', { login: user, password });
  const asGuest = () => { cookie = ''; };
  const trace = () => fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // fetch keeps connections alive; without dropping them close() never resolves.
  const close = () => { app.server.closeAllConnections(); app.server.close(); };
  return { app, base, get, post, upload, follow, login, asGuest, trace, dir, close, net };
}

export const rows = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
export const flash = (html) => (/<p class="flash">([\s\S]*?)<\/p>/.exec(html) || [, ''])[1].trim();
export const tmpGraph = (graph) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-g-'));
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify(graph));
  return file;
};
