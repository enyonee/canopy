// Round four: client widgets, JSON answers, dashboard charts, the `schedule`
// node kind, auto-refresh, and the shared `messaging` plugin. The full path
// (widget registry -> checker -> render -> /widget/<name>.mjs) is proven end
// to end by apps/tictactoe (a reference app, not a benchmark task); this file
// covers the runtime pieces directly, plus the cases tictactoe's single
// role-less app cannot reach (own-scoping, denial, a second role).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { Store } from '../runtime/store.mjs';
import { validate } from '../runtime/validate.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { page, widgetBlock, rowJSON } from '../runtime/render.mjs';
import { staticPage } from '../runtime/render/pages.mjs';
import { detailView } from '../runtime/render/detail.mjs';
import { dashboardView, chartBlock } from '../runtime/render/dashboard.mjs';
import { api, mountWidgets } from '../runtime/client/api.mjs';
import { validEvery, everyMs } from '../runtime/schedule.mjs';
import messaging from '../plugins/messaging.mjs';
import { boot, rows, tmpGraph, tmpDir } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Widgets: the registry table, the checker, the markup, the serving routes.
// ---------------------------------------------------------------------------
const dir = tmpDir('ag-widget-');
const writeFile = (name, source) => { const f = path.join(dir, name); fs.writeFileSync(f, source); return f; };
const chessPlugin = writeFile('chess.mjs', `export default {
  widgets: { chess: { summary: 'a chess board', client: './chess.client.mjs', props: ['fen'],
    check: (node, h) => { if (node.fen === 'bad') h.err(h.path, 'fen is bad'); } } },
};`);
writeFile('chess.client.mjs', `export default function mount() {}\n`);

test('the widgets table starts empty; a plugin registers into it like any other table', async () => {
  const { registry, errors } = await loadPlugins({ plugins: [chessPlugin] }, dir);
  assert.deepEqual(errors, []);
  assert.ok(registry.widgets.chess);
  assert.equal(registry.widgets.chess.client, path.join(dir, 'chess.client.mjs'), '"client" is resolved against the app directory, like a plugin path');
  const clash = await loadPlugins({ plugins: [chessPlugin, chessPlugin] }, dir);
  assert.match(clash.errors[0].message, /widgets "chess" is already registered/);
});

test('a widget with a non-string "client" is a load error, not a crash', async () => {
  const bad = writeFile('badwidget.mjs', `export default { widgets: { x: { summary: 's' } } };`);
  const { errors } = await loadPlugins({ plugins: [bad] }, dir);
  assert.match(errors[0].message, /needs "client" as a path string/);
});

test('checker: unknown widget, missing required prop, the widget\'s own check(), on a page and on Entity.detail', async () => {
  const { registry } = await loadPlugins({ plugins: [chessPlugin] }, dir);
  const base = { app: 'w', data: { Match: { name: 'text!' } } };
  const at = (g) => validate(g, registry);
  const ghost = at({ ...base, pages: [{ id: 'p', title: 'P', widget: { use: 'ghost' } }] });
  assert.match(ghost.find((e) => e.path === '/pages/0/widget/use').message, /unknown widget "ghost"/);
  const near = at({ ...base, override: { 'Match.detail': { widget: { use: 'chess' } } } });
  assert.match(near.find((e) => e.path === '/override/Match.detail/widget').message, /requires prop "fen"/);
  assert.equal(at({ ...base, override: { 'Match.detail': { widget: { use: 'chess', fen: 'ok' } } } }).length, 0);
  const rejected = at({ ...base, override: { 'Match.detail': { widget: { use: 'chess', fen: 'bad' } } } });
  assert.match(rejected.find((e) => e.path === '/override/Match.detail/widget').message, /fen is bad/);
  // A widget only makes sense on a page (no row) or Entity.detail (a row); Match.list gets no such check at all.
  assert.equal(at({ ...base, override: { 'Match.list': { widget: { use: 'ghost' } } } }).length, 0);
});

