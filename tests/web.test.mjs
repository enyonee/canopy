// F2: an app that declares "web" serves its built front at / and its scaffold under /admin. The checker's shape of
// `web`, the front's files (types, caching, no listing, no traversal, the SPA fallback), the reserved root names, the
// scaffold rewritten for its base (links, forms, redirects, login, register, outbox, settings, widgets, files) while
// its JSON answers stay as they were, and the refusal to start when the front was never built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { boot, tmpDir } from './helpers.mjs';
import { validate } from '../runtime/validate.mjs';
import { serve } from '../runtime/server.mjs';
import { RESERVED, SCAFFOLD, locate, webProblems, webRoot, openFront } from '../runtime/web.mjs';
import { rebase, rebaseTo } from '../runtime/routes/context.mjs';
import { withBase } from '../runtime/routes/widgets.mjs';

const FIXTURE = 'tests/fixtures/web';
const GRAPH = JSON.parse(fs.readFileSync(`${FIXTURE}/app.json`, 'utf8'));

// The fixture copied where a test may add symlinks, directories and files to its front.
function copyFixture(t, edit = (g) => g) {
  const dir = tmpDir('ag-web-', t);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify(edit(structuredClone(GRAPH))));
  return { dir, file, dist: path.join(dir, 'web/dist') };
}

// A request exactly as written: fetch and URL normalise `..` before anything is sent.
const raw = (base, p, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: p, headers }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  }).on('error', reject);
});

const errorsAt = (web) => validate({ ...GRAPH, web }).filter((e) => e.path === '/web');

test('web: the checker takes a relative directory below the app and names every other shape', () => {
  for (const ok of ['web/dist', './web/dist/', 'dist', 'front/build/out']) assert.deepEqual(errorsAt(ok), [], ok);
  assert.deepEqual(validate(GRAPH), [], 'the fixture is valid');
  const one = (web, re) => { const e = errorsAt(web); assert.equal(e.length, 1, JSON.stringify(web)); assert.match(e[0].message, re); assert.match(e[0].hint, /web\/dist/); };
  one(42, /non-empty string/);
  one('', /non-empty string/);
  one('   ', /non-empty string/);
  one('/srv/front', /absolute path/);
  one('C:/front', /absolute path/);
  one('web\\dist', /backslash/);
  one('web/\u0000dist', /control character/);
  one('../front', /leaves the app directory/);
  one('web/../../front', /leaves the app directory/);
  one('.', /app directory itself/);
  one('./', /app directory itself/);
  assert.match(validate({ ...GRAPH, wbe: 1 }).find((e) => e.path === '/wbe').hint, /did you mean: web\b/);
});

test('web: locate reads only files inside the front — dot-names, encoded separators, NUL, directories, symlinks out', (t) => {
  const { dir, dist } = copyFixture(t);
  const real = fs.realpathSync(dist);
  fs.mkdirSync(path.join(dist, 'a'));
  fs.writeFileSync(path.join(dist, 'a/b'), 'nested');
  fs.symlinkSync(path.join(dir, 'app.json'), path.join(dist, 'out.json'));
  fs.symlinkSync(dir, path.join(dist, 'up'));
  fs.symlinkSync(path.join(dist, 'style.css'), path.join(dist, 'alias.css'));
  assert.equal(locate(real, '/'), path.join(real, 'index.html'));
  assert.equal(locate(real, '/style.css'), path.join(real, 'style.css'));
  assert.equal(locate(real, '/a/b'), path.join(real, 'a/b'));
  assert.equal(locate(real, '/alias.css'), path.join(real, 'style.css'), 'a symlink that stays inside is followed');
  for (const p of ['/../app.json', '/a/../../app.json', '/%2e%2e/app.json', '/.env', '/%2Eenv', '/a%2fb', '/a%5cb', '/a%00', '/%E0%A4%A',
    '/missing.js', '/a', '/assets', '/out.json', '/up/app.json'])
    assert.equal(locate(real, p), null, p);
});

