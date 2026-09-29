// Descriptors in the registry, the checker rules of `connectors` and `connector.call`, and
// `connector.call` end to end: the action, the outbox row, the request, the answer, the drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRegistry, registerDescriptor, loadPlugins, DEFAULT } from '../runtime/registry.mjs';
import { validate } from '../runtime/validate.mjs';
import { Store } from '../runtime/store.mjs';
import { open } from '../runtime/driver.mjs';
import { CATALOG } from '../runtime/blocks.mjs';
import { boot, tmpGraph, tmpDir } from './helpers.mjs';

const PAY = {
  descriptor: 1, name: 'pay', title: 'Pay', timeoutMs: 4000,
  config: { type: 'object', required: ['host'], properties: { host: { type: 'string', pattern: '^https?://' }, headers: { type: 'object' } } },
  operations: {
    charge: {
      idempotent: false,
      input: { type: 'object', required: ['amount'], properties: {
        amount: { type: 'integer', minimum: 1 }, currency: { type: 'string', default: 'USD', pattern: '^[A-Z]{3}$' },
        ref: { type: 'string', maxLength: 20 }, total: { type: 'number' }, count: { type: 'integer' }, paid: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string', format: 'email' } }, meta: { type: 'object', properties: { note: { type: 'string' } } } } },
      request: { method: 'POST', url: '{config.host}/charges', headers: { '...': { $: 'config.headers' } }, body: { $: 'input' } },
      output: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string' } } },
      result: { id: '$.id', status: '$.status' },
    },
    secured: { idempotent: true, input: { type: 'object' }, request: { url: '{config.host}/s', headers: { authorization: 'Bearer {secret.apiKey}' } } },
    free: { idempotent: true, input: { type: 'object' }, request: { url: '{config.host}/free/{input.k}', body: { $: 'input' } } },
  },
};
const registryWith = (d = PAY) => registerDescriptor(createRegistry(), structuredClone(d), 'pay.json');

// --- the registry ----------------------------------------------------------------------------

test('a descriptor is registered with its transport; the built-in registry has http and no more', () => {
  assert.deepEqual(Object.keys(DEFAULT.descriptors), ['http']);
  assert.deepEqual(Object.keys(DEFAULT.transports), ['http', 'mail']);
  const r = registryWith();
  assert.equal(r.descriptors.pay.name, 'pay');
  assert.equal(r.transports.pay.plugin, 'pay.json');
  assert.equal(r.transports.pay.summary, 'Pay');
  assert.deepEqual(r.plugins, ['pay.json']);
  assert.equal(DEFAULT.descriptors.pay, undefined, 'the default registry is untouched');
  assert.equal(DEFAULT.transports.pay, undefined);
});

test('registerDescriptor is fail-closed: an invalid descriptor and a taken name are load errors', () => {
  const r = createRegistry();
  assert.throws(() => registerDescriptor(r, { ...PAY, sandbox: 1 }, 'x.json'), /^Error: x\.json: invalid descriptor — \/sandbox sandbox rules need "sandbox" in "modes"/);
  assert.throws(() => registerDescriptor(r, { ...PAY, name: 'http' }, 'x.json'), /x\.json: connector kind "http" is already registered$/);
  registerDescriptor(r, PAY, 'a.json');
  assert.throws(() => registerDescriptor(r, PAY, 'b.json'), /b\.json: connector kind "pay" is already registered by a\.json/);
  assert.throws(() => registerDescriptor(r, null), /descriptor: invalid descriptor — \/ a descriptor is an object/);
  assert.deepEqual(Object.keys(r.descriptors), ['http', 'pay']);
});

test('a .json entry in "plugins" loads a descriptor, next to code plugins; a broken one is a checker error', async () => {
  const dir = tmpDir('ag-desc-');
  fs.writeFileSync(path.join(dir, 'pay.json'), JSON.stringify(PAY));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ ...PAY, name: 'bad', operations: {} }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ nope');
  const ok = await loadPlugins({ plugins: ['./pay.json'] }, dir);
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.registry.descriptors.pay && ok.registry.transports.pay);
  const bad = await loadPlugins({ plugins: ['./bad.json', './broken.json', './missing.json', './pay.json', './pay.json'] }, dir);
  assert.deepEqual(bad.errors.map((e) => e.path), ['/plugins/0', '/plugins/1', '/plugins/2', '/plugins/4']);
  assert.match(bad.errors[0].message, /cannot load plugin "\.\/bad\.json": .*at least one operation/);
  assert.match(bad.errors[1].message, /cannot load plugin "\.\/broken\.json"/);
  assert.match(bad.errors[2].message, /cannot load plugin "\.\/missing\.json"/);
  assert.match(bad.errors[3].message, /connector kind "pay" is already registered by \.\/pay\.json/);
  const g = { app: 'a', data: { A: { n: 'text' } }, plugins: ['./pay.json'], connectors: { p: { kind: 'pay', host: 'https://p.test' } } };
  assert.deepEqual(validate(g, ok.registry), []);
});