test('widgetBlock renders the declared markup; a page has no row, a detail widget carries one', () => {
  const noRow = widgetBlock({ use: 'chess', fen: 'abc' });
  assert.match(noRow, /data-widget="chess"/);
  assert.match(noRow, /data-props='\{&quot;fen&quot;:&quot;abc&quot;\}'/);
  assert.ok(!/data-row=/.test(noRow), 'a page widget has no row');
  assert.match(noRow, /<script type="module" src="\/widget\/chess\.mjs">/);
  assert.match(noRow, /<noscript>/);
  const withRow = widgetBlock({ use: 'chess' }, { row: { id: 3, name: 'x' } });
  assert.match(withRow, /data-row='\{&quot;id&quot;:3,&quot;name&quot;:&quot;x&quot;\}'/);
});

test('rowJSON drops secret fields, includes derived fields, and reads money in major units', () => {
  const g = { app: 'w', data: { U: { name: 'text!', password: 'password!', tip: 'money=0', ok: 'bool=false', net: 'money := tip * 2' } } };
  const s = new Store(g, ':memory:');
  const id = s.insert('U', { name: 'x', password: 'secret', tip: 5, ok: true });
  const json = rowJSON(s, 'U', s.fields.U, s.get('U', id));
  assert.deepEqual(json, { id, name: 'x', tip: 5, ok: true, net: 10 });
});

test('a page widget and a detail widget render through staticPage/detailView', () => {
  const g = { app: 'w', data: { Match: { name: 'text!' } }, override: { 'Match.detail': { widget: { use: 'chess', fen: 'abc' } } } };
  const s = new Store(g, ':memory:');
  const id = s.insert('Match', { name: 'final' });
  const detail = detailView(g, s, 'Match', s.fields.Match, s.get('Match', id));
  assert.match(detail, /data-widget="chess"/);
  assert.match(detail, /data-row=/);
  const staticHtml = staticPage(g, { id: 'p', title: 'P', widget: { use: 'chess', fen: 'abc' } });
  assert.match(staticHtml, /data-widget="chess"/);
  assert.ok(!/data-row=/.test(staticHtml));
});

test('mountWidgets finds every matching element and hands mount its props/row/api; api.get/post talk JSON', async () => {
  const calls = [];
  const fakeEl = (propsJson, rowJson) => ({ dataset: { props: propsJson, row: rowJson } });
  const fakeDoc = { querySelectorAll: () => [fakeEl('{"a":1}'), fakeEl('{"b":2}', '{"id":9}')] };
  mountWidgets('x', (el, ctx) => calls.push(ctx), fakeDoc);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].props, { a: 1 }); assert.equal(calls[0].row, undefined);
  assert.deepEqual(calls[1].row, { id: 9 }); assert.equal(calls[1].api, api);
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => ({ json: async () => ({ url, method: init?.method, body: init?.body }) });
    assert.deepEqual((await api.get('/x')).url, '/x');
    const posted = await api.post('/x', { a: 1, b: 'two' });
    assert.equal(posted.method, 'POST');
    assert.equal(posted.body, 'a=1&b=two');
  } finally { globalThis.fetch = real; }
});

