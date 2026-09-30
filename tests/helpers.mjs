import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '../runtime/server.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { anyone } from '../runtime/render.mjs';
import { listView } from '../runtime/render/list.mjs';
import { dashboardView } from '../runtime/render/dashboard.mjs';
import { staticPage } from '../runtime/render/pages.mjs';
import { listPre, renderForm, renderDetail, dashboardPre, pagePre } from '../runtime/routes/load.mjs';

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

// Rows for every entity the app's own seed left empty (and a few extra for the seeded ones), in reference
// order, each ref pointing at a row that exists: enough for every hop and aggregate to have something to read.
export function populate(store, graph, perEntity = 8) {
  const refs = (e) => store.fields[e].filter((f) => f.kind === 'ref').map((f) => f.target).filter((t) => t !== e);
  const order = [], seen = new Set();
  const visit = (e) => { if (seen.has(e)) return; seen.add(e); refs(e).forEach(visit); order.push(e); };
  Object.keys(graph.data).forEach(visit);
  const value = (f, i, ids) => {
    switch (f.kind) {
      case 'ref': return ids[f.target]?.length && i % 5 !== 4 ? ids[f.target][i % ids[f.target].length] : undefined;
      case 'enum': return f.options[i % f.options.length];
      case 'int': return (i % 7) - 1;
      case 'money': return ((i % 9) + 1) * 1.25;
      case 'bool': return i % 2 === 0;
      case 'date': return `2026-0${1 + (i % 9)}-1${i % 10}`;
      case 'time': return `2026-0${1 + (i % 9)}-1${i % 10}T0${i % 10}:30:00.000Z`;
      case 'file': case 'image': return undefined;
      default: return `${f.name} ${i}`;
    }
  };
  const ids = {};
  for (const e of order) {
    ids[e] = store.list(e, {}).map((r) => r.id);
    for (let i = 0; i < perEntity; i++) {
      const row = {};
      for (const f of store.fields[e]) if (!f.derive) row[f.name] = value(f, i, ids);
      try { ids[e].push(store.insert(e, row)); } catch { /* a rule or a required column refused this generated row: fewer rows, same test */ }
    }
  }
}

// The views over a store, the way a route drives them (S3c): load what the page reads (runtime/routes/load.mjs),
// then render. `vc` defaults to "anyone"; the route context is just what the loaders read from it.
export const viewer = (graph, store, vc = anyone) => {
  const ctx = { graph, store, vc, resolveTop: (x) => x };
  return {
    ctx,
    list: (entity, rows, extra = {}) => listView(graph, store, entity, store.fields[entity], rows,
      { q: '', where: {}, vc, ...extra, pre: listPre(ctx, entity, store.fields[entity], graph.override?.[`${entity}.list`] || {}, rows) }),
    form: (entity, row, mode, errors = []) => renderForm(ctx, entity, store.fields[entity], row, mode, errors),
    detail: (entity, row, flash) => renderDetail(ctx, entity, store.fields[entity], row, flash),
    dashboard: (dash, flash = '', period = {}) => dashboardView(graph, store, dash, flash, vc, period, dashboardPre(ctx, dash, dash, period)),
    page: (p, flash) => staticPage(graph, p, flash, vc, store, pagePre(ctx, p)),
  };
};

// S3c: a graph whose pages read everything a render can reach: reference cells (one of them a derived label),
// reference filters and selects, a related table, transitions with fields, an embedded saved list, a dashboard
// grouped by references, and a role whose rows are owned through a ONE-HOP path (`Post.profile.user`, `Comment.post.owner`).
export const PAGES_GRAPH = {
  app: 'pages',
  data: {
    User: { login: 'text!', password: 'password', role: 'enum[admin,member]=member' },
    Profile: { user: 'ref:User!', nick: 'text!' },
    Tag: { label: 'text := concat(code, "!")', code: 'text!' },
    Post: { profile: 'ref:Profile!', owner: 'ref:User', tag: 'ref:Tag', title: 'text!', status: 'enum[open,done]=open', score: 'money=0', shout: 'text := upper(title)' },
    Comment: { post: 'ref:Post!', tag: 'ref:Tag', body: 'text!' },
  },
  roles: { entity: 'User', login: 'login', password: 'password', role: 'role',
    can: { admin: '*', member: {
      Post: { own: 'profile.user', can: ['view', 'create', 'edit', 'delete', 'go:*'] },
      Comment: { own: 'post.owner', can: ['view', 'create', 'edit'] },
      Profile: ['view'], Tag: ['view'], User: ['view'] } } },
  states: { Post: { field: 'status', transitions: [{ name: 'finish', from: 'open', to: 'done', fields: ['profile'] }] } },
  override: {
    'Post.list': { columns: ['title', 'profile', 'tag', 'shout', 'score', 'status'], filters: [{ field: 'tag' }], search: ['title'], rowActions: ['edit', 'delete', 'go:finish'] },
    'Post.detail': { related: [{ entity: 'Comment', via: 'post', columns: ['body', 'tag'], rowActions: ['edit'] }] },
  },
  lists: [{ id: 'posts', title: 'Posts', entity: 'Post', columns: ['title', 'profile', 'tag'] }],
  pages: [{ id: 'home', title: 'Home', sections: [{ list: 'posts', limit: 5 }, { form: 'Comment' }] }],
  dashboards: [{ id: 'd', title: 'D', cards: [{ title: 'Posts', entity: 'Post' }],
    tables: [{ title: 'By tag', entity: 'Post', groupBy: 'tag', metrics: [{ fn: 'count', as: 'n' }] }],
    charts: [{ title: 'By profile', entity: 'Post', type: 'bar', groupBy: 'profile', metric: { fn: 'count' } }] }],
  search: { entities: ['Post'] },
  views: 'auto',
};

// Users 1 (admin), 2 and 3 (members, each with a profile), three tags, `posts` posts split between the members
// (Post.profile -> Profile.user is the ownership path) and `comments` comments on each post of member 2.
export function seedPages(store, posts = 12, comments = 2) {
  store.insert('User', { login: 'root', password: 'pw', role: 'admin' });
  for (const m of [2, 3]) { store.insert('User', { login: `m${m}`, password: 'pw', role: 'member' }); store.insert('Profile', { user: m, nick: `nick ${m}` }); }
  for (const c of ['a', 'b', 'c']) store.insert('Tag', { code: c });
  for (let i = 0; i < posts; i++) {
    const member = 2 + (i % 2);
    const id = store.insert('Post', { profile: member - 1, owner: member, tag: 1 + (i % 3), title: `post ${i}`, score: i });
    if (member === 2) for (let c = 0; c < comments; c++) store.insert('Comment', { post: id, tag: 1 + (c % 3), body: `comment ${c}` });
  }
}
