// The engine (runtime/connectors/engine.mjs): from an operation and its input to a request,
// from a response to an outbox patch, and `http` — now a built-in descriptor — delivering
// byte for byte what the hand-written transport delivered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, buildRequest, mapResponse, deliverRow, synthesize, DEFAULT_TIMEOUT_MS, RESPONSE_CAP } from '../runtime/connectors/engine.mjs';
import { validate } from '../runtime/connectors/schema.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { BUILTIN } from '../runtime/connectors/builtin.mjs';
import { TRANSPORTS } from '../runtime/transports.mjs';
import { fakeFetch } from './helpers.mjs';

const pay = () => ({
  descriptor: 1, name: 'pay', timeoutMs: 5000, base: '{config.host}/v1',
  config: { type: 'object', required: ['host'], properties: { host: { type: 'string' }, region: { type: 'string', default: 'eu' }, timeout: { type: 'integer' } } },
  operations: {
    charge: {
      idempotent: true,
      input: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer', minimum: 1 }, currency: { type: 'string', default: 'USD', pattern: '^[A-Z]{3}$' }, note: { type: 'string' } } },
      request: { method: 'PUT', url: '{base}/charge/{input.currency}?r={config.region}', headers: { 'x-note': '{input.note}', authorization: 'Bearer {secret.apiKey}' }, body: { amount: { $: 'input.amount' }, note: { $: 'input.note' } } },
      output: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['ok', 'held'] } } },
      result: { id: '$.id', where: '$.data.city', missing: '$.nope' },
    },
    ping: { idempotent: true, input: { type: 'object' }, request: { url: '{base}/ping' } },
  },
});
const cfg = { kind: 'pay', host: 'https://pay.test' };
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('the descriptor used here is itself valid', () => assert.deepEqual(checkDescriptor(pay()), []));