test('web: the front is served at / — types, caching, ETag, HEAD, no listing', async (t) => {
  const s = await boot(`${FIXTURE}/app.json`);
  t.after(s.close);
  const index = await s.get('/');
  assert.equal(index.status, 200);
  assert.match(index.html, /<div id="root"><\/div>/);
  assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(index.headers.get('set-cookie'), null, 'a file of the front opens no session');
  const etag = index.headers.get('etag');
  assert.match(etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  const again = await s.get('/', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.html, '');
  assert.equal((await s.get('/', { 'if-none-match': 'W/"0-0"' })).status, 200);

  const js = await s.get('/assets/index-Ab3dEf9h.js');
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'a hashed asset is cached for good');
  assert.equal(js.html, 'console.log("front");\n');
  const css = await s.get('/style.css');
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(css.headers.get('cache-control'), 'no-cache', 'an unhashed file is revalidated');
  assert.equal((await s.get('/logo.svg')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await s.get('/data.bin')).headers.get('content-type'), 'application/octet-stream');

  const head = await fetch(`${s.base}/style.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(fs.statSync(`${FIXTURE}/web/dist/style.css`).size));
  assert.equal(await head.text(), '');

  const listing = await s.get('/assets/');
  assert.equal(listing.html, index.html, 'a directory is never listed: its path is a navigation, the SPA answers it');
});

test('web: the SPA fallback answers navigations only — not files, not JSON, not other methods', async (t) => {
  const s = await boot(`${FIXTURE}/app.json`);
  t.after(s.close);
  for (const p of ['/products', '/products/42', '/account/orders?page=2', '/Product'])
    assert.match((await s.get(p)).html, /<div id="root">/, p);
  const missing = await s.get('/missing.js');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(missing.html, /no file \/missing\.js in the front/);
  const json = await s.get('/products/42', { accept: 'application/json' });
  assert.equal(json.status, 404);
  assert.deepEqual(JSON.parse(json.html), { ok: false, status: 404, errors: ['no file /products/42 in the front'] });
  const post = await s.post('/products', { a: 1 });
  assert.equal(post.status, 405);
  assert.match(post.html, /the front only serves files/);
  assert.equal((await fetch(`${s.base}/products`, { method: 'DELETE' })).headers.get('allow'), 'GET, HEAD');
});

test('web: no path leaves the front — `..`, encoded dots and separators, dot-files, symlinks out', async (t) => {
  const { dir, file, dist } = copyFixture(t);
  fs.symlinkSync(path.join(dir, 'app.json'), path.join(dist, 'out.json'));
  fs.symlinkSync(dir, path.join(dist, 'up'));
  const s = await boot(file);
  t.after(s.close);
  const secret = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).roles);
  for (const p of ['/../app.json', '/../../app.json', '/%2e%2e/app.json', '/..%2fapp.json', '/..%2f..%2fapp.json', '/..%5capp.json',
    '/.%2e/app.json', '/out.json', '/up/app.json', '/up/data.sqlite', '/.env', '/%2eenv', '/web/dist/../../app.json', '/%E0%A4%A']) {
    const r = await raw(s.base, p);
    assert.notEqual(r.status, 500, p);
    assert.ok(!r.body.includes('"entity":"User"') && !r.body.includes(secret.slice(0, 20)) && !r.body.includes('not served'), `${p} leaked: ${r.body.slice(0, 80)}`);
  }
  assert.equal((await raw(s.base, '/out.json')).status, 404);
});

test('web: only admin, api, hook, file and widget answer at the root; every other name is the front\'s', async (t) => {
  const s = await boot(`${FIXTURE}/app.json`);
  t.after(s.close);
  assert.deepEqual(RESERVED, ['admin', 'api', 'hook', 'file', 'widget']);
  for (const p of ['/login', '/register', '/search?q=a', '/list/x', '/dashboard/3', '/page/about', '/settings', '/outbox', '/action/x', '/schedule/x'])
    assert.match((await s.get(p)).html, /<div id="root">/, `${p} is a navigation of the front`);
  assert.equal((await s.post('/login', { login: 'admin@x.test', password: 'secret' })).status, 405, 'the scaffold\'s login is not at the root');
  assert.equal((await s.post('/schedule/x/run')).status, 405);
  const hook = await s.post('/hook/nobody', {});
  assert.deepEqual([hook.status, JSON.parse(hook.html)], [404, { ok: false, error: 'not_found' }], 'a webhook keeps its root address');
  const api = await s.get('/api/anything');
  assert.doesNotMatch(api.html, /<div id="root">/, '/api is never the SPA');
  assert.match((await s.get('/administrator')).html, /<div id="root">/, 'only the exact segment is the scaffold');
});

test('web: the scaffold is under /admin — login, redirects with ?ok=, links and forms all carry the base', async (t) => {
  const s = await boot(`${FIXTURE}/app.json`);
  t.after(s.close);
  assert.equal((await s.get('/admin')).location, '/admin/login?next=%2F', 'the gate sends a signed-out visitor to the scaffold\'s login');
  assert.equal((await s.get('/admin/Product')).location, '/admin/login?next=%2FProduct');
  const form = await s.get('/admin/login');
  assert.equal(form.status, 200);
  assert.match(form.html, /<form class="card" method="post" action="\/admin\/login">/);
  assert.match(form.html, /href="\/admin\/register"/);
  assert.doesNotMatch(form.html, /(?:href|action|src)="\/(?!admin\/)/, 'no root-absolute link is left');
  const wrong = await s.post('/admin/login', { login: 'admin@x.test', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.html, /action="\/admin\/login"/);
  const r = await s.post('/admin/login', { login: 'admin@x.test', password: 'secret', next: '/Product' });
  assert.equal(r.location, '/admin/Product?ok=Welcome%2C%20admin%40x.test');
  const home = await s.get('/admin/');
  assert.equal(home.location, '/admin/page/about');
  const about = await s.get('/admin/page/about');
  assert.match(about.html, /<a class="btn" href="\/admin\/Product">Products<\/a>/, 'a link the graph wrote gets the base too');
  assert.match(about.html, /action="\/admin\/action\/ping"/);
  const list = await s.get('/admin/Product');
  assert.match(list.html, /href="\/admin\/Product\/1\/edit"/);
  assert.match(list.html, /href="\/admin\/Product\/new"/);
  assert.match(list.html, /href="\/admin\/Product\.csv"/);
  assert.match(list.html, /href="\/admin\/outbox">Outbox/);
  assert.match(list.html, /action="\/admin\/logout"/);
  assert.doesNotMatch(list.html, /(?:href|action|src)="\/(?!admin\/)/);
  const created = await s.post('/admin/Product', { name: 'Cup', price: '2.50' });
  assert.equal(created.status, 303);
  assert.match(created.location, /^\/admin\/Product\?ok=/);
  const csv = await s.get('/admin/Product.csv');
  assert.match(csv.html, /Cup/);
  const ping = await s.post('/admin/action/ping');
  assert.match(ping.location, /^\/admin\/\?ok=|^\/admin\/$/);
  const outbox = await s.get('/admin/outbox');
  assert.equal(outbox.status, 200);
  assert.match(outbox.html, /<td>hook<\/td>|>hook</, 'the ping\'s delivery is listed');
  assert.doesNotMatch(outbox.html, /(?:href|action|src)="\/(?!admin\/)/);
  const settings = await s.get('/admin/settings');
  assert.equal(settings.status, 200);
  assert.doesNotMatch(settings.html, /(?:href|action|src)="\/(?!admin\/)/);
  const out = await s.post('/admin/logout');
  assert.equal(out.location, '/admin/?ok=Signed%20out');
  assert.match((await s.get('/')).html, /<div id="root">/, 'the root is still the front');
});

test('web: register under /admin lands on /admin, and a denied page links the scaffold\'s login', async (t) => {
  const s = await boot(`${FIXTURE}/app.json`);
  t.after(s.close);
  const page = await s.get('/admin/register');
  assert.match(page.html, /action="\/admin\/register"/);
  const r = await s.post('/admin/register', { email: 'c@x.test', password: 'pw' });
  assert.equal(r.location, '/admin/?ok=Welcome%2C%20c%40x.test');
  const denied = await s.get('/admin/outbox');
  assert.equal(denied.status, 403);
  assert.doesNotMatch(denied.html, /(?:href|action|src)="\/(?!admin\/)/);
  const json = await s.get('/admin/outbox', { accept: 'application/json' });
  assert.deepEqual(JSON.parse(json.html), { ok: false, status: 403, errors: ['You are not allowed to do this.'] });
});

test('web: the scaffold\'s answers are the app\'s own answers, only rebased — JSON byte for byte, HTML up to the base', async (t) => {
  const plain = copyFixture(t, (g) => { delete g.web; return g; });
  const a = await boot(plain.file);
  const b = await boot(`${FIXTURE}/app.json`);
  t.after(() => { a.close(); b.close(); });
  await a.login('admin@x.test', 'secret');
  await b.post('/admin/login', { login: 'admin@x.test', password: 'secret' });
  const json = { accept: 'application/json' };
  for (const p of ['/Product', '/Product/1', '/Product/new', '/Product/1/edit', '/page/about', '/outbox', '/settings', '/User', '/Product/9']) {
    const [x, y] = [await a.get(p), await b.get(`${SCAFFOLD}${p}`)];
    assert.equal(y.status, x.status, p);
    assert.equal(y.html, rebase(x.html, SCAFFOLD), `${p}: the HTML is the same page with the base in its links`);
    const [xj, yj] = [await a.get(p, json), await b.get(`${SCAFFOLD}${p}`, json)];
    assert.equal(yj.status, xj.status, p);
    if (xj.headers.get('content-type').startsWith('application/json')) assert.equal(yj.html, xj.html, `${p}: the JSON answer is byte-identical`);
    else assert.equal(yj.html, rebase(xj.html, SCAFFOLD), `${p}: a screen with no JSON form is the rebased page`);
  }
  const [x, y] = [await a.post('/Product', { name: 'Pot' }, json), await b.post('/admin/Product', { name: 'Pot' }, json)];
  assert.equal(y.html, x.html, 'a JSON POST under /admin answers what it answered at the root');
});

test('web: /api and /admin live side by side — the API at the root, unchanged, and JSON under /admin', async (t) => {
  const plain = copyFixture(t, (g) => { delete g.web; return g; });
  const a = await boot(plain.file);
  const b = await boot(`${FIXTURE}/app.json`);
  t.after(() => { a.close(); b.close(); });
  for (const s of [a, b]) {
    const r = await s.json('/api/login', { login: 'admin@x.test', password: 'secret' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('location'), null, '/api/login answers JSON, never a redirect into the scaffold');
  }
  for (const p of ['/api/Product', '/api/Product/1', '/api/me', '/api/openapi.json', '/api/Ghost', '/api/outbox'])
    assert.equal((await b.get(p)).html, (await a.get(p)).html, `${p}: the same API with and without a front`);
  const [x, y] = [await a.json('/api/Product', { name: 'Pan', price: 3 }), await b.json('/api/Product', { name: 'Pan', price: 3 })];
  assert.deepEqual([y.status, y.text], [x.status, x.text], 'a POST to /api is the same with a front');
  assert.equal(y.headers.get('location'), null);
  const accept = { accept: 'application/json' };
  const viaAdmin = await b.get('/admin/Product', accept);
  assert.equal(viaAdmin.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(viaAdmin.html, (await a.get('/Product', accept)).html, 'Accept-JSON of the old address works under /admin');
  assert.equal(JSON.parse((await b.get('/api/Product')).html).total, JSON.parse(viaAdmin.html).total, 'one session for /api and /admin');
  const refused = await b.json('/api/Product', { name: 'X' }, { origin: 'http://evil.test' });
  assert.equal(refused.status, 403, 'the Origin check of /api holds with a front');
});

test('web: uploads are served at /file and /admin/file, the widget helper at /widget and /admin/widget, with the base', async (t) => {
  const s = await boot(`${FIXTURE}/app.json`);
  t.after(s.close);
  await s.post('/admin/login', { login: 'admin@x.test', password: 'secret' });
  const up = await s.upload('/admin/Product', { name: 'Pic' }, { field: 'photo', name: 'p.png', content: 'PNGDATA' });
  assert.equal(up.status, 303);
  const detail = await s.get('/admin/Product/2');
  assert.match(detail.html, /href="\/admin\/file\/Product\/2\/photo"/);
  assert.match(detail.html, /src="\/admin\/file\/Product\/2\/photo\?inline=1"/);
  assert.equal((await s.get('/admin/file/Product/2/photo')).html, 'PNGDATA');
  assert.equal((await s.get('/file/Product/2/photo')).html, 'PNGDATA', 'a front links an upload by its root path');
  const missing = await s.get('/file/Product/1/photo');
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.html, /(?:href|action|src)="\/(?!admin\/)/, 'an error page at /file is the scaffold\'s');
  for (const p of ['/widget/_api.mjs', '/admin/widget/_api.mjs']) {
    const js = await s.get(p);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(js.html, /^const BASE = "\/admin";$/m, p);
  }
});

test('web: a widget on a scaffold page loads from /admin and its api reaches /admin', async (t) => {
  const dir = tmpDir('ag-web-ttt-', t);
  fs.cpSync('apps/tictactoe', dir, { recursive: true, filter: (f) => !/data\.sqlite|trace\.jsonl|session\.key/.test(f) });
  fs.cpSync(`${FIXTURE}/web`, path.join(dir, 'web'), { recursive: true });
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), web: 'web/dist' }));
  const s = await boot(file);
  t.after(s.close);
  await s.post('/admin/Game', {});
  const page = await s.get('/admin/Game/1');
  assert.match(page.html, /<script type="module" src="\/admin\/widget\/ttt\.mjs"><\/script>/);
  for (const p of ['/admin/widget/ttt.mjs', '/widget/ttt.mjs']) assert.match((await s.get(p)).html, /from '\/widget\/_api\.mjs'/, p);
  const helper = (await s.get('/widget/_api.mjs')).html;
  const mod = await import(`data:text/javascript,${encodeURIComponent(helper)}`);
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(url); return { json: async () => ({}) }; };
  try {
    await mod.api.post('/Game/1/action/move', { cell: 0 });
    await mod.api.get('/Game/1');
    await mod.api.get('//elsewhere.test/x');
    await mod.api.get('https://elsewhere.test/x');
    await mod.api.get('relative/x');
  } finally { globalThis.fetch = real; }
  assert.deepEqual(seen, ['/admin/Game/1/action/move', '/admin/Game/1', '//elsewhere.test/x', 'https://elsewhere.test/x', 'relative/x']);
});

test('web: without "web" nothing moves — the scaffold at /, the helper\'s BASE empty, no /admin', async (t) => {
  const plain = copyFixture(t, (g) => { delete g.web; return g; });
  const s = await boot(plain.file);
  t.after(s.close);
  assert.equal((await s.get('/')).location, '/login?next=%2F');
  assert.match((await s.get('/widget/_api.mjs')).html, /^const BASE = '';$/m);
  assert.equal((await s.get('/admin')).location, '/login?next=%2Fadmin', 'no /admin: it is just a path the gate guards');
  assert.equal(withBase('const BASE = \'\';\nx', ''), 'const BASE = \'\';\nx');
  assert.equal(withBase('const BASE = \'\';\nx', '/admin'), 'const BASE = "/admin";\nx');
});

test('web: rebase rewrites root-absolute attributes only; rebaseTo leaves other hosts and relative targets', () => {
  const html = '<a href="/x">x</a><a href="//e.test">e</a><a href="/\\e.test">e</a><a href="https://e.test/">e</a><a href="#top">t</a>'
    + '<form method="post" action="/Product"><button formaction="/Product/1/delete"></button></form><img src="/file/P/1/a?inline=1">'
    + '<p data-props=\'{"to":"/x"}\'>href=&quot;/x&quot;</p><a href="?page=2">2</a><a class="btn" href="/">home</a>';
  assert.equal(rebase(html, '/admin'), '<a href="/admin/x">x</a><a href="//e.test">e</a><a href="/\\e.test">e</a><a href="https://e.test/">e</a><a href="#top">t</a>'
    + '<form method="post" action="/admin/Product"><button formaction="/admin/Product/1/delete"></button></form><img src="/admin/file/P/1/a?inline=1">'
    + '<p data-props=\'{"to":"/x"}\'>href=&quot;/x&quot;</p><a href="?page=2">2</a><a class="btn" href="/admin/">home</a>');
  assert.equal(rebaseTo('/Product?ok=Saved', '/admin'), '/admin/Product?ok=Saved');
  assert.equal(rebaseTo('/', '/admin'), '/admin/');
  for (const to of ['//evil.test', '/\\evil.test', 'https://pay.test/checkout', 'next']) assert.equal(rebaseTo(to, '/admin'), to);
});

test('web: a front that was never built stops the start with the path and the way out; --check does not ask', async (t) => {
  const { dir, file, dist } = copyFixture(t);
  fs.rmSync(dist, { recursive: true });
  const problems = webProblems(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, '/web');
  assert.match(problems[0].message, new RegExp(`${path.join(dir, 'web/dist/index.html').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} not found`));
  assert.match(problems[0].hint, /must contain index\.html.*or remove "web"/);
  assert.deepEqual(validate(GRAPH), [], 'the graph itself stays valid: a front is built after its graph is written');
  fs.mkdirSync(path.join(dist, 'index.html'), { recursive: true });
  assert.equal(webProblems(file, GRAPH).length, 1, 'a directory named index.html is not a built front');
  const errors = console.error;
  console.error = () => {};
  t.after(() => { console.error = errors; });
  const app = serve({ graphFile: file, dbFile: path.join(dir, 'data.sqlite'), port: 0 });
  await Promise.all([once(app.server, 'listening'), app.ready]);
  t.after(() => app.server.close());
  assert.equal(app.invalid, true);
  assert.equal(fs.existsSync(path.join(dir, 'data.sqlite')), false, 'no database is made for a front that cannot be served');
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/anything`);
  assert.equal(r.status, 500);
  assert.match(await r.text(), /\/web: .*index\.html not found/);
  assert.equal(webRoot(file, GRAPH), dist);
});

