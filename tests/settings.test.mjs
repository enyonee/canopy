// C7, the connector settings screen (GET /settings and its POSTs): what an admin sees per connector, how a secret is set,
// replaced and removed without its value ever coming back out (HTML, JSON, redirect, error pages, trace, database files),
// the guards (admin only, same-origin POSTs only, send test in sandbox mode only), and a constant number of queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openSecrets } from '../runtime/secrets.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { boot, tmpGraph, tmpDir } from './helpers.mjs';

const CHECKOUT = JSON.parse(fs.readFileSync('apps/checkout/app.json', 'utf8'));
const PLUGINS = CHECKOUT.plugins.map((p) => path.resolve('apps/checkout', p));
const VALUE = 'Qx7Vz9Kp2Lm4Wn8R';
const OTHER = 'Hy3Jt6Bd5Fc1Gs0N';

// A small app (an admin and the checkout plugins by absolute path) with the connectors the test names.
const graphWith = (connectors, { plugins = [], roles = true } = {}) => tmpGraph({
  app: 'settings', data: { User: { email: 'text!', password: 'password!', name: 'text!', role: 'enum[admin,customer]=customer' } }, views: 'auto',
  plugins: [...PLUGINS, ...plugins], connectors,
  ...(roles ? { roles: { entity: 'User', login: 'email', password: 'password', role: 'role', register: 'customer', anonymous: 'guest', can: { admin: '*', customer: { User: ['view'] }, guest: {} } },
    seed: { User: [{ email: 'admin@checkout.test', password: 'admin123', name: 'Admin', role: 'admin' }] } } : {}),
});
const origin = (app) => ({ origin: app.base });
const asAdmin = async (app) => { await app.login('admin@checkout.test', 'admin123'); return app; };

// Every window of 4 characters of a value: a leak of any piece of 4 or more characters contains one of them.
const windows = (v) => Array.from({ length: v.length - 3 }, (_, i) => v.slice(i, i + 4));
const leaks = (text, values) => values.flatMap((v) => [v, ...windows(v)]).filter((w) => text.includes(w));

test('an admin sees every connector: kind, mode, breakers, 24 h counts, slots as set or MISSING, the webhook path and the command line', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  const r = await app.get('/settings');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const c of ['pay', 'mail', 'staff']) assert.match(r.html, new RegExp(`<h3>${c} `), c);
  assert.match(r.html, /<h3>pay <span class="muted">stripe<\/span> <span class="status">sandbox<\/span>/);
  assert.match(r.html, /sandbox: <span class="status">closed<\/span> &middot; live: <span class="status">closed<\/span>/);
  assert.match(r.html, /Last 24 hours: sent 0, failed 0, unknown 0, drift 0/);
  assert.match(r.html, /<code>checkout_stripe_key<\/code>/);
  assert.equal((r.html.match(/MISSING/g) || []).length, 6, 'six slots, none set');
  assert.match(r.html, /<code>\/hook\/pay<\/code>/);
  assert.match(r.html, /<code>node runtime\/run\.mjs apps\/checkout\/app\.json --connectors live pay --confirm<\/code>/);
  assert.match(r.html, /<a href="\/settings">Settings<\/a>/, 'the navigation links to it, next to the outbox');
  assert.match(r.html, /<a href="\/outbox">Outbox<\/a>/);
  assert.doesNotMatch(r.html, /<form[^>]*action="\/settings\/test"[^>]*>(?:(?!<\/form>)[\s\S])*live/, 'no "go live" form');
  const j = JSON.parse((await app.get('/settings', { accept: 'application/json' })).html);
  assert.deepEqual(j.connectors.find((c) => c.connector === 'pay').slots, [
    { slot: 'apiKey', name: 'checkout_stripe_key', set: false }, { slot: 'webhookSecret', name: 'checkout_stripe_whsec', set: false }]);
  assert.equal(j.connectors.find((c) => c.connector === 'pay').webhook, '/hook/pay');
});