test('prepare: input gets its defaults, is validated with every problem named, and the url is built', () => {
  const d = pay();
  assert.deepEqual(prepare(d, cfg, 'charge', { amount: 5 }), { input: { amount: 5, currency: 'USD' }, target: 'https://pay.test/v1/charge/USD?r=eu' });
  assert.throws(() => prepare(d, cfg, 'charge', { amount: 0, currency: 'usd', extra: 1 }), (e) => {
    assert.match(e.message, /^pay\.charge: /);
    for (const re of [/input\/amount: must be at least 1/, /input\/currency: must match/, /input\/extra: unknown property "extra"/]) assert.match(e.message, re);
    return true;
  });
  assert.throws(() => prepare(d, cfg, 'charge', {}), /input\/amount: is required/);
  assert.throws(() => prepare(d, cfg, 'refund', {}), /pay has no operation "refund" \(operations: charge, ping\)/);
  assert.throws(() => prepare(d, { kind: 'pay', host: 'ftp://x' }, 'ping', {}), /must start with http:\/\/ or https:\/\//);
  assert.throws(() => prepare(d, { kind: 'pay' }, 'ping', {}), /must start with http/, 'no host, no url');
});

test('buildRequest: method, url, headers, JSON body and timeout from the descriptor, the config and the input', () => {
  const d = pay();
  const req = buildRequest(d, cfg, 'charge', { amount: 5, currency: 'EUR', note: 'n' }, { secret: (k) => `S:${k}` });
  assert.deepEqual({ ...req }, { method: 'PUT', url: 'https://pay.test/v1/charge/EUR?r=eu', headers: { 'x-note': 'n', authorization: 'Bearer S:apiKey' }, body: '{"amount":5,"note":"n"}', timeout: 5000 });
  assert.equal(buildRequest(d, cfg, 'charge', { amount: 5, currency: 'EUR' }, { secret: () => 'k' }).body, '{"amount":5}', 'an absent input leaves its property out');
  assert.equal(buildRequest(d, cfg, 'charge', { amount: 5, currency: 'EUR' }, { secret: () => 'k' }).headers['x-note'], '', 'and is empty inside a string');
  assert.deepEqual({ ...buildRequest(d, cfg, 'ping', {}) }, { method: 'POST', url: 'https://pay.test/v1/ping', headers: {}, body: undefined, timeout: 5000 }, 'POST unless said; no body when none is declared');
  assert.equal(buildRequest(d, { ...cfg, timeout: 70 }, 'ping', {}).timeout, 70, 'the connector may shorten or lengthen it');
  delete d.timeoutMs;
  assert.equal(buildRequest(d, cfg, 'ping', {}).timeout, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 3000);
  assert.equal(buildRequest(d, cfg, 'ping', {}, { target: 'http://kept.test/x' }).url, 'http://kept.test/x', 'a row that already has its url keeps it');
  d.operations.ping.request.method = '{input.m}';
  assert.throws(() => buildRequest(d, cfg, 'ping', { m: 'TRACE' }), /unsupported method "TRACE"/);
});

test('buildRequest: a secret with no store behind it fails closed and says why', () => {
  assert.throws(() => buildRequest(pay(), cfg, 'charge', { amount: 1, currency: 'USD' }), /secret "apiKey" cannot be resolved: the secret store is not available yet/);
});

test('mapResponse: no output declared means the body is never read', async () => {
  const res = { ok: true, status: 201, text: () => { throw new Error('must not be read'); } };
  assert.deepEqual(await mapResponse(pay().operations.ping, res), { patch: { code: 201, status: 'sent', error: null }, drift: [] });
  assert.deepEqual(await mapResponse(pay().operations.charge, answer(503, 'down')), { patch: { code: 503, status: 'failed', error: 'HTTP 503' }, drift: [] }, 'nor is a failed one');
});

test('mapResponse: an answer that fits is kept (capped), its result mapped, drift 0', async () => {
  const body = { id: 'p1', status: 'ok', data: { city: 'Riga' }, extra: [1] };
  const { patch, drift } = await mapResponse(pay().operations.charge, answer(200, body));
  assert.deepEqual(drift, [], 'a provider may add fields');
  assert.deepEqual(patch, { code: 200, status: 'sent', error: null, response: JSON.stringify(body), result: '{"id":"p1","where":"Riga"}', drift: 0 });
  const long = await mapResponse(pay().operations.charge, answer(200, JSON.stringify({ id: 'p', status: 'ok', pad: 'x'.repeat(RESPONSE_CAP) })));
  assert.equal(long.patch.response.length, RESPONSE_CAP);
  assert.equal(long.patch.drift, 0);
  const noResult = pay().operations.charge; delete noResult.result;
  assert.equal('result' in (await mapResponse(noResult, answer(200, { id: 'p', status: 'ok' }))).patch, false);
});

test('mapResponse: an answer that does not fit sets drift and names the first path; the row stays sent', async () => {
  const wrong = await mapResponse(pay().operations.charge, answer(200, { id: 5, status: 'weird' }));
  assert.equal(wrong.patch.status, 'sent');
  assert.equal(wrong.patch.drift, 1);
  assert.deepEqual(wrong.drift.map(([p]) => p), ['/id', '/status']);
  const missing = await mapResponse(pay().operations.charge, answer(200, { status: 'ok' }));
  assert.deepEqual([missing.patch.drift, missing.drift[0]], [1, ['/id', 'is required']]);
  const notJson = await mapResponse(pay().operations.charge, answer(200, '<html>oops</html>'));
  assert.equal(notJson.patch.status, 'sent');
  assert.equal(notJson.patch.drift, 1);
  assert.equal(notJson.patch.response, '<html>oops</html>');
  assert.equal('result' in notJson.patch, false);
  assert.match(notJson.drift[0][1], /the answer is not JSON/);
  const unread = await mapResponse(pay().operations.charge, { ok: true, status: 200, text: async () => { throw new Error('reset'); } });
  assert.deepEqual([unread.patch.status, unread.patch.drift, unread.patch.response], ['sent', 1, '']);
  assert.match(unread.drift[0][1], /reset/);
});

test('deliverRow: sends the built request, traces contract_drift, and refuses a row it cannot place', async () => {
  const d = pay();
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return answer(200, { id: 1 }); };
  const events = [];
  const row = { id: 9, connector: 'p', op: 'charge', payload: { amount: 5, currency: 'USD' } };
  const patch = await deliverRow(d, row, cfg, { fetchImpl, trace: (e) => events.push(e), secret: () => 'K' });
  assert.equal(sent[0].url, 'https://pay.test/v1/charge/USD?r=eu');
  assert.equal(sent[0].init.method, 'PUT');
  assert.equal(sent[0].init.body, '{"amount":5}');
  assert.ok(sent[0].init.signal instanceof AbortSignal);
  assert.equal(patch.drift, 1);
  assert.deepEqual(events, [{ kind: 'contract_drift', id: 9, connector: 'p', op: 'charge', path: '/status', message: 'is required' }]);
  await deliverRow(d, { ...row, op: 'ping', payload: {} }, cfg, { fetchImpl });
  assert.equal('body' in sent[1].init, false, 'no body key when the operation has none');
  await assert.rejects(() => deliverRow(d, { ...row, op: 'nope' }, cfg, { fetchImpl }), /pay has no operation "nope"/);
  await assert.rejects(() => deliverRow(d, { ...row, op: null }, cfg, { fetchImpl }), /a "pay" row needs an operation/);
  await assert.rejects(() => deliverRow(d, { ...row }, cfg, { fetchImpl }), /secret "apiKey"/);
});

