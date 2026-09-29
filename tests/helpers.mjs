import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '../runtime/server.mjs';
import { loadPlugins } from '../runtime/registry.mjs';

// Every directory a test makes goes through here and is removed when the test file's process
// ends, pass or fail (a leaked one costs an inode for ever; the mutation gate runs the suite
// ~180 times). With `t` it is removed as soon as that test is done.
const made = new Set();
const drop = (d) => { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); made.delete(d); };
process.on('exit', () => { for (const d of made) drop(d); });
export const tmpDir = (prefix, t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  if (t) t.after(() => drop(dir));
  return dir;
};

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
  const dir = tmpDir('ag-srv-');
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
  const close = () => { app.server.closeAllConnections(); app.server.close(); drop(dir); };
  return { app, base, get, post, upload, follow, login, asGuest, trace, dir, close, net };
}

export const rows = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
export const flash = (html) => (/<p class="flash">([\s\S]*?)<\/p>/.exec(html) || [, ''])[1].trim();
export const tmpGraph = (graph) => {
  const dir = tmpDir('ag-g-');
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify(graph));
  return file;
};

// Every `new Date()` reads `iso` until the returned restore function runs (`t.after(freezeClock())`):
// the JS path's clock and a compiled aggregate's bound `today`/`now` are then one and the same.
export const freezeClock = (iso = '2026-09-29T12:00:00.000Z') => {
  const Real = globalThis.Date;
  globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new Real(iso).getTime(); } };
  return () => { globalThis.Date = Real; };
};

// A clock for the delivery path (runtime/clock.mjs): time moves only when the test says so. `advance(ms)` fires every
// timer that falls due on the way, in order, awaiting each callback (so a flush it starts has finished when it returns).
export const fakeClock = (start = 1_000_000) => {
  let t = start, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const handle = ++seq; timers.set(handle, { at: t + Math.max(0, ms), fn, handle }); return handle; },
    clear: (handle) => { timers.delete(handle); },
    pending: () => timers.size,
    nextAt: () => Math.min(...[...timers.values()].map((x) => x.at)),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.values()].filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.handle - b.handle)[0];
        if (!due) break;
        timers.delete(due.handle);
        t = Math.max(t, due.at);
        await due.fn();
      }
      t = end;
    },
  };
};

// The JS reference of the SQL-compiled aggregates: the compiler is off for the snapshot path
// (`compileAggIn`) and for the lazy one (`aggValue`, and a page cache with no batches), so every
// aggregate is evaluated by runtime/expr.mjs over child rows. Restores whatever `fn` returns/throws.
export const compilerOff = (store, fn) => {
  const { aggValue, buildAggCache } = store;
  store.compileAggIn = () => null;
  store.plans.clear(); // plans record which aggregates compile
  store.aggValue = () => undefined;
  store.buildAggCache = () => ({ groups: new Map(), scalars: new Map(), clock: new Date() });
  try { return fn(); } finally { delete store.compileAggIn; store.plans.clear(); store.aggValue = aggValue; store.buildAggCache = buildAggCache; }
};