test('the counts: the last 24 hours of the outbox per connector in one grouped query, drift included, older rows left out', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  const { store } = app.app;
  const mk = (connector, status, drift = 0, old = false) => {
    const id = store.enqueue({ kind: 'slack', connector, target: 'x', payload: {}, op: 'postMessage' });
    store.drv.run('UPDATE "_outbox" SET "status"=?, "drift"=?, "updatedAt"=? WHERE id=?', [status, drift, old ? '2000-01-01T00:00:00.000Z' : new Date().toISOString(), id]);
  };
  mk('staff', 'sent'); mk('staff', 'sent', 1); mk('staff', 'failed'); mk('staff', 'unknown'); mk('staff', 'sent', 0, true); mk('mail', 'failed');
  const html = (await app.get('/settings')).html;
  assert.match(html, /<h3>staff[\s\S]*?Last 24 hours: sent 2, failed 1, unknown 1, drift 1/);
  assert.match(html, /<h3>mail[\s\S]*?Last 24 hours: sent 0, failed 1, unknown 0, drift 0/);
  store.breakerRecord('staff', 'sandbox', 'failure', Date.now(), { threshold: 1, cooldownMs: 60000 });
  assert.match((await app.get('/settings')).html, /sandbox: <span class="status">open<\/span> 1 failure\(s\) until /);
});

test('a secret is set, replaced and removed through the screen, and no response, trace or database file ever holds its value', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  const seen = [];
  const take = (r) => { seen.push(r.html, r.location, [...(r.headers?.entries?.() || [])].join('\n')); return r; };
  const set = (slot, value, connector = 'pay') => app.post('/settings/secret', { connector, slot, value }, origin(app));
  const r1 = take(await set('apiKey', VALUE));
  assert.equal(r1.status, 303);
  assert.match(r1.location, /^\/settings\?ok=checkout_stripe_key%20saved$/);
  const store = openSecrets({ dir: app.dir, app: 'checkout' });
  assert.equal(store.current('checkout_stripe_key'), VALUE, 'it reached the store');
  const page = take(await app.get(r1.location));
  assert.match(page.html, /checkout_stripe_key saved/);
  assert.match(page.html, /<code>checkout_stripe_key<\/code><\/td><td><span class="status">set<\/span>/);
  assert.equal((page.html.match(/MISSING/g) || []).length, 5);
  assert.match(page.html, /<input type="password" name="value" autocomplete="new-password"/);
  assert.doesNotMatch(page.html, /<input[^>]*type="password"[^>]*value=/, 'a password field is always empty');
  // an empty submission changes nothing, a replacement replaces
  const r2 = take(await set('apiKey', ''));
  assert.match(decodeURIComponent(r2.location), /checkout_stripe_key: no change \(the value was empty\)/);
  assert.equal(store.current('checkout_stripe_key'), VALUE);
  take(await set('apiKey', OTHER));
  assert.equal(store.current('checkout_stripe_key'), OTHER);
  take(await set('apiKey', VALUE));
  // a refusal and the answers that carry errors
  take(await set('nope', VALUE));
  take(await set('apiKey', VALUE, 'nobody'));
  take(await set('apiKey', 'x'.repeat(5000)));
  const json = await app.post('/settings/secret', { connector: 'pay', slot: 'apiKey', value: VALUE }, { ...origin(app), accept: 'application/json' });
  take(json);
  assert.deepEqual(JSON.parse(json.html), { ok: true, message: 'checkout_stripe_key saved' });
  take(await app.get('/settings', { accept: 'application/json' }));
  take(await app.get('/settings'));
  take(await app.get('/outbox'));
  take(await app.post('/settings/test', { connector: 'pay' }, origin(app)));
  for (const slot of ['webhookSecret']) take(await set(slot, OTHER));
  assert.deepEqual(leaks(seen.join('\n'), [VALUE, OTHER]), [], 'no response holds the value or any piece of it');
  const files = fs.readdirSync(app.dir).filter((f) => !['secrets.enc', 'secrets.key'].includes(f)).map((f) => path.join(app.dir, f)).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.some((f) => f.endsWith('trace.jsonl')) && files.some((f) => f.endsWith('data.sqlite')));
  for (const f of files) assert.deepEqual(leaks(fs.readFileSync(f, 'latin1'), [VALUE, OTHER]), [], `${path.basename(f)} holds no secret`);
  assert.equal(fs.readFileSync(path.join(app.dir, 'secrets.enc'), 'latin1').includes(VALUE), false, 'the store is encrypted');
  const traced = app.trace().filter((e) => e.kind === 'secret_set');
  assert.ok(traced.length >= 3 && traced.every((e) => e.name && e.slot && e.connector && !('value' in e)));
  // removing needs the confirmation, and then the slot is MISSING again
  const bare = take(await app.post('/settings/secret/remove', { connector: 'pay', slot: 'apiKey' }, origin(app)));
  assert.equal(bare.status, 400);
  assert.match(bare.html, /was not removed: tick the confirmation box/);
  assert.equal(store.current('checkout_stripe_key'), VALUE);
  const gone = await app.post('/settings/secret/remove', { connector: 'pay', slot: 'apiKey', confirm: 'yes' }, origin(app));
  assert.match(decodeURIComponent(gone.location), /checkout_stripe_key removed/);
  assert.equal(store.current('checkout_stripe_key'), undefined);
  assert.match(decodeURIComponent((await app.post('/settings/secret/remove', { connector: 'pay', slot: 'apiKey', confirm: 'yes' }, origin(app))).location), /was not set/);
  assert.equal((await app.post('/settings/secret/remove', { connector: 'pay', slot: 'zzz', confirm: 'yes' }, origin(app))).status, 404);
  assert.ok(app.trace().some((e) => e.kind === 'secret_removed' && e.name === 'checkout_stripe_key'));
  const jr = await app.post('/settings/secret', { connector: 'pay', slot: 'apiKey', value: '' }, { ...origin(app), accept: 'application/json' });
  assert.equal(JSON.parse(jr.html).ok, true);
});