test('server: /widget/<name>.mjs and /widget/_api.mjs are served, an unknown name is 404, nothing is reachable by path traversal', async () => {
  // "client" resolves against the app directory (like a plugin path), so this graph
  // lives in `dir` too — the same place as chess.mjs and chess.client.mjs.
  const graphFile = path.join(dir, 'app.json');
  fs.writeFileSync(graphFile, JSON.stringify({ app: 'w', plugins: ['./chess.mjs'], data: { Match: { name: 'text!' } },
    override: { 'Match.detail': { widget: { use: 'chess', fen: 'abc' } } } }));
  const s = await boot(graphFile);
  try {
    const w = await fetch(`${s.base}/widget/chess.mjs`);
    assert.equal(w.status, 200);
    assert.match(w.headers.get('content-type'), /javascript/);
    assert.match(await w.text(), /export default function mount/);
    const helper = await fetch(`${s.base}/widget/_api.mjs`);
    assert.equal(helper.status, 200);
    assert.match(await helper.text(), /export function mountWidgets/);
    assert.equal((await fetch(`${s.base}/widget/ghost.mjs`)).status, 404);
    assert.equal((await fetch(`${s.base}/widget/..%2f..%2fapp.json`)).status, 404, 'a name outside the registry is 404, never a file read');
    assert.equal((await fetch(`${s.base}/widget/chess.mjs`, { method: 'POST' })).status, 404, 'only GET is a widget file');
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// JSON answers: same permission checks, own scoping, secret fields dropped,
// derived fields included, the same status codes the HTML path uses.
// apps/tictactoe proves the whole path with a role-less app; this graph adds
// roles, own-scoping, a rule, a related child and a transition, so
// 403/409/own-scoping have something to answer for.
// ---------------------------------------------------------------------------
// `redirect: 'manual'` matters twice over: a followed redirect drops the very
// Set-Cookie header login() needs, and would otherwise re-request the
// redirect target (still carrying the JSON Accept header) and quietly hand
// back valid-but-wrong JSON instead of the login response.
function withCookies(base) {
  let cookie = '';
  const keep = (r) => { const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; };
  const raw = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), accept: 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    keep(r);
    return r;
  };
  const jget = async (p) => { const r = await raw('GET', p); return { status: r.status, body: await r.json() }; };
  const jpost = async (p, body = {}) => { const r = await raw('POST', p, body); return { status: r.status, body: await r.json() }; };
  const login = (l, p) => raw('POST', '/login', { login: l, password: p });
  const logout = () => { cookie = ''; };
  return { jget, jpost, login, logout };
}

const jsonGraph = {
  app: 'jsonapi',
  data: {
    User: { email: 'text!', password: 'password!', role: 'enum[admin,customer]=customer' },
    Order: { customer: 'ref:User!', total: 'money=0', status: 'enum[cart,placed]=cart', big: 'money := total * 2' },
    Item: { order: 'ref:Order!', qty: 'int=1' },
  },
  rules: { Order: [{ check: 'total >= 0', message: 'total must be non-negative' }] },
  roles: { entity: 'User', login: 'email', password: 'password', role: 'role',
    can: { admin: '*', customer: { Order: { own: 'customer', can: ['view', 'create', 'edit', 'delete'] } } } },
  seed: { User: [{ email: 'admin@x.test', password: 'adminpw', role: 'admin' },
    { email: 'ann@x.test', password: 'annpw' }, { email: 'bob@x.test', password: 'bobpw' }] },
  override: { 'Order.detail': { related: [{ entity: 'Item', via: 'order', title: 'Items' }] } },
  states: { Order: { field: 'status', transitions: [{ name: 'place', from: ['cart'], to: 'placed' }] } },
  actions: [{ name: 'ping', do: [{ block: 'db.createRow', entity: 'Order', values: { customer: '@me' } }] }],
};

test('JSON GET: anonymous is 403 with a body, own-scoping narrows a list, secret fields drop, derived fields stay', async () => {
  const s = await boot(tmpGraph(jsonGraph));
  try {
    const c = withCookies(s.base);
    const anon = await c.jget('/Order');
    assert.deepEqual(anon, { status: 403, body: { ok: false, status: 403, errors: ['Please sign in.'] } });
    await c.login('ann@x.test', 'annpw');
    const created = await c.jpost('/Order', { total: '100' });
    assert.equal(created.status, 200);
    assert.deepEqual(created.body, { ok: true, id: created.body.id, created: created.body.id,
      flash: 'Order saved successfully', row: { id: created.body.id, customer: '2', total: 100, status: 'cart', big: 200 } });
    c.logout(); await c.login('bob@x.test', 'bobpw');
    await c.jpost('/Order', { total: '5' });
    c.logout(); await c.login('ann@x.test', 'annpw');
    const list = await c.jget('/Order');
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 1, 'own scoping narrows the JSON list too');
    assert.equal(list.body.rows[0].total, 100);
    c.logout(); await c.login('admin@x.test', 'adminpw');
    const users = await c.jget('/User');
    assert.ok(users.body.rows.every((r) => !('password' in r)), 'a secret field never reaches JSON');
  } finally { s.close(); }
});