// --- the checker: connectors ----------------------------------------------------------------

const base = { app: 'c', data: { Order: { ref: 'text', total: 'money=0', qty: 'int=0', done: 'bool=false', email: 'text', side: 'enum[a,b]=a' } } };
const errs = (graph, registry = registryWith()) => validate({ ...base, ...graph }, registry).map((e) => `${e.path}: ${e.message}`);
const conn = (c) => errs({ connectors: { p: { kind: 'pay', host: 'https://p.test', ...c } } });

test('connectors: the configuration is checked against the descriptor\'s config schema', () => {
  assert.deepEqual(conn({}), []);
  assert.deepEqual(errs({ connectors: { p: { kind: 'pay' } } }), ['/connectors/p/host: is required']);
  assert.deepEqual(conn({ host: 'ftp://x' }), ['/connectors/p/host: must match ^https?://']);
  assert.deepEqual(conn({ colour: 'red' }), ['/connectors/p/colour: unknown property "colour"']);
  assert.deepEqual(conn({ headers: { 'x-a': '1' } }), []);
});

test('connectors: no secret is written into app.json — by key, by shape, in a header, in a list', () => {
  const literal = (c) => conn(c).filter((e) => /a secret written into app\.json/.test(e));
  assert.equal(literal({ apiKey: 'abc123' }).length, 1, 'a key the descriptor never declared is still not a place for a secret');
  const at = (c) => errs({ plugins: undefined, connectors: { p: { kind: 'http', url: 'https://p.test', ...c } } }, DEFAULT).filter((e) => /secret/.test(e));
  assert.deepEqual(at({ token: 'abc' }), ['/connectors/p/token: a secret written into app.json ("token")']);
  assert.equal(at({ password: 'x' }).length, 1);
  assert.equal(at({ client_secret: 'x' }).length, 1);
  assert.equal(at({ Authorization: 'x' }).length, 1);
  assert.equal(at({ apiKey: 'x' }).length, 1);
  assert.equal(at({ headers: { authorization: 'Bearer abc' } }).length, 1, 'inside headers');
  assert.equal(at({ headers: { 'x-trace': 'Bearer abc' } }).length, 1, 'by shape, whatever the key');
  assert.deepEqual(at({ headers: { 'x-trace': 'sk_live_abcdefgh1234' } }), ['/connectors/p/headers/x-trace: a secret written into app.json ("x-trace")']);
  assert.equal(at({ headers: { 'x-t': 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM' } }).length, 1, 'a JWT');
  assert.equal(at({ note: ['ok', 'Bearer zzz'] }).length, 1, 'inside a list');
  assert.deepEqual(at({ token: '' }), [], 'an empty one is not a secret');
  assert.deepEqual(at({ token: '{secret.apiKey}' }), [], 'a reference is what to write');
  assert.deepEqual(at({ secrets: { apiKey: 'stripe_key' } }), [], 'the map of slots to names in the store');
  assert.deepEqual(at({ timeout: 100, method: 'GET', headers: { 'x-team': 'core' }, tag: 'sk' }), []);
});

test('connectors: a url shows in the outbox and the trace, so it holds no secret and no credential', () => {
  const at = (url) => errs({ connectors: { p: { kind: 'http', url } } }, DEFAULT).filter((e) => e.startsWith('/connectors/p/url') && /url/.test(e));
  assert.deepEqual(at('https://h.test/x'), []);
  assert.deepEqual(at('https://h.test/x?page=2&sort=asc'), []);
  assert.match(at('https://h.test/{secret.k}')[0], /secret reference in a url/);
  assert.match(at('https://user:pw@h.test/x')[0], /credential in the url/);
  assert.match(at('https://h.test/x?api_key=abc')[0], /credential in the url/);
  assert.match(at('https://h.test/x?a=1&token=abc')[0], /credential in the url/);
  assert.match(at('https://h.test/x?password=abc')[0], /credential in the url/);
  assert.deepEqual(at('https://h.test/x?token='), [], 'nothing after the equals sign');
});

// --- the checker: connector.call -----------------------------------------------------------

const call = (step, connectors = { p: { kind: 'pay', host: 'https://p.test' } }, registry = registryWith()) =>
  errs({ connectors, actions: [{ name: 'a', in: 'Order', do: [{ block: 'connector.call', connector: 'p', op: 'charge', input: { amount: 5 }, ...step }] }] }, registry);
const P = '/actions/0/do/0';

test('connector.call: a valid call passes, and the block is in the catalog with its requirements', () => {
  assert.deepEqual(call({}), []);
  assert.deepEqual(call({ input: { amount: 5, currency: 'EUR', ref: '@row.ref', total: '= qty * 2', tags: ['a@b.co'], meta: { note: 'n' }, paid: true }, ref: '@row' }), []);
  assert.deepEqual(CATALOG['connector.call'].requires, ['connector', 'op', 'input']);
  assert.deepEqual(errs({ actions: [{ name: 'a', in: 'Order', do: [{ block: 'connector.call' }] }] }, DEFAULT).slice(0, 3), [
    '/actions/0/do/0: block "connector.call" requires "connector"', '/actions/0/do/0: block "connector.call" requires "op"', '/actions/0/do/0: block "connector.call" requires "input"']);
});

test('connector.call: the connector must exist and its kind must have a descriptor', () => {
  assert.deepEqual(call({ connector: 'nope' }), [`${P}/connector: unknown connector "nope"`]);
  assert.deepEqual(call({}, {}), [`${P}/connector: unknown connector "p"`]);
  assert.deepEqual(call({}, { p: { kind: 'mail' } }), [`${P}/connector: connector "p" is mail, which has no descriptor`]);
  const r = validate({ ...base, connectors: {}, actions: [{ name: 'a', in: 'Order', do: [{ block: 'connector.call', connector: 'p', op: 'x', input: {} }] }] }, registryWith());
  assert.match(r[0].hint, /\(none; add \/connectors\)/);
  const k = call({}, { p: { kind: 'mail' } }, registryWith());
  assert.ok(k.length === 1);
});

test('connector.call: the operation must exist; a near miss is suggested', () => {
  assert.deepEqual(call({ op: 'chrge' }), [`${P}/op: pay has no operation "chrge"`]);
  const hint = validate({ ...base, connectors: { p: { kind: 'pay', host: 'https://p.test' } }, actions: [{ name: 'a', in: 'Order', do: [{ block: 'connector.call', connector: 'p', op: 'chrge', input: {} }] }] }, registryWith())[0].hint;
  assert.match(hint, /did you mean: charge, free\?/);
  const far = validate({ ...base, connectors: { p: { kind: 'pay', host: 'https://p.test' } }, actions: [{ name: 'a', in: 'Order', do: [{ block: 'connector.call', connector: 'p', op: 'zzzzzzzz', input: {} }] }] }, registryWith())[0].hint;
  assert.equal(far, 'operations: charge, secured, free');
  assert.equal(call({ op: 5 }).length, 1, 'a non-string op is just an unknown one');
});

test('connector.call: input is an object of the operation\'s inputs — required, known, and literal values fit', () => {
  assert.deepEqual(call({ input: [] }), [`${P}/input: input is an object with the inputs of the operation`]);
  assert.deepEqual(call({ input: null }), [`${P}/input: input is an object with the inputs of the operation`]);
  assert.deepEqual(call({ input: 'x' }), [`${P}/input: input is an object with the inputs of the operation`]);
  assert.deepEqual(call({ input: {} }), [`${P}/input: the operation needs input "amount"`]);
  assert.deepEqual(call({ input: { amount: 5, bogus: 1 } }), [`${P}/input/bogus: unknown input "bogus"`]);
  assert.deepEqual(call({ input: { amount: 0 } }), [`${P}/input/amount: must be at least 1`]);
  assert.deepEqual(call({ input: { amount: 1.5 } }), [`${P}/input/amount: must be a integer`]);
  assert.deepEqual(call({ input: { amount: 1, currency: 'usd' } }), [`${P}/input/currency: must match ^[A-Z]{3}$`]);
  assert.deepEqual(call({ input: { amount: 1, tags: ['a@b.co', 'nope'] } }), [`${P}/input/tags/1: must be a valid email`]);
  assert.deepEqual(call({ input: { amount: 1, meta: { note: 5, x: 1 } } }), [`${P}/input/meta/note: must be a string`, `${P}/input/meta/x: unknown property "x"`]);
  assert.deepEqual(call({ input: { amount: 1, ref: 'x'.repeat(21) } }), [`${P}/input/ref: must be at most 20 characters`]);
});

test('connector.call: what is only known at run time is not judged here — but must still be a real reference', () => {
  assert.deepEqual(call({ input: { amount: '@row.qty', tags: ['@row.email', 'nope'], ref: '= ref' } }), [], 'a list with a reference in it is left to enqueue time');
  assert.deepEqual(call({ input: { amount: '@row.nothing' } }), [`${P}/input/amount: bad reference "@row.nothing": Order has no field "nothing"`]);
  assert.deepEqual(call({ input: { amount: '@ghost.x' } }).length, 1);
  assert.deepEqual(call({ input: { amount: '= ghost + 1' } }).length, 1);
  assert.deepEqual(call({ input: { amount: '@me' } }), [], 'other references are not typed');
});

test('connector.call: "@row.field" must have a type the input can take (money is a number, int a number too, ref an integer)', () => {
  assert.deepEqual(call({ input: { amount: '@row.total' } }), [`${P}/input/amount: @row.total is money (number) but this input is integer`]);
  assert.deepEqual(call({ input: { amount: 1, total: '@row.total' } }), [], 'money into a number');
  assert.deepEqual(call({ input: { amount: 1, total: '@row.qty' } }), [], 'an int fits a number');
  assert.deepEqual(call({ input: { amount: '@row.qty', count: '@row.qty' } }), []);
  assert.deepEqual(call({ input: { amount: 1, ref: '@row.qty' } }), [`${P}/input/ref: @row.qty is int (integer) but this input is string`]);
  assert.deepEqual(call({ input: { amount: 1, paid: '@row.done' } }), []);
  assert.deepEqual(call({ input: { amount: 1, paid: '@row.side' } }), [`${P}/input/paid: @row.side is enum (string) but this input is boolean`]);
  assert.deepEqual(call({ input: { amount: 1, meta: '@row.ref' } }), [`${P}/input/meta: @row.ref is text (string) but this input is object`]);
  assert.deepEqual(call({ input: { amount: 1, currency: '@row.id' } }), [], 'id has no field kind: not judged');
});

test('connector.call: a free-form input has no unknown names; "ref" is a reference to a row', () => {
  const free = (input) => call({ op: 'free', input });
  assert.deepEqual(free({ k: 1, anything: 'goes' }), []);
  assert.deepEqual(call({ ref: 'row' }), [`${P}/ref: "ref" names the row the call is about: "@row", "@found"…`]);
  assert.deepEqual(call({ ref: 5 }), [`${P}/ref: "ref" names the row the call is about: "@row", "@found"…`]);
  assert.deepEqual(call({ ref: '@found' }), []);
});

// --- connector.call end to end ---------------------------------------------------------------

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const graphOf = (dir) => {
  fs.writeFileSync(path.join(dir, 'pay.json'), JSON.stringify(PAY));
  return { app: 'e2e', plugins: [path.join(dir, 'pay.json')], data: { Order: { ref: 'text', total: 'money=0', qty: 'int=0' } },
    connectors: { p: { kind: 'pay', host: 'https://p.test', headers: { 'x-team': 'core' } }, hook: { kind: 'http', url: 'http://sink.test/h' } },
    actions: [
      { name: 'charge', in: 'Order', confirm: 'charged', do: [{ block: 'connector.call', connector: 'p', op: 'charge', input: { amount: '= qty * 100', ref: '@row.ref', total: '@row.total' } }] },
      { name: 'secured', in: 'Order', confirm: 'queued', do: [{ block: 'connector.call', connector: 'p', op: 'secured', input: {} }] },
      { name: 'legacy', in: 'Order', confirm: 'queued', do: [{ block: 'http.send', connector: 'hook', body: { r: '@row.ref' }, path: '/x' }] },
      { name: 'viaHttp', in: 'Order', confirm: 'queued', do: [{ block: 'connector.call', connector: 'hook', op: 'send', input: { body: { r: '@row.ref' } } }] },
    ] };
};
const session = async (respond) => {
  const dir = tmpDir('ag-call-');
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return respond(url, init); };
  const s = await boot(tmpGraph(graphOf(dir)), { fetchImpl });
  const order = s.app.store.insert('Order', { ref: 'R-1', total: 12.5, qty: 3 });
  return { s, sent, order };
};

test('connector.call queues a row with its op, sends the built request, and keeps the answer, the result and drift 0', async () => {
  const { s, sent, order } = await session(() => answer(200, { id: 'ch_1', status: 'paid', more: true }));
  try {
    const r = await s.post(`/Order/${order}/action/charge`, {});
    assert.equal(r.status, 303);
    const [row] = s.app.store.outbox();
    assert.deepEqual([row.kind, row.connector, row.op, row.target, row.status, row.code, row.attempts], ['pay', 'p', 'charge', 'https://p.test/charges', 'sent', 200, 1]);
    assert.deepEqual(row.payload, { amount: 300, ref: 'R-1', total: 12.5, currency: 'USD' }, 'the input, completed with its defaults, is the payload');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://p.test/charges');
    assert.equal(sent[0].init.method, 'POST');
    assert.deepEqual(sent[0].init.headers, { 'x-team': 'core' });
    assert.deepEqual(JSON.parse(sent[0].init.body), row.payload);
    assert.equal(row.response, '{"id":"ch_1","status":"paid","more":true}');
    assert.equal(row.result, '{"id":"ch_1","status":"paid"}');
    assert.equal(row.drift, 0);
    assert.deepEqual(s.trace().filter((e) => e.kind === 'contract_drift'), []);
    assert.equal(s.trace().find((e) => e.kind === 'step' && e.block === 'connector.call').out.delivery, row.id);
  } finally { s.close(); }
});

test('an answer that does not match the output schema sets drift, traces contract_drift, and the row stays sent', async () => {
  const { s, order } = await session(() => answer(200, { id: 7, status: 'paid' }));
  try {
    await s.post(`/Order/${order}/action/charge`, {});
    const [row] = s.app.store.outbox();
    assert.deepEqual([row.status, row.drift], ['sent', 1]);
    const drift = s.trace().filter((e) => e.kind === 'contract_drift');
    assert.deepEqual(drift.map((e) => [e.id, e.connector, e.op, e.path, e.message]), [[row.id, 'p', 'charge', '/id', 'must be a string']]);
    assert.equal(s.trace().find((e) => e.kind === 'delivery').status, 'sent');
  } finally { s.close(); }
});

test('a failed answer is a failed delivery with no body kept; a bad input refuses the whole action and queues nothing', async () => {
  const { s, order } = await session(() => answer(500, { error: 'boom' }));
  try {
    await s.post(`/Order/${order}/action/charge`, {});
    const [row] = s.app.store.outbox();
    assert.deepEqual([row.status, row.code, row.error, row.response, row.result, row.drift], ['failed', 500, 'HTTP 500', null, null, null]);
    s.app.store.update('Order', order, { qty: 0 });
    const bad = await s.post(`/Order/${order}/action/charge`, {});
    assert.equal(bad.status, 400);
    assert.match(bad.html, /pay\.charge: input\/amount: must be at least 1/);
    assert.equal(s.app.store.outbox().length, 1, 'a malformed request never reaches the outbox');
  } finally { s.close(); }
});

test('a secret with no store behind it fails the delivery closed, with the reason in the row', async () => {
  const { s, sent, order } = await session(() => answer(200, {}));
  try {
    await s.post(`/Order/${order}/action/secured`, {});
    const [row] = s.app.store.outbox();
    assert.equal(row.status, 'failed');
    assert.match(row.error, /secret "apiKey" is not set/);
    assert.deepEqual(sent, [], 'nothing was sent');
  } finally { s.close(); }
});

test('http.send still queues a legacy row (no op) and http through connector.call queues an op row; both send the same way', async () => {
  const { s, sent, order } = await session(() => ({ ok: true, status: 200 }));
  try {
    await s.post(`/Order/${order}/action/legacy`, {});
    await s.post(`/Order/${order}/action/viaHttp`, {});
    const rows = s.app.store.outbox().reverse();
    assert.deepEqual(rows.map((r) => [r.kind, r.op, r.target, r.status]), [['http', null, 'http://sink.test/h/x', 'sent'], ['http', 'send', 'http://sink.test/h', 'sent']]);
    assert.deepEqual(rows[0].payload, { r: 'R-1' });
    assert.deepEqual(rows[1].payload, { body: { r: 'R-1' } });
    assert.deepEqual(sent.map((c) => [c.url, c.init.method, c.init.body]), [['http://sink.test/h/x', 'POST', '{"r":"R-1"}'], ['http://sink.test/h', 'POST', '{"r":"R-1"}']]);
    assert.match((await s.get('/outbox')).html, /sink\.test\/h/, 'the outbox screen still lists them');
  } finally { s.close(); }
});

test('connector.call refuses a connector whose kind has no descriptor when the check was bypassed', () => {
  const store = new Store({ app: 'x', data: { A: { n: 'text' } } }, ':memory:');
  const graph = { connectors: { m: { kind: 'mail' } } };
  assert.throws(() => CATALOG['connector.call'].run({ store, graph, registry: DEFAULT, step: { connector: 'm', op: 'x', input: {} }, resolve: (x) => x }), /connector\.call: "m" is mail, which has no descriptor/);
});

// --- the outbox table ------------------------------------------------------------------------

test('a database made before "op", "response", "result" and "drift" is upgraded in place, rows kept', () => {
  const file = path.join(tmpDir('outbox-c1-'), 'old.sqlite');
  const old = open(file);
  old.exec(`CREATE TABLE "_outbox" (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, connector TEXT, target TEXT, payload TEXT,
    status TEXT, code INTEGER, error TEXT, attempts INTEGER DEFAULT 0, at TEXT, updatedAt TEXT, claimedAt INTEGER)`);
  old.run(`INSERT INTO "_outbox" (kind, connector, target, payload, status, attempts) VALUES ('http','hook','http://sink.test/o','1','sent',1)`);
  old.close();
  const graph = { app: 'o', data: { A: { n: 'text' } } };
  const store = new Store(graph, file);
  assert.deepEqual(store.outboxGet(1), { id: 1, kind: 'http', connector: 'hook', target: 'http://sink.test/o', payload: 1, status: 'sent', code: null, error: null, attempts: 1, at: null, updatedAt: null, claimedAt: null, op: null, response: null, result: null, drift: null, nextAttemptAt: null, idemKey: null });
  const id = store.enqueue({ kind: 'pay', connector: 'p', target: 't', payload: { a: 1 }, op: 'charge' });
  store.outboxUpdate(id, { response: 'r', result: '{}', drift: 1 });
  assert.deepEqual([store.outboxGet(id).op, store.outboxGet(id).response, store.outboxGet(id).result, store.outboxGet(id).drift], ['charge', 'r', '{}', 1]);
  assert.equal(new Store(graph, file).outboxGet(id).op, 'charge', 'a second boot finds the columns and changes nothing');
  store.drv.close();
});