test('a store that cannot be read is said so, and a save is refused with a fixed message that holds no value', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  openSecrets({ dir: app.dir, app: 'checkout' }).set('unrelated', 'x'); // makes the master key
  fs.writeFileSync(path.join(app.dir, 'secrets.enc'), 'not a store');
  const page = await app.get('/settings');
  assert.equal(page.status, 200);
  assert.match(page.html, /The secret store cannot be read/);
  assert.match(page.html, /<span class="error">unreadable<\/span>/);
  assert.doesNotMatch(page.html, /MISSING/);
  const r = await app.post('/settings/secret', { connector: 'pay', slot: 'apiKey', value: VALUE }, origin(app));
  assert.equal(r.status, 400);
  assert.match(r.html, /secrets\.enc cannot be read/);
  assert.deepEqual(leaks(r.html, [VALUE]), []);
  const rm = await app.post('/settings/secret/remove', { connector: 'pay', slot: 'apiKey', confirm: 'yes' }, origin(app));
  assert.equal(rm.status, 400);
});

test('only an admin: a customer and a guest get 403 on GET and on every POST, and nothing is changed', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await app.post('/register', { email: 'ann@checkout.test', password: 'secret1', name: 'Ann' });
  const posts = [['/settings/secret', { connector: 'pay', slot: 'apiKey', value: VALUE }], ['/settings/secret/remove', { connector: 'pay', slot: 'apiKey', confirm: 'yes' }], ['/settings/test', { connector: 'pay' }]];
  const nav = (await app.get('/Product')).html;
  assert.doesNotMatch(nav, /href="\/settings"/, 'no link for a customer');
  for (const who of ['customer', 'guest']) {
    if (who === 'guest') app.asGuest();
    for (const accept of ['text/html', 'application/json']) {
      const g = await app.get('/settings', { accept });
      assert.equal(g.status, 403, `${who} GET ${accept}`);
      assert.doesNotMatch(g.html, /checkout_stripe_key|apiKey/, 'the slot list is not in a refusal');
      if (accept === 'application/json') assert.equal(JSON.parse(g.html).ok, false);
    }
    for (const [p, body] of posts) assert.equal((await app.post(p, body, origin(app))).status, 403, `${who} POST ${p}`);
    assert.equal((await app.get('/settings/test')).status, 403);
    assert.equal((await app.get('/settings/nothing')).status, 403, 'not even the shape of the routes is told');
  }
  assert.equal(fs.existsSync(path.join(app.dir, 'secrets.enc')), false, 'nothing was written');
  assert.ok(app.trace().filter((e) => e.kind === 'denied' && e.path.startsWith('/settings')).length >= 12);
});