test('synthesize: the transport says what is wrong with a connector by its config schema', () => {
  const t = synthesize(pay());
  assert.match(t.summary, /the pay connector \(charge, ping\)/);
  assert.equal(synthesize({ ...pay(), title: 'Pay!' }).summary, 'Pay!');
  assert.deepEqual(t.validate(cfg), []);
  assert.deepEqual(t.validate({ kind: 'pay' }), [['host', 'is required']]);
  assert.deepEqual(t.validate({ kind: 'pay', host: 'h', region: 5 }).map(([k]) => k), ['region']);
  assert.deepEqual(t.validate({ kind: 'pay', host: 'h', nope: 1 }).map(([k, m]) => `${k}: ${m}`), ['nope: unknown property "nope"'], 'closed by default');
  const bare = synthesize({ ...pay(), config: undefined });
  assert.deepEqual(bare.validate({ kind: 'pay' }), []);
  assert.equal(bare.validate({ kind: 'pay', x: 1 }).length, 1, 'no config schema: nothing is declared, so a key is unknown');
});

// --- http: byte for byte -----------------------------------------------------------------------

// The transport as it was written before it became a descriptor (runtime/transports.mjs at 0.2.0).
const OLD = {
  validate: (c) => {
    const out = [];
    if (!/^https?:\/\//.test(String(c.url || ''))) out.push(['url', 'an http connector needs "url" starting with http:// or https://']);
    if (c.method !== undefined && !['POST', 'PUT', 'PATCH', 'GET'].includes(c.method)) out.push(['method', `unsupported method "${c.method}"`, 'POST, PUT, PATCH or GET']);
    return out;
  },
  deliver: async (row, connector, { fetchImpl }) => {
    const res = await fetchImpl(row.target, { method: connector.method || 'POST', headers: { 'content-type': 'application/json', ...(connector.headers || {}) }, body: JSON.stringify(row.payload), signal: AbortSignal.timeout(connector.timeout || 3000) });
    return { code: res.status, status: res.ok ? 'sent' : 'failed', error: res.ok ? null : `HTTP ${res.status}` };
  },
};
const CONNECTORS = [{}, { url: 'http://s.test/h' }, { url: 'http://s.test/h', method: 'PUT', headers: { 'x-k': '1' }, timeout: 50 }, { url: 'https://s.test', method: 'GET' },
  { url: 'http://s.test', headers: { 'content-type': 'text/plain', 'x-a': 2 } }, { url: 'http://s.test', method: 'PATCH', extra: true }];
const PAYLOADS = [null, 0, 1, 'text', [], [1, { a: 2 }], {}, { a: 1, b: { c: [null] } }];

test('http delivers what the hand-written transport delivered: same url, method, headers, body, code, status and error', async () => {
  for (const connector of CONNECTORS) for (const payload of PAYLOADS) for (const status of [200, 204, 404, 503]) {
    const row = { id: 1, kind: 'http', connector: 'c', target: 'http://s.test/h/x', payload };
    const before = fakeFetch(); before.state.status = status;
    const after = fakeFetch(); after.state.status = status;
    const want = await OLD.deliver(row, connector, { fetchImpl: before.fetchImpl });
    const got = await TRANSPORTS.http.deliver(row, connector, { fetchImpl: after.fetchImpl });
    assert.deepEqual(got, want, JSON.stringify([connector, payload, status]));
    assert.deepEqual(after.calls, before.calls, JSON.stringify([connector, payload, status]));
  }
});

test('http: the same raw request — key order, header merge, and a timeout signal', async () => {
  const seen = [];
  const capture = (log) => async (url, init) => { log.push({ url, init: { ...init, signal: undefined, hasSignal: init.signal instanceof AbortSignal } }); return { ok: true, status: 200 }; };
  const connector = { url: 'http://s.test/h', method: 'PUT', headers: { 'x-k': '1', 'content-type': 'text/plain' }, timeout: 50 };
  const row = { id: 1, target: 'http://s.test/h/p', payload: { z: 1, a: [1, 2] } };
  const old = [];
  await OLD.deliver(row, connector, { fetchImpl: capture(old) });
  await TRANSPORTS.http.deliver(row, connector, { fetchImpl: capture(seen) });
  assert.equal(JSON.stringify(seen), JSON.stringify(old), 'byte for byte, key order included');
  assert.equal(buildRequest(BUILTIN.http, connector, 'send', { body: row.payload }).timeout, 50);
  assert.equal(buildRequest(BUILTIN.http, { url: 'http://s.test' }, 'send', {}).timeout, 3000);
});

test('http: the configuration is checked with the same words as before', () => {
  const configs = [{ kind: 'http' }, { kind: 'http', url: 5 }, { kind: 'http', url: 'ftp://x' }, { kind: 'http', url: 'https://x' }, { kind: 'http', url: 'https://x', method: 'DELETE' },
    { kind: 'http', url: 'https://x', method: '' }, { kind: 'http', url: 'https://x', method: null }, { kind: 'http', url: 'https://x', method: 'GET', headers: { a: 1 }, timeout: 10, other: 1 }];
  for (const c of configs) assert.deepEqual(TRANSPORTS.http.validate(c), OLD.validate(c), JSON.stringify(c));
  assert.equal(TRANSPORTS.http.summary, 'a JSON request to "url" (POST by default) with optional "headers" and "timeout"');
});

test('http as an operation: "send" takes a body and a path; the request is the connector\'s url plus the path', async () => {
  const c = { kind: 'http', url: 'http://s.test/h', method: 'PUT' };
  assert.deepEqual(prepare(BUILTIN.http, c, 'send', { body: { a: 1 }, path: '/x' }), { input: { body: { a: 1 }, path: '/x' }, target: 'http://s.test/h/x' });
  assert.deepEqual(prepare(BUILTIN.http, c, 'send', {}), { input: {}, target: 'http://s.test/h' });
  assert.throws(() => prepare(BUILTIN.http, c, 'send', { path: 5, bogus: 1 }), /input\/path: must be a string; input\/bogus: unknown property/);
  const net = fakeFetch();
  const patch = await TRANSPORTS.http.deliver({ id: 1, op: 'send', target: 'http://s.test/h/x', payload: { body: { a: 1 }, path: '/x' } }, c, { fetchImpl: net.fetchImpl });
  assert.deepEqual(patch, { code: 200, status: 'sent', error: null });
  assert.deepEqual([net.calls[0].url, net.calls[0].method, net.calls[0].body], ['http://s.test/h/x', 'PUT', { a: 1 }]);
  const get = fakeFetch();
  await TRANSPORTS.http.deliver({ id: 2, op: 'send', payload: {} }, { url: 'http://s.test', method: 'GET' }, { fetchImpl: get.fetchImpl });
  assert.equal(get.calls[0].body, null, 'no body was sent');
  assert.deepEqual(validate(BUILTIN.http.operations.send.input, { body: null }), []);
});