test('JSON POST: validation failure is 400 with the same messages, a wrong-status transition is 409, a related add and a global action answer JSON too', async () => {
  const s = await boot(tmpGraph(jsonGraph));
  try {
    const c = withCookies(s.base);
    await c.login('admin@x.test', 'adminpw');
    const bad = await c.jpost('/Order', { customer: '1', total: '-5' });
    assert.deepEqual(bad, { status: 400, body: { ok: false, status: 400, errors: ['total must be non-negative'] } });
    const made = await c.jpost('/Order', { customer: '1', total: '10' });
    const id = made.body.id;
    const wrongStatus = await c.jpost(`/Order/${id}/go/pay`, {});
    assert.equal(wrongStatus.status, 404, 'go/pay does not exist on this graph');
    const conflict = await c.jpost(`/Order/${id}/go/place`, {});
    assert.equal(conflict.status, 200);
    const again = await c.jpost(`/Order/${id}/go/place`, {});
    assert.equal(again.status, 409);
    assert.match(again.body.errors[0], /is not available from here/);
    const item = await c.jpost(`/Order/${id}/add/Item`, { qty: '3' });
    assert.deepEqual(item.body, { ok: true, id: item.body.id, created: item.body.id, flash: 'Item added successfully',
      row: { id: item.body.id, order: String(id), qty: 3 } });
    const ping = await c.jpost('/action/ping', {});
    assert.equal(ping.status, 200);
    assert.equal(ping.body.ok, true);
    assert.equal(typeof ping.body.created, 'number');
    const missing = await c.jget('/Order/999999');
    assert.deepEqual(missing.body, { ok: false, status: 404, errors: ['no Order #999999'] });
    const noRoute = await c.jpost('/Order/1/nonsense', {});
    assert.equal(noRoute.status, 404);
  } finally { s.close(); }
});

test('JSON PUT-like edit and delete answer {ok,row}/{ok}, and a viewer denied a row gets a 403 body, not the HTML page', async () => {
  const s = await boot(tmpGraph(jsonGraph));
  try {
    const c = withCookies(s.base);
    await c.login('ann@x.test', 'annpw');
    const made = await c.jpost('/Order', { total: '20' });
    const id = made.body.id;
    const edited = await c.jpost(`/Order/${id}`, { total: '30' });
    assert.deepEqual(edited.body, { ok: true, id, flash: 'Order updated successfully', row: { id, customer: '2', total: 30, status: 'cart', big: 60 } });
    c.logout(); await c.login('bob@x.test', 'bobpw');
    const denied = await c.jget(`/Order/${id}`);
    assert.deepEqual(denied, { status: 403, body: { ok: false, status: 403, errors: ['You are not allowed to do this.'] } });
    c.logout(); await c.login('ann@x.test', 'annpw');
    const deleted = await c.jpost(`/Order/${id}/delete`, {});
    assert.deepEqual(deleted.body, { ok: true, id, flash: 'Order deleted' });
  } finally { s.close(); }
});