test('a POST must come from this site: another origin, a missing Origin and Referer, "null" and a Referer from elsewhere are refused', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  const body = { connector: 'pay', slot: 'apiKey', value: VALUE };
  const store = openSecrets({ dir: app.dir, app: 'checkout' });
  const port = new URL(app.base).port;
  const refused = [{ origin: 'https://evil.example' }, {}, { origin: 'null' }, { referer: 'https://evil.example/settings' }, { origin: `http://127.0.0.1.evil.example:${port}` },
    { origin: 'http://127.0.0.1:1' }, { origin: 'not a url' }, { origin: 'https://evil.example', referer: app.base + '/settings' }];
  for (const h of refused) {
    for (const p of ['/settings/secret', '/settings/secret/remove', '/settings/test']) {
      const r = await app.post(p, { ...body, confirm: 'yes' }, h);
      assert.equal(r.status, 403, `${JSON.stringify(h)} ${p}`);
      assert.match(r.html, /did not come from this site/);
    }
  }
  assert.equal(store.current('checkout_stripe_key'), undefined, 'a refused POST changes nothing');
  assert.equal((await app.post('/settings/secret', body, { referer: `${app.base}/settings` })).status, 303, 'the Referer of this site is enough');
  assert.equal(store.current('checkout_stripe_key'), VALUE);
  assert.equal((await app.post('/settings/secret', body, origin(app))).status, 303);
});

test('methods and paths: GET only on /settings, POST only on the three actions, nothing else; a graph without connectors has no screen', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  assert.equal((await app.post('/settings', {}, origin(app))).status, 405);
  assert.equal((await app.get('/settings/secret')).status, 405);
  assert.equal((await app.get('/settings/nothing')).status, 404);
  assert.equal((await app.post('/settings/secret', { connector: 'constructor', slot: 'apiKey', value: VALUE }, origin(app))).status, 404);
  assert.equal((await app.post('/settings/secret', { connector: 'pay', slot: 'constructor', value: VALUE }, origin(app))).status, 404);
  assert.equal((await app.post('/settings/secret', { connector: 'pay', value: VALUE }, origin(app))).status, 404);
  const plain = await boot('tests/fixtures/kitchen.json');
  t.after(plain.close);
  assert.equal((await plain.get('/settings')).status, 404);
});

test('a graph without roles: the screen is open like /outbox, and says there are no connectors when there are none', async (t) => {
  const app = await boot(graphWith({ pay: CHECKOUT.connectors.pay }, { roles: false }));
  t.after(app.close);
  assert.equal((await app.get('/settings')).status, 200);
  const none = await boot(graphWith({}, { roles: false }));
  t.after(none.close);
  const empty = await none.get('/settings');
  assert.equal(empty.status, 200);
  assert.match(empty.html, /This graph has no connectors/);
});