test('web: a front file that cannot be read is a 500 and a trace line, not a crash', async (t) => {
  const { file, dist } = copyFixture(t);
  const s = await boot(file);
  t.after(s.close);
  fs.rmSync(path.join(dist, 'index.html'));
  fs.mkdirSync(path.join(dist, 'index.html'));
  const r = await s.get('/somewhere');
  assert.equal(r.status, 500);
  assert.equal(r.html, 'the front could not be read');
  assert.ok(s.trace().some((e) => e.kind === 'error' && /EISDIR/.test(e.message)));
  assert.equal((await s.get('/style.css')).status, 200, 'the server keeps serving');
});

test('web: openFront hands the scaffold back with its base, stripped of /admin', () => {
  const route = openFront(`${FIXTURE}/web/dist`);
  const at = (p) => route({ method: 'GET', headers: {} }, null, new URL(`http://x${p}`));
  assert.deepEqual(at('/admin').url.pathname, '/');
  assert.deepEqual(at('/admin/').url.pathname, '/');
  assert.deepEqual(at('/admin/Product/1?x=1').url.href, 'http://x/Product/1?x=1');
  assert.equal(at('/admin/x').base, '/admin');
  assert.deepEqual([at('/api/x').base, at('/api/x').url.pathname], ['', '/api/x']);
  assert.deepEqual([at('/hook/x').base, at('/file/P/1/a').base, at('/widget/a.mjs').base], ['', '/admin', '/admin']);
});