test('a saved list and a dashboard answer JSON too (rows/total/page/pages, cards/tables/charts), money in major units', async () => {
  const g = { ...jsonGraph, data: { ...jsonGraph.data, Order: { ...jsonGraph.data.Order, createdAt: 'time=now' } },
    lists: [{ id: 'mine', entity: 'Order', title: 'Mine', where: { customer: '@me' } }],
    dashboards: [{ id: 'd', title: 'D', roles: ['admin'], period: { Order: 'createdAt' },
      cards: [{ title: 'Orders', entity: 'Order', fn: 'count' }, { title: 'Revenue', entity: 'Order', fn: 'sum', field: 'total' }],
      tables: [{ title: 'By status', entity: 'Order', groupBy: 'status', metrics: [{ fn: 'count', as: 'n' }, { fn: 'sum', field: 'total', as: 'revenue' }] }],
      charts: [{ title: 'By status', entity: 'Order', type: 'bar', groupBy: 'status', metric: { fn: 'sum', field: 'total' } }] }] };
  const s = await boot(tmpGraph(g));
  try {
    const c = withCookies(s.base);
    await c.login('ann@x.test', 'annpw');
    await c.jpost('/Order', { total: '10' });
    await c.jpost('/Order', { total: '20' });
    const list = await c.jget('/list/mine');
    assert.equal(list.status, 200);
    assert.equal(list.body.rows.length, 2);
    assert.equal(list.body.total, 2);
    c.logout(); await c.login('admin@x.test', 'adminpw');
    const dash = await c.jget('/dashboard/d');
    assert.equal(dash.status, 200);
    assert.equal(dash.body.cards[0].title, 'Orders');
    assert.equal(dash.body.cards[0].value, 2);
    // The bug this test guards: a card/table/chart money aggregate must
    // answer JSON in major units (30), like every other money field in the
    // JSON contract — not the raw minor-unit storage value (3000).
    assert.equal(dash.body.cards[1].title, 'Revenue');
    assert.equal(dash.body.cards[1].value, 30, 'a money card sum is major units, not minor');
    assert.ok(dash.body.tables[0].rows.length >= 1);
    assert.equal(dash.body.tables[0].rows[0].revenue, 30, 'a money table metric is major units, not minor');
    assert.ok(dash.body.charts[0].rows.length >= 1);
    assert.equal(dash.body.charts[0].rows[0].v, 30, 'a money chart metric is major units, not minor');
    // A period narrows a JSON dashboard exactly like the HTML one: both
    // in-range (from+to) and out-of-range are exercised, hitting the same
    // narrowing code the CSV export and the HTML view already share.
    const inRange = await c.jget('/dashboard/d?from=2000-01-01&to=2999-01-01');
    assert.equal(inRange.body.cards[0].value, 2);
    const outOfRange = await c.jget('/dashboard/d?from=2000-01-01&to=2000-01-02');
    assert.equal(outOfRange.body.cards[0].value, 0);
    assert.equal((await c.jget('/dashboard/ghost')).status, 404);
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// Charts: computed by the same store.aggregate() a table uses, checked the
// same way, rendered as an accessible SVG + a data table, included in CSV
// and JSON dashboard exports.
// ---------------------------------------------------------------------------
const salesGraph = { app: 'c', theme: { accent: 'teal' },
  data: { Sale: { region: 'enum[north,south]=north', at: 'date=today', amount: 'money=0' } } };

test('checker: chart type, groupBy/groupUnit, metric, where, limit, sort — same rules a table already gets', () => {
  const at = (chart) => validate({ ...salesGraph, dashboards: [{ id: 'd', title: 'D', charts: [chart] }] });
  const base = { title: 'T', entity: 'Sale', type: 'bar', groupBy: 'region', metric: { fn: 'sum', field: 'amount' } };
  assert.deepEqual(at(base), []);
  assert.match(at({ ...base, type: 'donut' })[0].message, /unknown chart type "donut"/);
  assert.match(at({ ...base, groupBy: undefined })[0].message, /needs "groupBy"/);
  assert.match(at({ ...base, groupUnit: 'week' })[0].message, /unknown unit "week"/);
  assert.match(at({ ...base, groupBy: 'region', groupUnit: 'month' })[0].message, /groupUnit needs a date or time groupBy/);
  assert.deepEqual(at({ ...base, groupBy: 'at', groupUnit: 'month' }), []);
  assert.match(at({ ...base, metric: { fn: 'nope' } })[0].message, /unknown function "nope"/);
  assert.match(at({ ...base, metric: { fn: 'sum' } })[0].message, /"sum" needs a field/);
  assert.match(at({ ...base, limit: 0 })[0].message, /limit must be a positive integer/);
  assert.match(at({ ...base, sort: { field: 'amount' } })[0].message, /sort must name "grp" or "v"/);
  assert.deepEqual(at({ ...base, sort: { field: 'v', dir: 'desc' } }), []);
  assert.match(at({ ...base, title: undefined })[0].message, /chart needs a title/);
});

test('chartBlock: bar and line share axes/labels, pie shares a total; every mark is paired with a direct text label', () => {
  const s = new Store(salesGraph, ':memory:');
  s.insert('Sale', { region: 'north', amount: 15 });
  s.insert('Sale', { region: 'south', amount: 20 });
  const chart = (type) => ({ title: 'By region', entity: 'Sale', type, groupBy: 'region', metric: { fn: 'sum', field: 'amount' } });
  const bar = chartBlock(s, chart('bar'), 'teal');
  assert.match(bar, /<svg role="img" aria-label="By region"/);
  assert.match(bar, /<title>By region<\/title>/);
  assert.match(bar, /<rect[^>]*fill="teal"[^>]*><title>North: 15\.00<\/title><\/rect>/);
  assert.match(bar, /<text[^>]*>20\.00<\/text>/, 'the y axis top label is money-formatted, not raw minor units');
  assert.match(bar, /<table class="chart-data">/);
  assert.match(bar, /<td>North<\/td><td>15\.00<\/td>/);
  const line = chartBlock(s, chart('line'), 'teal');
  assert.match(line, /<polyline fill="none" stroke="teal"/);
  assert.match(line, /<circle[^>]*fill="teal"[^>]*><title>South: 20\.00<\/title>/);
  const pie = chartBlock(s, chart('pie'), 'teal');
  assert.match(pie, /<path d="M/);
  assert.match(pie, /<title>North: 15\.00<\/title>/);
  assert.match(pie, /<td>South<\/td><td>20\.00<\/td>/, 'the same numbers follow the SVG as a table, whatever the chart type');
});

test('a dashboard with only charts still renders, and an empty chart divides by zero safely', () => {
  const s = new Store(salesGraph, ':memory:');
  const html = dashboardView(salesGraph, s, { id: 'd', title: 'D',
    charts: [{ title: 'Empty', entity: 'Sale', type: 'pie', groupBy: 'region', metric: { fn: 'count' } }] }, '');
  assert.match(html, /<h3>Empty<\/h3>/);
  assert.match(html, /<table class="chart-data">/);
});

test('CSV export includes chart rows alongside cards and tables', async () => {
  const g = { ...salesGraph, dashboards: [{ id: 'd', title: 'D',
    charts: [{ title: 'By region', entity: 'Sale', type: 'bar', groupBy: 'region', metric: { fn: 'sum', field: 'amount' } }] }] };
  const s = await boot(tmpGraph(g));
  try {
    await s.post('/Sale', { region: 'north', amount: '15' });
    const csv = await s.get('/dashboard/d.csv');
    assert.match(csv.html, /By region,sum,north,15\.00/);
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// Auto-refresh: pages[].refresh / dashboards[].refresh (seconds) -> a meta tag.
// ---------------------------------------------------------------------------
test('checker: refresh must be a positive integer, on a page and on a dashboard', () => {
  const g = { app: 'r', data: { A: { n: 'int' } } };
  const at = (extra) => validate({ ...g, ...extra });
  assert.match(at({ pages: [{ id: 'p', title: 'P', refresh: 0 }] })[0].message, /refresh must be a positive integer/);
  assert.match(at({ pages: [{ id: 'p', title: 'P', refresh: 'soon' }] })[0].message, /refresh must be a positive integer/);
  assert.deepEqual(at({ pages: [{ id: 'p', title: 'P', refresh: 30 }] }), []);
  assert.match(at({ dashboards: [{ id: 'd', title: 'D', refresh: -1 }] })[0].message, /refresh must be a positive integer/);
  assert.deepEqual(at({ dashboards: [{ id: 'd', title: 'D', refresh: 5 }] }), []);
});

test('a page and a dashboard render <meta http-equiv="refresh"> only when declared', () => {
  const g = { app: 'r', data: { A: { n: 'int' } } };
  const s = new Store(g, ':memory:');
  assert.match(staticPage(g, { id: 'p', title: 'P', refresh: 15 }), /<meta http-equiv="refresh" content="15">/);
  assert.ok(!/http-equiv="refresh"/.test(staticPage(g, { id: 'p', title: 'P' })), 'no refresh meta without "refresh"');
  assert.match(dashboardView(g, s, { id: 'd', title: 'D', refresh: 60 }, ''), /<meta http-equiv="refresh" content="60">/);
});

// ---------------------------------------------------------------------------
// Schedule: a new top-level node kind. The checker validates "every" and the
// steps; the server runs each on a timer (proven live, once, with a 1s
// interval — everywhere else `noTimers: true` keeps the suite deterministic
// and fast); POST /schedule/<name>/run triggers one by hand, gated exactly
// like /outbox (an operator, or anyone when the app has no roles).
// ---------------------------------------------------------------------------
test('everyMs/validEvery: every unit, and the rejected shapes', () => {
  assert.equal(everyMs('5m'), 5 * 60_000);
  assert.equal(everyMs('30s'), 30_000);
  assert.equal(everyMs('2h'), 2 * 3_600_000);
  assert.equal(everyMs('1d'), 86_400_000);
  assert.equal(everyMs('weekly'), null);
  assert.equal(everyMs(undefined), null);
  assert.equal(validEvery('5m'), true);
  assert.equal(validEvery('0m'), false, 'zero is not a positive count');
  assert.equal(validEvery('5w'), false, 'weeks are not a unit');
});

test('checker: schedule needs a name (unique), a valid "every", and at least one step', () => {
  const at = (schedule) => validate({ app: 's', data: { A: { n: 'int=0' } }, schedule });
  const tick = { name: 'tick', every: '5m', do: [{ block: 'db.adjust', entity: 'A', id: 1, field: 'n', by: 1 }] };
  assert.deepEqual(at([tick]), []);
  assert.match(at([{ ...tick, name: undefined }])[0].message, /schedule needs a name/);
  assert.match(at([tick, tick])[0].message, /"tick" is declared twice/);
  assert.match(at([{ ...tick, every: 'weekly' }])[0].message, /"every" must be <n>s\|m\|h\|d/);
  assert.match(at([{ ...tick, do: [] }])[0].message, /schedule needs at least one step/);
  assert.match(at([{ ...tick, do: [{ block: 'nope' }] }])[0].message, /unknown block "nope"/, 'steps are checked exactly like an action\'s');
});

test('POST /schedule/<name>/run executes the steps inside a transaction, traced, admin-gated like /outbox, and 404 for an unknown name', async () => {
  const g = { app: 's', data: {
    User: { email: 'text!', password: 'password!', role: 'enum[admin,customer]=customer' },
    Counter: { n: 'int=0' } },
    roles: { entity: 'User', login: 'email', password: 'password', role: 'role',
      can: { admin: '*', customer: { Counter: ['view'] } } },
    seed: { User: [{ email: 'admin@s.test', password: 'adminpw', role: 'admin' }, { email: 'cust@s.test', password: 'custpw' }],
      Counter: [{ n: 0 }] },
    schedule: [{ name: 'tick', every: '1h', do: [{ block: 'db.adjust', entity: 'Counter', id: 1, field: 'n', by: 1 }] }] };
  const s = await boot(tmpGraph(g), { noTimers: true });
  try {
    assert.equal((await s.post('/schedule/tick/run', {})).status, 403, 'anonymous may not run a schedule by hand');
    await s.login('cust@s.test', 'custpw');
    assert.equal((await s.post('/schedule/tick/run', {})).status, 403, 'a non-admin role may not either');
    await s.asGuest(); await s.login('admin@s.test', 'adminpw');
    const first = await s.post('/schedule/tick/run', {});
    assert.equal(first.status, 303);
    assert.match(first.location, /^\/\?ok=Ran%20%22tick%22$/);
    assert.equal(s.app.store.get('Counter', 1).n, 1);
    assert.equal((await s.post('/schedule/ghost/run', {})).status, 404);
    assert.ok(s.trace().some((e) => e.kind === 'schedule' && e.name === 'tick' && e.manual === true));
  } finally { s.close(); }
});

test('a role-less app lets anyone run a schedule by hand, and a JSON request gets a JSON answer', async () => {
  const g = { app: 's', data: { Counter: { n: 'int=0' } }, seed: { Counter: [{ n: 0 }] },
    schedule: [{ name: 'tick', every: '1h', do: [{ block: 'db.adjust', entity: 'Counter', id: 1, field: 'n', by: 1 }] }] };
  const s = await boot(tmpGraph(g), { noTimers: true });
  try {
    const r = await fetch(`${s.base}/schedule/tick/run`, { method: 'POST', headers: { accept: 'application/json' } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, flash: 'Ran "tick"' });
    assert.equal(s.app.store.get('Counter', 1).n, 1);
  } finally { s.close(); }
});

test('a declared timer really fires on its own, unref\'d, and stops when the server closes', async () => {
  const g = { app: 's', data: { Counter: { n: 'int=0' } }, seed: { Counter: [{ n: 0 }] },
    schedule: [{ name: 'tick', every: '1s', do: [{ block: 'db.adjust', entity: 'Counter', id: 1, field: 'n', by: 1 }] }] };
  const s = await boot(tmpGraph(g)); // noTimers defaults to false: this is the one test that waits on a real timer
  try {
    assert.equal(s.app.store.get('Counter', 1).n, 0);
    await new Promise((r) => setTimeout(r, 1100));
    assert.ok(s.app.store.get('Counter', 1).n >= 1, 'the timer fired without any request');
    assert.ok(s.trace().some((e) => e.kind === 'schedule' && e.manual === false));
  } finally { s.close(); }
});

// ---------------------------------------------------------------------------
// The shared messaging plugin: sms/whatsapp transports and the sms.send block.
// ---------------------------------------------------------------------------
const msgGraph = { app: 'm', data: { Lead: { phone: 'text!' } },
  connectors: { alert: { kind: 'sms', from: '+15551234567' }, wa: { kind: 'whatsapp', from: '+15557654321' }, mailer: { kind: 'mail', from: 'x@y.test' } } };
const msgCtx = (store, extra) => ({ store, graph: msgGraph, resolve: (o) => o, text: (t) => t, ...extra });

test('messaging: an E.164-ish "from" is required for sms and whatsapp alike', () => {
  assert.deepEqual(messaging.transports.sms.validate({ from: '+15551234567' }), []);
  assert.deepEqual(messaging.transports.whatsapp.validate({ from: '+15551234567' }), []);
  assert.match(messaging.transports.sms.validate({ from: '12345' })[0][1], /needs "from" as an E\.164 number/);
  assert.match(messaging.transports.sms.validate({})[0][1], /needs "from"/);
});

test('checker: sms.send needs a declared connector of the right kind', async () => {
  const graph = (connector) => ({ ...msgGraph, plugins: [path.resolve('plugins/messaging.mjs')],
    connectors: { c: connector }, actions: [{ name: 'a', in: 'Lead', do: [{ block: 'sms.send', connector: 'c', to: '@row.phone', text: 'hi' }] }] });
  const at = async (connector) => { const g = graph(connector); const { registry } = await loadPlugins(g, process.cwd()); return validate(g, registry); };
  assert.deepEqual(await at({ kind: 'sms', from: '+15551234567' }), []);
  assert.deepEqual(await at({ kind: 'whatsapp', from: '+15551234567' }), []);
  const bad = await at({ kind: 'mail', from: 'x@y.test' });
  assert.match(bad.find((e) => e.path.endsWith('/connector')).message, /needs an sms or whatsapp connector/);
});

test('sms.send validates "to" and "text" at run time, and interpolates {row.field}', () => {
  const store = new Store(msgGraph, ':memory:');
  const lead = store.insert('Lead', { phone: '+15559876543' });
  const text = (t) => t.replace('{row.phone}', '+15559876543');
  const ok = messaging.blocks['sms.send'].run(msgCtx(store, { entity: 'Lead', id: lead,
    step: { connector: 'alert', to: '@row.phone', text: 'Hi {row.phone}' }, resolve: () => ({ v: '+15559876543' }), text }));
  const row = store.outboxGet(ok.delivery);
  assert.equal(row.kind, 'sms'); assert.equal(row.target, '+15559876543');
  assert.deepEqual(row.payload, { from: '+15551234567', to: '+15559876543', text: 'Hi +15559876543' });
  assert.throws(() => messaging.blocks['sms.send'].run(msgCtx(store, { step: { connector: 'alert', to: 'notaphone', text: 'hi' }, resolve: () => ({ v: 'notaphone' }), text: () => 'hi' })),
    /"to" must be an E\.164 number/);
  assert.throws(() => messaging.blocks['sms.send'].run(msgCtx(store, { step: { connector: 'alert', to: '+15559876543', text: '  ' }, resolve: () => ({ v: '+15559876543' }), text: () => '   ' })),
    /"text" cannot be empty/);
});

test('an app can queue sms/whatsapp alerts end to end, visible in /outbox', async () => {
  const g = { ...msgGraph, plugins: [path.resolve('plugins/messaging.mjs')],
    actions: [{ name: 'alert', in: 'Lead', confirm: 'sent', do: [{ block: 'sms.send', connector: 'alert', to: '@row.phone', text: 'Hi {row.phone}' }] }] };
  const s = await boot(tmpGraph(g));
  try {
    const id = await (async () => { await s.post('/Lead', { phone: '+15559876543' }); return rows((await s.get('/Lead')).html).length; })();
    assert.equal(id, 1);
    const r = await s.follow('/Lead/1/action/alert', {});
    assert.match(r.html, /sent/);
    const [delivery] = s.app.store.outbox({ kind: 'sms' });
    assert.equal(delivery.status, 'sent');
    assert.equal(delivery.payload.text, 'Hi +15559876543');
  } finally { s.close(); }
});