test('the webhook is shown as a path: a forged Host header is never reflected into the page', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  const cookie = (await app.get('/Product')).headers && (await (async () => { const r = await fetch(`${app.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'login=admin%40checkout.test&password=admin123' }); return r.headers.get('set-cookie').split(';')[0]; })());
  const html = await new Promise((resolve, reject) => {
    const req = http.request(app.base + '/settings', { headers: { host: 'evil.example:6666', cookie } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.end();
  });
  assert.match(html, /<code>\/hook\/pay<\/code>/);
  assert.doesNotMatch(html, /evil\.example/);
});

const COUNT_LAYOUT = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, (i % 3 === 1 ? { kind: 'postmark', from: 'a@b.test' } : { kind: ['stripe', 'postmark', 'slack'][i % 3] })]));
test('N connectors cost the same number of queries: GET /settings never asks the database per connector', async (t) => {
  const counts = [];
  for (const n of [1, 3, 12]) {
    const app = await boot(graphWith(COUNT_LAYOUT(n)));
    t.after(app.close);
    await asAdmin(app);
    for (let i = 0; i < n; i++) {
      app.app.store.enqueue({ kind: 'slack', connector: `c${i}`, target: 'x', payload: {}, op: 'postMessage' });
      app.app.store.breakerRecord(`c${i}`, 'sandbox', 'failure', Date.now(), { threshold: 1 });
    }
    let queries = 0;
    app.app.store.drv.onQuery = (_sql, opts) => { if (opts?.cache !== false) queries++; };
    const r = await app.get('/settings');
    app.app.store.drv.onQuery = null;
    assert.equal(r.status, 200);
    assert.equal((r.html.match(/class="card connector"/g) || []).length, n);
    counts.push(queries);
  }
  assert.ok(counts[0] > 0, 'the counter counts');
  assert.deepEqual(counts, [counts[0], counts[0], counts[0]], `1, 3 and 12 connectors cost ${counts.join(', ')} queries`);
});

const echo = (extra = {}) => ({ descriptor: 1, name: 'echo', modes: ['sandbox', 'live'], base: 'https://echo.test', ...extra });
const ECHO_OPS = {
  ping: { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: '{base}/ping' } },
};

function pluginDir(descriptors) {
  const dir = tmpDir('ag-plug-');
  return descriptors.map((d, i) => { const f = path.join(dir, `d${i}.json`); fs.writeFileSync(f, JSON.stringify(d)); return f; });
}

test('send test, sandbox: runs one operation through the sandbox rules and shows its status and the shape of the answer, and nothing is queued or sent', async (t) => {
  const bare = echo({ operations: ECHO_OPS, sandbox: { operations: { ping: [{ body: { ok: true } }] } } });
  const needy = echo({ name: 'needy', operations: { ask: { idempotent: true, input: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } }, request: { url: '{base}/ask' } } }, sandbox: { operations: { ask: [{ body: { a: 1 } }] } } });
  const shaped = echo({ name: 'shaped', operations: { list: { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: '{base}/list' },
    output: { type: 'object', properties: { items: { type: 'array' } } } } }, sandbox: { operations: { list: [{ body: { items: [{ id: 1, tag: 'x' }], total: 2, none: null, empty: [] } }] } } });
  const odd = echo({ name: 'odd', operations: { raw: { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: '{base}/r' }, output: { type: 'object' } } }, sandbox: { operations: { raw: [{ status: 200, body: { x: 'y'.repeat(20000) } }] } } });
  const rejected = echo({ name: 'rejected', operations: { go: { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: '{base}/g' } } }, sandbox: { operations: { go: [{ status: 503, body: {} }] } } });
  const plugins = pluginDir([bare, needy, shaped, odd, rejected]);
  const connectors = { a: { kind: 'echo' }, b: { kind: 'needy' }, c: { kind: 'shaped' }, d: { kind: 'odd' }, e: { kind: 'rejected' }, m: { kind: 'mail', from: 'x@y.test' }, h: { kind: 'http', url: 'https://example.test' }, pay: CHECKOUT.connectors.pay };
  const app = await boot(graphWith(connectors, { plugins }));
  t.after(app.close);
  await asAdmin(app);
  const test = async (c) => app.post('/settings/test', { connector: c }, origin(app));
  const pay = await test('pay');
  assert.equal(pay.status, 200);
  assert.match(pay.html, /<b>Test createPaymentIntent:<\/b> <span class="status">sent<\/span> 200/);
  assert.match(pay.html, /&quot;id&quot;: &quot;string&quot;/);
  assert.match(pay.html, /&quot;amount&quot;: &quot;number&quot;/);
  assert.match(pay.html, /Answer shape \(names and types\)/);
  assert.doesNotMatch(pay.html, /pi_sbx_/, 'the shape holds no value of the answer');
  const j = JSON.parse((await app.post('/settings/test', { connector: 'pay' }, { ...origin(app), accept: 'application/json' })).html);
  assert.equal(j.test.op, 'createPaymentIntent');
  assert.equal(j.test.shape.id, 'string');
  const first = await test('a');
  assert.match(first.html, /<b>Test ping:<\/b> <span class="status">sent<\/span> 200/, 'no declared test: the first operation with sandbox rules');
  assert.match(first.html, /the operation declares no output/);
  const miss = await test('b');
  assert.match(miss.html, /<b>Test ask:<\/b> <span class="status">failed<\/span> <span class="error">[^<]*q[^<]*<\/span>/, 'an input that cannot be built is reported, not thrown');
  const shaped2 = await test('c');
  assert.match(shaped2.html, /&quot;items&quot;: \[\s*\{\s*&quot;id&quot;: &quot;number&quot;,\s*&quot;tag&quot;: &quot;string&quot;\s*\}\s*\]/);
  assert.match(shaped2.html, /&quot;none&quot;: &quot;null&quot;/);
  assert.match(shaped2.html, /&quot;empty&quot;: \[\s*&quot;empty&quot;\s*\]/);
  assert.match((await test('d')).html, /not JSON, or cut short/);
  assert.match((await test('e')).html, /<span class="status">failed<\/span> 503/);
  assert.match((await test('m')).html, /has no sandbox operation to test/);
  assert.equal((await test('h')).status, 400, 'the http kind is live only');
  assert.equal((await test('nobody')).status, 404);
  assert.equal(app.app.store.outbox().length, 0, 'nothing was queued');
  assert.equal(app.net.calls.length, 0, 'nothing was sent');
  assert.deepEqual(app.app.store.breakers(), [], 'the breaker was not touched');
  assert.ok(app.trace().some((e) => e.kind === 'settings_test' && e.connector === 'pay' && e.status === 'sent'));
  const page = (await app.get('/settings')).html;
  assert.match(page, /<form class="inline" method="post" action="\/settings\/test"><input type="hidden" name="connector" value="pay">/);
  assert.match(page, /<h3>m <span[^>]*>mail<\/span>[\s\S]*?No sandbox test is available for this kind/);
  assert.match(page, /This kind runs in live mode only/);
});

test('send test is refused when the connector is live (deploy.json), and nothing is sent', async (t) => {
  const app = await boot('apps/checkout/app.json');
  t.after(app.close);
  await asAdmin(app);
  fs.writeFileSync(path.join(app.dir, 'deploy.json'), JSON.stringify({ connectors: { pay: 'live' } }));
  const r = await app.post('/settings/test', { connector: 'pay' }, origin(app));
  assert.equal(r.status, 400);
  assert.match(r.html, /pay runs live: a test is never sent from this screen/);
  assert.equal(app.net.calls.length, 0);
  assert.equal(app.app.store.outbox().length, 0);
  const page = (await app.get('/settings')).html;
  assert.match(page, /<h3>pay <span[^>]*>stripe<\/span> <span class="status">live<\/span>/);
  assert.match(page, /Send test runs in sandbox mode only; this connector is live\./);
  assert.match(page, /--connectors sandbox pay<\/code>/, 'back to sandbox is the command line as well');
  assert.doesNotMatch(page, /--connectors live pay/);
});

test('the shipped descriptors declare a sandbox test that passes the checker, and a broken one is refused', () => {
  for (const name of ['stripe', 'postmark', 'slack']) {
    const d = JSON.parse(fs.readFileSync(`connectors/${name}/descriptor.json`, 'utf8'));
    assert.ok(d.sandbox.test.op in d.operations, name);
    assert.deepEqual(checkDescriptor(d), [], name);
  }
  const d = JSON.parse(fs.readFileSync('connectors/stripe/descriptor.json', 'utf8'));
  const bad = (test) => checkDescriptor({ ...d, sandbox: { ...d.sandbox, test } }).map(([p]) => p);
  assert.deepEqual(bad({ op: 'createPaymentIntent', input: { amount: 100, currency: 'usd' } }), []);
  assert.deepEqual(bad({ op: 'createPaymentIntent' }), ['/sandbox/test/input/amount', '/sandbox/test/input/currency'].filter((p) => bad({ op: 'createPaymentIntent' }).includes(p)));
  assert.ok(bad({ op: 'createPaymentIntent', input: { amount: 0, currency: 'usd' } }).some((p) => p.startsWith('/sandbox/test/input')), 'an input the operation refuses');
  assert.deepEqual(bad({ op: 'nope' }), ['/sandbox/test/op']);
  assert.deepEqual(bad({ op: 5 }), ['/sandbox/test/op']);
  assert.deepEqual(bad({ op: 'createPaymentIntent', input: [] }), ['/sandbox/test/input']);
  assert.deepEqual(bad({ op: 'createPaymentIntent', extra: 1 }), ['/sandbox/test']);
  assert.deepEqual(bad('x'), ['/sandbox/test']);
  assert.deepEqual(bad({ op: 'constructor' }), ['/sandbox/test/op']);
  assert.deepEqual(checkDescriptor({ ...d, sandbox: { ...d.sandbox, other: 1 } }).map(([p]) => p), ['/sandbox']);
  const broken = { ...d, operations: { ...d.operations, createPaymentIntent: { ...d.operations.createPaymentIntent, input: { type: 'nope' } } } };
  assert.ok(checkDescriptor({ ...broken, sandbox: { ...d.sandbox, test: { op: 'createPaymentIntent', input: {} } } }).every(([p]) => !p.startsWith('/sandbox/test')), 'a broken schema is reported where it is declared, not twice');
});
