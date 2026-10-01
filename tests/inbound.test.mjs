// Inbound webhooks (C4): the signature recipes, the descriptor's `inbound` block and the checker's `inbound:` events,
// and the route POST /hook/<connector> end to end — the accept/reject matrix (accept, bad signature, a signature of
// the wrong length, stale timestamp, rotation, duplicate exactly once including a crash before commit, unknown type,
// a failing step, the 1 MiB cap, no echo of the payload, reachable without a session), the dedup pruning and the
// `--connectors simulate` command. Every secret here is a fixed test value and the time is an injected clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { signHeaders, verifySignature, checkRecipe, safeEqual } from '../runtime/connectors/signature.mjs';
import { checkInbound, typeOf, eventIdOf, valuesOf, payloadProblems } from '../runtime/connectors/inbound.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { createRegistry, registerDescriptor } from '../runtime/registry.mjs';
import { validate } from '../runtime/validate.mjs';
import { openSecrets } from '../runtime/secrets.mjs';
import { main } from '../runtime/cli.mjs';
import { rawBody, TooBig } from '../runtime/routes/context.mjs';
import { INBOUND_RETENTION_MS } from '../runtime/server.mjs';
import { boot, tmpDir, fakeClock } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const SECRET = 'whsec_TEST_ONLY_1';
const PREV = 'whsec_TEST_ONLY_OLD';
const hmacHex = (algo, secret, data) => crypto.createHmac(algo, secret).update(data).digest('hex');

// --- the signature recipes ---------------------------------------------------------------------

test('stripe: t=<unix>,v1=<hex> over "t.raw", any one of several v1, the replay window after the signature', () => {
  const raw = Buffer.from('{"id":"evt_1"}');
  const t = Math.floor(T0 / 1000);
  const good = hmacHex('sha256', SECRET, `${t}.${raw}`); // computed here, not by the module under test
  const ok = (headers, opts = {}) => verifySignature({ scheme: 'stripe' }, { headers, raw, secrets: [SECRET], now: T0, ...opts });
  assert.deepEqual(ok({ 'stripe-signature': `t=${t},v1=${good}` }), { ok: true });
  assert.deepEqual(ok({ 'stripe-signature': `t=${t},v1=${'0'.repeat(64)},v1=${good}` }), { ok: true }, 'a provider signs with old and new secrets at once');
  assert.equal(ok({ 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` }).reason, 'signature_mismatch');
  assert.equal(ok({ 'stripe-signature': `t=${t + 1},v1=${good}` }).reason, 'signature_mismatch', 'the timestamp is part of what is signed');
  assert.equal(ok({}).reason, 'signature_missing');
  for (const bad of ['', 'v1=abc', `t=${t}`, `t=abc,v1=${good}`, `t=${t},v0=${good}`, 'garbage']) assert.equal(ok({ 'stripe-signature': bad }).reason, 'signature_malformed', bad);
  assert.equal(ok({ 'stripe-signature': `t=${t},v1=${good}` }, { secrets: [] }).reason, 'secret_not_set');
  assert.deepEqual(ok({ 'stripe-signature': `t=${t},v1=${good}` }, { secrets: [PREV, SECRET] }), { ok: true }, 'either secret of a rotation signs');
  // the window: signed by the real secret, but too old (or too far ahead)
  const at = (sec) => ({ 'stripe-signature': `t=${sec},v1=${hmacHex('sha256', SECRET, `${sec}.${raw}`)}` });
  assert.deepEqual(ok(at(t - 300)), { ok: true });
  assert.equal(ok(at(t - 301)).reason, 'timestamp_stale');
  assert.equal(ok(at(t + 301)).reason, 'timestamp_stale');
  assert.deepEqual(ok(at(t - 600), { toleranceS: 900 }), { ok: true }, 'the descriptor sets the tolerance');
  assert.equal(ok({ 'stripe-signature': `t=${t},v1=${'0'.repeat(64)}` }, { now: T0 + 10_000_000 }).reason, 'signature_mismatch', 'a forged stale request is a bad signature first');
});

test('slack, hmac and basic: each recipe signs what it says and refuses what differs', () => {
  const raw = Buffer.from('{"event_id":"Ev1"}');
  const t = String(Math.floor(T0 / 1000));
  const slack = { 'x-slack-signature': `v0=${hmacHex('sha256', SECRET, `v0:${t}:${raw}`)}`, 'x-slack-request-timestamp': t };
  const v = (recipe, headers, opts = {}) => verifySignature(recipe, { headers, raw, secrets: [SECRET], now: T0, ...opts });
  assert.deepEqual(v({ scheme: 'slack' }, slack), { ok: true });
  assert.equal(v({ scheme: 'slack' }, { ...slack, 'x-slack-request-timestamp': String(Number(t) + 1) }).reason, 'signature_mismatch');
  assert.equal(v({ scheme: 'slack' }, { 'x-slack-signature': slack['x-slack-signature'] }).reason, 'signature_missing');
  assert.equal(v({ scheme: 'slack' }, { ...slack, 'x-slack-request-timestamp': 'yesterday' }).reason, 'signature_malformed');
  const gh = { scheme: 'hmac', header: 'X-Hub-Signature-256', algo: 'sha256', encoding: 'hex', prefix: 'sha256=' };
  assert.deepEqual(v(gh, { 'x-hub-signature-256': `sha256=${hmacHex('sha256', SECRET, raw)}` }), { ok: true });
  assert.equal(v(gh, { 'x-hub-signature-256': hmacHex('sha256', SECRET, raw) }).reason, 'signature_mismatch', 'the prefix is part of the value');
  const b64 = { scheme: 'hmac', header: 'x-sig', algo: 'sha1', encoding: 'base64', signed: 'ts.raw', timestampHeader: 'x-ts' };
  const sig = crypto.createHmac('sha1', SECRET).update(`${t}.${raw}`).digest('base64');
  assert.deepEqual(v(b64, { 'x-sig': sig, 'x-ts': t }), { ok: true });
  assert.equal(v(b64, { 'x-sig': sig, 'x-ts': String(Number(t) - 1000) }).reason, 'signature_mismatch');
  assert.equal(v(b64, { 'x-sig': crypto.createHmac('sha1', SECRET).update(`${Number(t) - 1000}.${raw}`).digest('base64'), 'x-ts': String(Number(t) - 1000) }).reason, 'timestamp_stale');
  const basic = `Basic ${Buffer.from(SECRET).toString('base64')}`;
  assert.deepEqual(v({ scheme: 'basic' }, { authorization: basic }), { ok: true });
  assert.deepEqual(v({ scheme: 'basic' }, { authorization: basic }, { secrets: [PREV, SECRET] }), { ok: true });
  assert.equal(v({ scheme: 'basic' }, { authorization: `Basic ${Buffer.from('nope').toString('base64')}` }).reason, 'signature_mismatch');
  assert.equal(v({ scheme: 'basic' }, {}).reason, 'signature_missing');
  assert.equal(v({ scheme: 'basic' }, { authorization: basic }, { secrets: [] }).reason, 'secret_not_set');
});

test('a signature of any length is a refusal, never a throw (timingSafeEqual throws on unequal lengths)', () => {
  const raw = Buffer.from('{}');
  const recipes = [{ scheme: 'stripe' }, { scheme: 'slack' }, { scheme: 'hmac', header: 'x-sig', algo: 'sha256', encoding: 'hex' }, { scheme: 'basic' }];
  const wrong = (recipe, sig) => ({ stripe: { 'stripe-signature': `t=1700000000,v1=${sig}` }, slack: { 'x-slack-signature': sig, 'x-slack-request-timestamp': '1700000000' },
    hmac: { 'x-sig': sig }, basic: { authorization: sig } })[recipe.scheme];
  for (const recipe of recipes) for (const sig of ['a', 'ab', 'x'.repeat(63), 'x'.repeat(65), 'é'.repeat(40), 'x'.repeat(100_000)]) {
    assert.equal(verifySignature(recipe, { headers: wrong(recipe, sig), raw, secrets: [SECRET], now: T0 }).ok, false);
  }
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('é', 'é'), true);
});

test('every comparison of a signature goes through timingSafeEqual, and every secret is compared', () => {
  const real = crypto.timingSafeEqual;
  let calls = 0;
  crypto.timingSafeEqual = (a, b) => { calls++; return real(a, b); };
  try {
    const raw = Buffer.from('{}');
    const t = '1700000000';
    const headers = { 'stripe-signature': `t=${t},v1=${hmacHex('sha256', SECRET, `${t}.${raw}`)}` };
    assert.equal(verifySignature({ scheme: 'stripe' }, { headers, raw, secrets: [SECRET, PREV], now: T0 }).ok, true);
    assert.equal(calls, 2, 'the first secret matched, the second is still compared: no early exit');
    calls = 0;
    verifySignature({ scheme: 'basic' }, { headers: { authorization: `Basic ${Buffer.from(SECRET).toString('base64')}` }, raw, secrets: [SECRET, 'x'.repeat(SECRET.length)], now: T0 });
    assert.equal(calls, 2);
  } finally { crypto.timingSafeEqual = real; }
});

test('signHeaders writes what verifySignature reads, for every recipe', () => {
  const raw = Buffer.from('{"a":1}');
  const recipes = [{ scheme: 'stripe' }, { scheme: 'stripe', header: 'X-Pay-Sig' }, { scheme: 'slack' }, { scheme: 'basic' },
    { scheme: 'hmac', header: 'x-sig', algo: 'sha1', encoding: 'base64', prefix: 'sha1=', signed: 'ts.raw', timestampHeader: 'x-ts' }, { scheme: 'hmac', header: 'x-sig', algo: 'sha256', encoding: 'hex' }];
  for (const recipe of recipes) {
    const headers = signHeaders(recipe, { raw, secret: SECRET, now: T0 });
    assert.ok(Object.keys(headers).every((k) => k === k.toLowerCase()), 'header names are lower case, as Node reads them');
    assert.deepEqual(verifySignature(recipe, { headers, raw, secrets: [SECRET], now: T0 }), { ok: true }, JSON.stringify(recipe));
    if (recipe.scheme !== 'basic') assert.equal(verifySignature(recipe, { headers, raw: Buffer.from('{"a":2}'), secrets: [SECRET], now: T0 }).ok, false, 'another body');
    assert.equal(verifySignature(recipe, { headers, raw, secrets: [PREV], now: T0 }).ok, false, 'another secret');
  }
});

test('checkRecipe names what is wrong with a signature recipe', () => {
  const bad = (r) => checkRecipe(r, '/s').map(([p, m]) => `${p}: ${m}`);
  assert.deepEqual(checkRecipe({ scheme: 'stripe' }, '/s'), []);
  assert.deepEqual(checkRecipe({ scheme: 'stripe', header: 'x-s' }, '/s'), []);
  assert.deepEqual(checkRecipe({ scheme: 'slack' }, '/s'), []);
  assert.deepEqual(checkRecipe({ scheme: 'basic' }, '/s'), []);
  assert.deepEqual(checkRecipe({ scheme: 'hmac', header: 'x', algo: 'sha1', encoding: 'base64', prefix: 'v=', signed: 'ts.raw', timestampHeader: 'x-t' }, '/s'), []);
  for (const r of [undefined, null, [], 'stripe', {}, { scheme: 'rot13' }]) assert.match(bad(r)[0], /"scheme"/, JSON.stringify(r));
  assert.match(bad({ scheme: 'slack', header: 'x' })[0], /unknown key "header" for the slack scheme/);
  assert.match(bad({ scheme: 'stripe', header: 'bad header' })[0], /HTTP header name/);
  assert.match(bad({ scheme: 'stripe', header: 5 })[0], /HTTP header name/);
  const hm = { scheme: 'hmac', header: 'x', algo: 'sha256', encoding: 'hex' };
  assert.match(bad({ ...hm, header: undefined })[0], /names the "header"/);
  assert.match(bad({ ...hm, algo: 'md5' })[0], /"algo"/);
  assert.match(bad({ ...hm, encoding: 'latin1' })[0], /"encoding"/);
  assert.match(bad({ ...hm, prefix: 5 })[0], /"prefix"/);
  assert.match(bad({ ...hm, prefix: 'p'.repeat(33) })[0], /"prefix"/);
  assert.match(bad({ ...hm, signed: 'body' })[0], /"signed"/);
  assert.match(bad({ ...hm, signed: 'ts.raw' })[0], /needs the "timestampHeader"/);
  assert.match(bad({ ...hm, signed: 'ts.raw', timestampHeader: 'no good' })[0], /needs the "timestampHeader"/);
  assert.match(bad({ ...hm, timestampHeader: 'x-t' })[0], /proves nothing/);
});

// --- the descriptor's inbound block -------------------------------------------------------------

const EVENT = { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } };
const INBOUND = { signature: { scheme: 'stripe' }, secret: 'webhookSecret', eventId: '$.id', type: '$.type', events: { 'payment.succeeded': EVENT } };
const OP = { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: 'http://127.0.0.1:1/ping' } };
const descOf = (inbound, name = 'psp') => ({ descriptor: 1, name, operations: { ping: OP }, inbound });

test('checkInbound: every rule of the block is an error with a path', () => {
  const bad = (inb) => checkInbound(inb).map(([p, m]) => `${p}: ${m}`);
  assert.deepEqual(checkInbound(INBOUND), []);
  assert.deepEqual(checkInbound({ ...INBOUND, toleranceS: 60, eventId: '$.delivery.id', type: { header: 'x-event' },
    events: { push: { schema: { type: 'object' }, map: { ref: '$.data.order' } } } }), []);
  assert.match(bad('x')[0], /"inbound" is an object/);
  assert.match(bad({ ...INBOUND, extra: 1 }).join('\n'), /unknown key "extra"/);
  assert.match(bad({ ...INBOUND, signature: { scheme: 'nope' } })[0], /"scheme"/);
  for (const secret of [undefined, 5, '1bad', 'a b']) assert.match(bad({ ...INBOUND, secret }).join('\n'), /names the "secret" slot/, String(secret));
  for (const toleranceS of [0, 1.5, 86401, '300']) assert.match(bad({ ...INBOUND, toleranceS }).join('\n'), /toleranceS/, String(toleranceS));
  for (const eventId of [undefined, 5, 'id', '$.a[', [], ['$.a', 'b'], ['$.a', '$.b', '$.c', '$.d', '$.e']]) assert.match(bad({ ...INBOUND, eventId }).join('\n'), /eventId/, JSON.stringify(eventId));
  for (const eventId of [{ header: 'X-Delivery' }, { header: 'a b' }, { header: 'x', more: 1 }]) assert.match(bad({ ...INBOUND, eventId }).join('\n'), /header is not covered by the signature/, 'an unsigned header cannot be the dedup key');
  assert.match(bad({ ...INBOUND, type: 'type' }).join('\n'), /inbound\/type/);
  for (const type of [5, { header: 'a b' }, { header: 'x', more: 1 }, undefined]) assert.match(bad({ ...INBOUND, type }).join('\n'), /"type" is a \$\.path into the JSON body or \{"header"/, JSON.stringify(type));
  for (const events of [undefined, {}, [], 'x']) assert.match(bad({ ...INBOUND, events }).join('\n'), /"events"/, JSON.stringify(events));
  assert.match(bad({ ...INBOUND, events: { a: 5 } })[0], /an inbound event is an object/);
  assert.match(bad({ ...INBOUND, events: { a: {} } })[0], /needs a "schema"/);
  assert.match(bad({ ...INBOUND, events: { a: { schema: { type: 'object', bogus: 1 } } } })[0], /bogus/);
  assert.match(bad({ ...INBOUND, events: { a: { schema: { type: 'string' } } } })[0], /"type" must be "object"/);
  assert.match(bad({ ...INBOUND, events: { a: { ...EVENT, extra: 1 } } })[0], /unknown key "extra"/);
  assert.match(bad({ ...INBOUND, events: { a: { ...EVENT, map: [] } } })[0], /"map" maps a value name/);
  assert.match(bad({ ...INBOUND, events: { a: { ...EVENT, map: { '1x': '$.a' } } } })[0], /cannot be a value name/);
  assert.match(bad({ ...INBOUND, events: { a: { ...EVENT, map: { x: 5 } } } })[0], /a mapped value is a \$\.path/);
  assert.match(bad({ ...INBOUND, events: { a: { ...EVENT, map: { x: 'nope' } } } })[0], /not a path/);
});

test('a descriptor may carry an inbound block; a malformed one is a descriptor error; its secret slot is a slot of the store', () => {
  assert.deepEqual(checkDescriptor(descOf(INBOUND)), []);
  assert.match(checkDescriptor(descOf({ ...INBOUND, secret: undefined })).map(([p, m]) => `${p}: ${m}`).join('\n'), /inbound\/secret/);
  assert.match(checkDescriptor(descOf('x')).map(([p, m]) => m).join('\n'), /"inbound" is an object/);
  const reg = registerDescriptor(createRegistry(), descOf(INBOUND), 'psp.json');
  assert.equal(reg.descriptors.psp.inbound.secret, 'webhookSecret');
});

test('typeOf, eventIdOf, valuesOf and payloadProblems read a payload the way the block says', () => {
  const inb = { ...INBOUND, type: { header: 'X-Event' } };
  const headers = { 'x-event': 'push' };
  assert.equal(typeOf(inb, {}, headers), 'push');
  assert.equal(typeOf(inb, {}, {}), undefined);
  assert.equal(typeOf(INBOUND, { type: 'a.b' }, {}), 'a.b');
  for (const type of [undefined, '', 5, null, {}]) assert.equal(typeOf(INBOUND, { type }, {}), undefined, JSON.stringify(type));
  assert.equal(eventIdOf(inb, { id: 'd-1' }), 'd-1');
  assert.equal(eventIdOf(INBOUND, { id: 'body' }, { id: 'header' }), 'body', 'a header is never the id');
  assert.equal(eventIdOf(INBOUND, { id: 42 }), '42');
  assert.equal(eventIdOf(INBOUND, { id: 'evt' }), 'evt');
  for (const id of [undefined, '', 1.5, 2 ** 60, null, {}, 'x'.repeat(256)]) assert.equal(eventIdOf(INBOUND, { id }), undefined, String(id).slice(0, 10));
  assert.equal(eventIdOf(INBOUND, { id: 'x'.repeat(255) }).length, 255);
  const payload = { id: 'e', data: { object: { order: 7 } }, amount: 5, nested: { a: 1 }, list: [1], gone: null };
  assert.deepEqual(valuesOf({ map: { ref: '$.data.object.order', nope: '$.x.y' } }, payload), { ref: 7, nope: undefined });
  assert.deepEqual(valuesOf({}, payload), { id: 'e', amount: 5, gone: null }, 'without a map: the top-level scalars');
  assert.deepEqual(payloadProblems(EVENT, { id: 'x', more: 'allowed' }), [], 'a provider may send more than the schema names');
  assert.ok(payloadProblems(EVENT, {}).length);
  assert.ok(payloadProblems(EVENT, { id: 5 }).length);
});

// --- the checker: events that an inbound type triggers -------------------------------------------

const graphOf = (events, connectors = { pay: { kind: 'psp', secrets: { webhookSecret: 'pay_whsec' } }, web: { kind: 'http', url: 'http://x.test' } }) => ({
  app: 'chk', data: { Order: { ref: 'text', paid: 'int=0' } }, connectors, events });
const regPsp = () => registerDescriptor(createRegistry(), descOf({ ...INBOUND, events: { 'payment.succeeded': EVENT, 'a.b.c': EVENT } }), 'psp.json');
const DO = [{ block: 'db.createRow', entity: 'Order', values: { ref: '@values.id' } }];
const errs = (events, connectors) => validate(graphOf(events, connectors), regPsp()).map((e) => `${e.path}: ${e.message}`);

test('checker: an inbound event names a connector and an event type its descriptor declares', () => {
  assert.deepEqual(errs([{ inbound: 'pay.payment.succeeded', do: DO }]), []);
  assert.deepEqual(errs([{ inbound: 'pay.a.b.c', do: DO }]), [], 'the type may have dots: the connector is up to the first one');
  assert.deepEqual(errs([{ inbound: 'pay.payment.succeeded', do: DO }, { on: 'Order.created', do: [] }]), []);
  assert.match(errs([{ inbound: 'nope.payment.succeeded', do: DO }])[0], /\/events\/0\/inbound: unknown connector "nope"/);
  assert.match(errs([{ inbound: 'web.payment.succeeded', do: DO }])[0], /receives no webhooks/);
  assert.match(errs([{ inbound: 'pay.refund.created', do: DO }])[0], /sends no event "refund.created"/);
  for (const inbound of ['pay', '.x', 5, null]) assert.match(errs([{ inbound, do: DO }])[0], /not "<connector>.<type>"/, String(inbound));
  assert.match(errs([{ inbound: 'pay.payment.succeeded', on: 'Order.created', do: DO }])[0], /"on" or "inbound", not both/);
  assert.match(errs([{ inbound: 'pay.payment.succeeded', do: [{ block: 'db.nothing' }] }])[0], /unknown block/);
  assert.match(errs([{ inbound: 'pay.payment.succeeded', do: DO }], {})[0], /unknown connector "pay"/);
  assert.match(errs([{ inbound: 'constructor.payment.succeeded', do: DO }])[0], /unknown connector "constructor"/);
  assert.match(errs([{ inbound: 'pay.constructor', do: DO }])[0], /sends no event "constructor"/);
  assert.match(errs([{ do: DO }])[0], /unsupported trigger "undefined"/);
});

// --- the route ----------------------------------------------------------------------------------

const money = (n) => ({ type: 'object', required: ['id', 'type'], properties: { id: { type: 'string' }, type: { type: 'string' }, order: { type: 'integer' }, pad: { type: 'string' } }, ...n });
const DESCRIPTORS = {
  psp: descOf({ signature: { scheme: 'stripe' }, secret: 'webhookSecret', toleranceS: 300, eventId: '$.id', type: '$.type', events: {
    'payment.succeeded': { schema: { type: 'object', required: ['id', 'type', 'data'], properties: { id: { type: 'string' }, type: { type: 'string' }, data: { type: 'object' } } }, map: { order: '$.data.object.order' } },
    'payment.failed': { schema: money() },
    'refund.created': { schema: money() },
  } }, 'psp'),
  gh: descOf({ signature: { scheme: 'hmac', header: 'X-Hub-Signature-256', algo: 'sha256', encoding: 'hex', prefix: 'sha256=' }, secret: 'secret', eventId: '$.delivery', type: { header: 'X-Event' },
    events: { push: { schema: { type: 'object' } } } }, 'gh'),
  slk: descOf({ signature: { scheme: 'slack' }, secret: 'signing', eventId: '$.event_id', type: '$.event.type', events: { app_mention: { schema: { type: 'object', required: ['event_id'], properties: { event_id: { type: 'string' } } } } } }, 'slk'),
  pm: descOf({ signature: { scheme: 'basic' }, secret: 'auth', eventId: '$.ID', type: '$.RecordType', events: { Bounce: { schema: { type: 'object', required: ['ID'], properties: { ID: { type: 'integer' } } } } } }, 'pm'),
};
const APP = {
  app: 'hooks',
  plugins: Object.keys(DESCRIPTORS).map((k) => `./${k}.json`),
  data: { User: { email: 'text!', password: 'password!', role: 'enum[admin,member]=member' }, Order: { ref: 'text', status: 'enum[open,paid]=open', count: 'int=0', stock: 'int=0', note: 'text' } },
  roles: { entity: 'User', login: 'email', password: 'password', role: 'role', can: { admin: '*', member: { Order: ['view'] } } },
  seed: { User: [{ email: 'admin@x.test', password: 'pw', role: 'admin' }], Order: [{ ref: 'A' }, { ref: 'B' }] },
  connectors: {
    pay: { kind: 'psp', secrets: { webhookSecret: 'pay_whsec' } }, git: { kind: 'gh', secrets: { secret: 'gh_secret' } },
    chat: { kind: 'slk', secrets: { signing: 'slack_signing' } }, mail: { kind: 'pm', secrets: { auth: 'pm_auth' } }, web: { kind: 'http', url: 'http://127.0.0.1:1/x' },
  },
  events: [
    { inbound: 'pay.payment.succeeded', do: [{ block: 'db.adjust', entity: 'Order', id: '@values.order', field: 'count', by: 1 }, { block: 'db.set', entity: 'Order', id: '@values.order', set: { status: 'paid' } }] },
    { inbound: 'pay.payment.failed', do: [{ block: 'db.adjust', entity: 'Order', id: '@values.order', field: 'stock', by: -1, min: 0, message: 'out of stock' }] },
    { inbound: 'git.push', do: [{ block: 'db.adjust', entity: 'Order', id: 1, field: 'count', by: 1 }] },
    { inbound: 'chat.app_mention', do: [{ block: 'db.adjust', entity: 'Order', id: 1, field: 'count', by: 1 }] },
    { inbound: 'mail.Bounce', do: [{ block: 'db.adjust', entity: 'Order', id: 1, field: 'count', by: 1 }] },
  ],
};

const CONNECTOR = { psp: 'pay', gh: 'git', slk: 'chat', pm: 'mail' }; // descriptor kind -> the app's connector name

async function world(t, { secrets = { pay_whsec: SECRET, gh_secret: SECRET, slack_signing: SECRET, pm_auth: SECRET } } = {}) {
  const src = tmpDir('ag-hookapp-', t);
  for (const [k, d] of Object.entries(DESCRIPTORS)) fs.writeFileSync(path.join(src, `${k}.json`), JSON.stringify(d));
  fs.writeFileSync(path.join(src, 'app.json'), JSON.stringify(APP));
  const clock = fakeClock(T0);
  const app = await boot(path.join(src, 'app.json'), { clock, noTimers: true });
  t.after(() => app.close());
  const store = openSecrets({ dir: app.dir, app: 'hooks', env: {} });
  for (const [k, v] of Object.entries(secrets)) store.set(k, v);
  const recipe = (name) => DESCRIPTORS[name].inbound.signature;
  const send = (name, raw, headers = {}) => fetch(`${app.base}/hook/${CONNECTOR[name] ?? name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  // A signed request as the provider sends it; `over` replaces headers after signing.
  const signed = async (name, payload, { secret = SECRET, now = clock.now(), headers = {}, raw = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)) } = {}) => {
    const res = await send(name, raw, { ...signHeaders(recipe(DESCRIPTORS[name].name), { raw, secret, now }), ...headers });
    return { status: res.status, body: await res.json(), type: res.headers.get('content-type') };
  };
  const order = async (id) => await app.app.store.get('Order', id);
  const ledger = () => app.app.store.drv.all('SELECT * FROM "_inbound"');
  return { app, clock, store, send, signed, order, ledger, dir: app.dir };
}
const succeeded = (id = 'evt_1', order = 1) => ({ id, type: 'payment.succeeded', data: { object: { order } } });

test('accept: a signed payment.succeeded runs the event\'s steps with the mapped values, once, and answers JSON', async (t) => {
  const w = await world(t);
  const r = await w.signed('psp', succeeded());
  assert.deepEqual(r, { status: 200, body: { ok: true }, type: 'application/json; charset=utf-8' });
  assert.equal((await w.order(1)).status, 'paid');
  assert.equal((await w.order(1)).count, 1);
  assert.equal((await w.order(2)).status, 'open');
  assert.deepEqual(w.ledger().map((x) => [x.key, x.connector, x.eventId, x.receivedAt]), [['pay|evt_1', 'pay', 'evt_1', T0]]);
  const trace = w.app.trace();
  assert.ok(trace.some((e) => e.kind === 'webhook' && e.connector === 'pay' && e.type === 'payment.succeeded' && e.eventId === 'evt_1'));
  assert.ok(trace.some((e) => e.kind === 'event' && e.inbound === 'pay.payment.succeeded'));
});

test('the route needs no session: it answers while every page asks for a login, ignores accept: text/html, and sets no cookie', async (t) => {
  const w = await world(t);
  const page = await w.app.get('/Order');
  assert.ok(page.location.startsWith('/login'), 'the session gate is on');
  const res = await w.send('psp', JSON.stringify(succeeded()), { accept: 'text/html', cookie: 'sid=garbage', ...signHeaders({ scheme: 'stripe' }, { raw: Buffer.from(JSON.stringify(succeeded())), secret: SECRET, now: T0 }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('set-cookie'), null);
  const bad = await w.send('psp', '{}', { accept: 'text/html' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('content-type'), /^application\/json/);
  assert.equal((await w.app.get('/login')).status, 200);
});

test('every recipe end to end: stripe, a header-typed hmac, slack, basic', async (t) => {
  const w = await world(t);
  const push = (delivery, headers = { 'x-event': 'push' }) => { const raw = Buffer.from(JSON.stringify({ ref: 'main', ...(delivery ? { delivery } : {}) })); return w.signed('gh', '', { raw, headers }); };
  assert.deepEqual((await push('d-1')).body, { ok: true });
  assert.equal((await push('d-1', { 'x-event': 'push' })).body.duplicate, true);
  assert.equal((await push(undefined)).body.error, 'invalid_event_id', 'no delivery id in the body, no dedup key');
  assert.equal((await push('d-2', {})).body.error, 'missing_type');
  assert.equal((await w.signed('slk', { event_id: 'Ev1', event: { type: 'app_mention' } })).status, 200);
  assert.equal((await w.signed('slk', { event_id: 'Ev1', event: { type: 'app_mention' } })).body.duplicate, true);
  assert.equal((await w.signed('pm', { ID: 77, RecordType: 'Bounce' })).status, 200);
  assert.equal((await w.signed('pm', { ID: 77, RecordType: 'Bounce' })).body.duplicate, true, 'a numeric id is text in the ledger');
  assert.equal((await w.order(1)).count, 3, 'one push, one mention, one bounce');
  assert.deepEqual(w.ledger().map((x) => x.key).sort(), ['chat|Ev1', 'git|d-1', 'mail|77']);
});

test('bad signature: 401 with one fixed word whatever the reason, the reason only in the trace, nothing written', async (t) => {
  const w = await world(t);
  const body = { ...succeeded(), marker: 'PAYLOAD_MARKER_4711' };
  const raw = Buffer.from(JSON.stringify(body));
  const good = signHeaders({ scheme: 'stripe' }, { raw, secret: SECRET, now: T0 });
  const cases = {
    signature_mismatch: signHeaders({ scheme: 'stripe' }, { raw, secret: 'another-secret', now: T0 }),
    signature_missing: {},
    signature_malformed: { 'stripe-signature': 'nonsense' },
  };
  for (const [reason, headers] of Object.entries(cases)) {
    const res = await w.send('psp', raw, headers);
    assert.equal(res.status, 401, reason);
    assert.deepEqual(await res.json(), { ok: false, error: 'unauthorized' });
    assert.ok(w.app.trace().some((e) => e.kind === 'webhook_rejected' && e.reason === reason && e.connector === 'pay'), reason);
  }
  const tampered = await w.send('psp', JSON.stringify({ ...body, order: 2 }), good);
  assert.equal(tampered.status, 401, 'a changed body under a signature of the original');
  assert.equal((await w.order(1)).count, 0);
  assert.deepEqual(w.ledger(), []);
  const traceText = fs.readFileSync(path.join(w.dir, 'trace.jsonl'), 'utf8');
  assert.ok(!traceText.includes('PAYLOAD_MARKER_4711'), 'the body never reaches the trace');
  assert.ok(!traceText.includes(SECRET), 'nor a secret');
});

test('a signature of the wrong length, in every shape, is a 401 and the server keeps answering', async (t) => {
  const w = await world(t);
  const raw = Buffer.from(JSON.stringify(succeeded()));
  for (const sig of ['a', 'ab'.repeat(31), 'ab'.repeat(33), 'é'.repeat(64)]) {
    const r = await w.send('psp', raw, { 'stripe-signature': `t=${T0 / 1000},v1=${sig}` });
    assert.equal(r.status, 401, sig);
    await r.text();
  }
  assert.equal((await w.send('pm', '{"ID":1,"RecordType":"Bounce"}', { authorization: 'Basic x' })).status, 401);
  assert.equal((await w.signed('psp', succeeded())).status, 200, 'still alive');
  assert.ok(!w.app.trace().some((e) => e.kind === 'webhook_failed' || e.kind === 'error'), 'no exception on the way');
});

test('a stale or too-early timestamp is a 401 (the window is the descriptor\'s toleranceS, 300 s here)', async (t) => {
  const w = await world(t);
  assert.equal((await w.signed('psp', succeeded('e1'), { now: T0 - 300_000 })).status, 200);
  const old = await w.signed('psp', succeeded('e2'), { now: T0 - 301_000 });
  assert.deepEqual([old.status, old.body], [401, { ok: false, error: 'unauthorized' }]);
  assert.equal((await w.signed('psp', succeeded('e3'), { now: T0 + 301_000 })).status, 401);
  assert.ok(w.app.trace().some((e) => e.kind === 'webhook_rejected' && e.reason === 'timestamp_stale'));
  assert.deepEqual(w.ledger().map((x) => x.eventId), ['e1'], 'a refused request leaves no dedup row');
  await w.clock.advance(1_000_000);
  assert.equal((await w.signed('psp', succeeded('e4'))).status, 200, 'the clock is the injected one');
  assert.equal((await w.signed('psp', succeeded('e5'), { now: T0 })).status, 401, 'and a request signed at the old time is now stale');
});

test('rotation: name.prev still signs, a third secret does not, no secret at all is a refusal', async (t) => {
  const w = await world(t);
  w.store.set('pay_whsec', 'whsec_NEW');
  w.store.set('pay_whsec.prev', SECRET);
  assert.equal((await w.signed('psp', succeeded('r1'), { secret: SECRET })).status, 200, 'the previous secret');
  assert.equal((await w.signed('psp', succeeded('r2'), { secret: 'whsec_NEW' })).status, 200, 'the current secret');
  assert.equal((await w.signed('psp', succeeded('r3'), { secret: 'whsec_OTHER' })).status, 401);
  await w.store.remove('pay_whsec.prev');
  assert.equal((await w.signed('psp', succeeded('r4'), { secret: SECRET })).status, 401, 'once the old one is removed it stops');
  await w.store.remove('pay_whsec');
  assert.equal((await w.signed('psp', succeeded('r5'), { secret: 'whsec_NEW' })).status, 401);
  assert.ok(w.app.trace().some((e) => e.kind === 'webhook_rejected' && e.reason === 'secret_not_set'));
});

test('a duplicate is 200 {duplicate:true} and the steps run exactly once', async (t) => {
  const w = await world(t);
  assert.deepEqual((await w.signed('psp', succeeded('dup'))).body, { ok: true });
  assert.deepEqual((await w.signed('psp', succeeded('dup'))).body, { ok: true, duplicate: true });
  assert.deepEqual((await w.signed('psp', succeeded('dup'))).body, { ok: true, duplicate: true });
  assert.equal((await w.order(1)).count, 1);
  assert.equal((await w.signed('psp', succeeded('other'))).status, 200, 'another event id is another event');
  assert.equal((await w.order(1)).count, 2);
  assert.equal(w.ledger().length, 2);
  assert.equal(w.app.trace().filter((e) => e.kind === 'webhook_duplicate').length, 2);
  // an id is unique per connector: another provider may use the same one
  assert.deepEqual((await w.signed('slk', { event_id: 'dup', event: { type: 'app_mention' } })).body, { ok: true });
  assert.deepEqual(w.ledger().map((x) => x.key).sort(), ['chat|dup', 'pay|dup', 'pay|other']);
});

test('rawBody: bytes as sent, refused the moment the declared length or what arrives passes the cap, nothing kept past it', async () => {
  const feed = (headers, chunks, { fail = null } = {}) => {
    const req = new EventEmitter();
    req.headers = headers;
    const result = rawBody(req, 10);
    queueMicrotask(() => { for (const c of chunks) req.emit('data', Buffer.from(c)); if (fail) req.emit('error', fail); else req.emit('end'); });
    return result;
  };
  assert.deepEqual(await feed({}, ['abc', 'de', 'f']), Buffer.from('abcdef'));
  assert.deepEqual(await feed({}, ['0123456789']), Buffer.from('0123456789'), 'exactly the cap');
  assert.deepEqual(await feed({ 'content-length': '10' }, []), Buffer.alloc(0));
  await assert.rejects(feed({}, ['01234', '567890']), TooBig);
  await assert.rejects(feed({}, ['0123456789a', 'more', 'and more']), TooBig);
  const never = new EventEmitter();
  never.headers = { 'content-length': '11' };
  await assert.rejects(rawBody(never, 10), TooBig, 'the declared length is enough: nothing is read');
  assert.equal(never.listenerCount('data'), 0);
  await assert.rejects(feed({}, [], { fail: new Error('socket closed') }), /socket closed/);
  assert.equal((await feed({ 'content-length': 'nonsense' }, ['abc'])).toString(), 'abc');
});

test('a crash before commit leaves no dedup row and no effect; the provider\'s retry is processed exactly once', async (t) => {
  const w = await world(t);
  const drv = w.app.app.store.drv;
  const exec = drv.exec;
  let crash = true;
  drv.exec = (sql) => { if (sql === 'COMMIT' && crash) { crash = false; throw new Error('the process died before COMMIT'); } return exec.call(drv, sql); };
  const first = await w.signed('psp', succeeded('crashy'));
  assert.deepEqual([first.status, first.body], [500, { ok: false, error: 'failed' }]);
  assert.equal((await w.order(1)).count, 0, 'the steps were rolled back with the dedup row');
  assert.equal((await w.order(1)).status, 'open');
  assert.deepEqual(w.ledger(), []);
  assert.deepEqual((await w.signed('psp', succeeded('crashy'))).body, { ok: true }, 'the retry is processed');
  assert.equal((await w.order(1)).count, 1);
  assert.deepEqual((await w.signed('psp', succeeded('crashy'))).body, { ok: true, duplicate: true });
  assert.equal((await w.order(1)).count, 1, 'exactly once');
});

test('the dedup row is written in the same transaction as the steps: a failing step takes it back', async (t) => {
  const w = await world(t);
  const failing = { id: 'f1', type: 'payment.failed', order: 1 };
  const r = await w.signed('psp', failing);
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: 'failed' }], 'out of stock: the provider must retry');
  assert.deepEqual(w.ledger(), [], 'no dedup row survives a failing step');
  const trace = w.app.trace();
  assert.ok(trace.some((e) => e.kind === 'webhook_failed' && /out of stock/.test(e.message)));
  await w.app.app.store.update('Order', 1, { stock: 1 });
  assert.deepEqual((await w.signed('psp', failing)).body, { ok: true }, 'the retry after the cause is gone');
  assert.equal((await w.order(1)).stock, 0);
  assert.deepEqual((await w.signed('psp', failing)).body, { ok: true, duplicate: true });
  assert.equal((await w.order(1)).stock, 0, 'not taken twice');
});

test('an unknown event type is 200 {ignored:true}, traced, with no dedup row; so is a declared type no event subscribes to', async (t) => {
  const w = await world(t);
  for (const type of ['customer.created', 'refund.created']) {
    const r = await w.signed('psp', { id: 'x1', type, order: 1 });
    assert.deepEqual([r.status, r.body], [200, { ok: true, ignored: true }], type);
  }
  assert.deepEqual(w.ledger(), []);
  const ignored = w.app.trace().filter((e) => e.kind === 'webhook_ignored');
  assert.deepEqual(ignored.map((e) => [e.type, e.known]), [['customer.created', false], ['refund.created', true]]);
  assert.equal((await w.signed('psp', { id: 'x2', type: 'constructor' })).body.ignored, true, 'an inherited name is not an event type');
  assert.equal((await w.signed('psp', { id: 'x2', type: '__proto__' })).body.ignored, true);
  const long = await w.signed('psp', { id: 'x3', type: 't'.repeat(5000) });
  assert.equal(long.body.ignored, true);
  assert.equal(w.app.trace().filter((e) => e.kind === 'webhook_ignored').pop().type.length, 64, 'the trace keeps at most 64 characters of a type');
});

test('invalid JSON, a missing type, a payload the schema refuses, an unusable event id: 400, no dedup row', async (t) => {
  const w = await world(t);
  const raw = (s) => ({ raw: Buffer.from(s) });
  assert.deepEqual((await w.signed('psp', 'not json', raw('not json'))).body, { ok: false, error: 'invalid_json' });
  for (const s of ['null', '[]', '"x"', '5']) assert.equal((await w.signed('psp', s, raw(s))).body.error, 'invalid_json', s);
  assert.equal((await w.signed('psp', { id: 'a', data: {} })).body.error, 'missing_type');
  assert.equal((await w.signed('psp', { id: 'a', type: 'payment.succeeded' })).body.error, 'invalid_payload', 'no "data"');
  assert.equal((await w.signed('psp', { id: 5, type: 'payment.succeeded', data: {} })).body.error, 'invalid_payload', 'wrong type of "id"');
  assert.equal((await w.signed('psp', { id: 'x'.repeat(256), type: 'payment.failed' })).body.error, 'invalid_event_id');
  assert.equal((await w.signed('psp', 'not json', raw('not json'))).status, 400);
  assert.deepEqual(w.ledger(), []);
  assert.equal((await w.order(1)).count, 0);
  const reasons = w.app.trace().filter((e) => e.kind === 'webhook_rejected').map((e) => e.reason);
  assert.deepEqual([...new Set(reasons)].sort(), ['invalid_event_id', 'invalid_json', 'invalid_payload', 'missing_type']);
});

test('the 1 MiB cap: a body one byte over is refused 413 (declared or streamed), exactly 1 MiB is read and checked', async (t) => {
  const w = await world(t);
  const CAP = 1024 * 1024;
  const base = JSON.stringify({ ...succeeded('big'), pad: '' });
  const exact = Buffer.from(base.replace('"pad":""', `"pad":"${'p'.repeat(CAP - base.length + 0)}"`));
  assert.equal(exact.length, CAP + 0);
  assert.deepEqual((await w.signed('psp', null, { raw: exact })).body, { ok: true }, 'exactly the cap is accepted');
  const over = Buffer.alloc(CAP + 1, 0x20);
  const declared = await w.send('psp', over, {});
  assert.deepEqual([declared.status, await declared.json()], [413, { ok: false, error: 'too_large' }]);
  assert.equal(declared.headers.get('connection'), 'close');
  // streamed (chunked, no content-length): the cap is enforced while reading
  const streamed = await new Promise((resolve, reject) => {
    const req = http.request(`${w.app.base}/hook/pay`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    for (let i = 0; i < 17; i++) req.write(chunk);
    req.end();
  });
  assert.deepEqual([streamed.status, JSON.parse(streamed.body)], [413, { ok: false, error: 'too_large' }]);
  assert.ok(w.app.trace().some((e) => e.kind === 'webhook_rejected' && e.reason === 'too_large'));
  assert.equal(w.ledger().length, 1);
});

test('nothing of the payload is echoed: not in an answer (accepted, refused, failing), not in the trace', async (t) => {
  const w = await world(t);
  const marker = 'ECHO_MARKER_8842';
  const answers = [
    await w.signed('psp', { ...succeeded('m1'), marker }),
    await w.signed('psp', { ...succeeded('m1'), marker }),
    await w.signed('psp', { id: marker, type: 'payment.failed', order: 1 }),
    await w.signed('psp', { id: 'm3', type: marker }),
    await w.signed('psp', { id: marker, marker }, {}),
    await w.signed('psp', { ...succeeded('m4'), marker }, { secret: 'wrong' }),
    await w.signed('psp', `{${marker}`, { raw: Buffer.from(`{${marker}`) }),
  ];
  for (const a of answers) assert.ok(!JSON.stringify(a).includes(marker), JSON.stringify(a));
  const lines = fs.readFileSync(path.join(w.dir, 'trace.jsonl'), 'utf8').split('\n').filter((l) => l.includes(marker));
  // the one place a value of a signed payload may appear: the type of an event nobody asked for, so an operator can see what to subscribe to
  assert.deepEqual(lines.map((l) => JSON.parse(l)).map((e) => [e.kind, e.type]), [['webhook_ignored', marker]]);
  assert.ok(!fs.readFileSync(path.join(w.dir, 'trace.jsonl'), 'utf8').includes(`{${marker}`), 'no raw text in the trace');
});

test('unknown connector, a connector with no inbound block, other methods, other paths', async (t) => {
  const w = await world(t);
  for (const name of ['nothere', 'web', '__proto__', 'constructor', 'toString']) {
    const r = await w.send(name, '{}', {});
    assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: 'not_found' }], name);
  }
  const get = await fetch(`${w.app.base}/hook/pay`);
  assert.deepEqual([get.status, get.headers.get('allow'), await get.json()], [405, 'POST', { ok: false, error: 'method_not_allowed' }]);
  assert.equal((await fetch(`${w.app.base}/hook/pay`, { method: 'PUT', body: '{}' })).status, 405);
  assert.equal((await fetch(`${w.app.base}/hook/nothere`)).status, 404, 'an unknown name is 404 whatever the method');
  assert.ok((await w.app.get('/hook')).location.startsWith('/login'), '/hook alone is not the route');
  assert.ok((await w.app.get('/hook/pay/extra')).location.startsWith('/login'), 'nor is a longer path');
  assert.deepEqual(w.ledger(), []);
});

test('an inherited name is never a connector, even when the prototype chain would answer for it', async (t) => {
  const w = await world(t);
  // with `kind` on Object.prototype, graph.connectors.constructor (a function) would have kind "psp": only an own-property test keeps it out
  Object.prototype.kind = 'psp';
  try {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = await fetch(`${w.app.base}/hook/${name}`, { method: 'POST', body: '{}' }); // not through send(): its own name table is inherited-prone too
      assert.deepEqual([r.status, await r.json()], [404, { ok: false, error: 'not_found' }], name);
    }
  } finally { delete Object.prototype.kind; }
});

test('secrets that cannot be read are a 500 (the provider retries), not a pass', async (t) => {
  const w = await world(t);
  fs.writeFileSync(path.join(w.dir, 'secrets.enc'), 'garbage');
  const r = await w.signed('psp', succeeded('s1'), {});
  assert.deepEqual([r.status, r.body], [500, { ok: false, error: 'failed' }]);
  assert.ok(w.app.trace().some((e) => e.kind === 'webhook_failed' && /secrets.enc cannot be read/.test(e.message)));
  assert.deepEqual(w.ledger(), []);
});

test('effects a webhook\'s steps queue are delivered after its commit, like any other event', async (t) => {
  const w = await world(t);
  const store = w.app.app.store;
  const before = (await store.outbox()).length;
  await store.enqueue({ kind: 'http', connector: 'web', target: 'http://127.0.0.1:1/x', payload: { a: 1 } });
  assert.equal((await store.outbox()).length, before + 1);
  assert.equal((await w.signed('psp', succeeded('eff'))).status, 200, 'a flush that finds an undeliverable row does not fail the webhook');
});

test('the flusher prunes dedup rows older than 30 days, at most once an hour, on the injected clock', async (t) => {
  const dir = tmpDir('ag-prune-', t);
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'prune', data: { A: { n: 'text' } } }));
  const clock = fakeClock(T0);
  const app = await boot(file, { clock, noTimers: false });
  t.after(() => app.close());
  const store = app.app.store;
  const old = T0 - INBOUND_RETENTION_MS - 1000;
  await store.inboundAdd('c', 'old', old);
  await store.inboundAdd('c', 'fresh', T0 - INBOUND_RETENTION_MS + 60_000);
  await clock.advance(5000);
  assert.deepEqual(store.drv.all('SELECT "eventId" FROM "_inbound"').map((r) => r.eventId), ['fresh'], 'the first tick prunes');
  await store.inboundAdd('c', 'old2', clock.now() - INBOUND_RETENTION_MS - 1000);
  await clock.advance(5000 * 10);
  assert.ok(await store.inboundSeen('c', 'old2'), 'not again within the hour');
  await clock.advance(3_600_000);
  assert.ok(!await store.inboundSeen('c', 'old2'), 'pruned at the next tick after an hour');
  assert.equal(await store.inboundPrune(0), 0);
  assert.ok(app.app.flusher);
});

test('the dedup ledger is an ordinary table: the key is the pair, a second insert of it fails', async (t) => {
  const dir = tmpDir('ag-ledger-', t);
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'ledger', data: { A: { n: 'text' } } }));
  const app = await boot(file, { noTimers: true });
  t.after(() => app.close());
  const store = app.app.store;
  assert.equal(await store.inboundSeen('a', '1'), false);
  await store.inboundAdd('a', '1', 5);
  assert.equal(await store.inboundSeen('a', '1'), true);
  assert.equal(await store.inboundSeen('b', '1'), false);
  assert.equal(await store.inboundSeen('a', '2'), false);
  await assert.rejects(async () => await store.inboundAdd('a', '1', 6), /UNIQUE|PRIMARY/i);
  assert.equal(await store.inboundPrune(6), 1);
});

// --- --connectors simulate ----------------------------------------------------------------------

test('--connectors simulate signs the payload with the stored secret and posts it to the local /hook', async (t) => {
  const w = await world(t);
  const file = path.join(w.dir, 'succeeded.json');
  fs.writeFileSync(file, JSON.stringify(succeeded('sim1')));
  const graphFile = path.join(tmpDir('ag-simapp-', t), 'app.json');
  for (const [k, d] of Object.entries(DESCRIPTORS)) fs.writeFileSync(path.join(path.dirname(graphFile), `${k}.json`), JSON.stringify(d));
  fs.writeFileSync(graphFile, JSON.stringify(APP));
  const run = async (...args) => {
    const out = [], errs = [];
    const { code } = await main([graphFile, '--connectors', ...args, '--db', path.join(w.dir, 'data.sqlite'), '--port', new URL(w.app.base).port], { log: (m) => out.push(String(m)), err: (m) => errs.push(String(m)), clock: w.clock });
    return { code, out, errs };
  };
  const first = await run('simulate', 'pay', 'payment.succeeded', '--data', file);
  assert.deepEqual([first.code, first.out, first.errs], [0, ['200 {"ok":true}'], []]);
  assert.equal((await w.order(1)).status, 'paid');
  const again = await run('simulate', 'pay', 'payment.succeeded', '--data', file);
  assert.deepEqual([again.code, again.out], [0, ['200 {"ok":true,"duplicate":true}']], 'the same payload is the same event');
  assert.equal((await w.order(1)).count, 1);
  // a header-typed connector: the type header is set from EVENT, the id is the payload's own
  const push = path.join(w.dir, 'push.json');
  fs.writeFileSync(push, '{"ref":"main","delivery":"sim-1"}');
  assert.deepEqual((await run('simulate', 'git', 'push', '--data', push)).out, ['200 {"ok":true}']);
  assert.deepEqual((await run('simulate', 'git', 'push', '--data', push)).out, ['200 {"ok":true,"duplicate":true}']);
  assert.deepEqual((await run('simulate', 'mail', 'Bounce', '--data', (fs.writeFileSync(path.join(w.dir, 'b.json'), '{"ID":9,"RecordType":"Bounce"}'), path.join(w.dir, 'b.json')))).out, ['200 {"ok":true}']);
  // refusals say what to do and post nothing
  const refuses = async (args, re) => { const r = await run(...args); assert.equal(r.code, 1); assert.match(r.errs.join('\n'), re); assert.deepEqual(r.out, []); };
  await refuses(['simulate', 'nope', 'x', '--data', file], /no connector "nope"/);
  await refuses(['simulate', 'web', 'x', '--data', file], /receives no webhooks/);
  await refuses(['simulate', 'pay', '--data', file], /sends events: payment.succeeded/);
  await refuses(['simulate', 'pay', 'refund.nothing', '--data', file], /sends no event "refund.nothing"/);
  await refuses(['simulate', 'pay', 'payment.succeeded'], /needs --data FILE/);
  await refuses(['simulate', 'pay', 'payment.failed', '--data', file], /does not carry the event type "payment.failed"/);
  const junk = path.join(w.dir, 'junk.json');
  fs.writeFileSync(junk, 'not json');
  await refuses(['simulate', 'pay', 'payment.succeeded', '--data', junk], /junk.json is not JSON/);
  await w.store.remove('pay_whsec');
  await refuses(['simulate', 'pay', 'payment.succeeded', '--data', file], /the secret "pay_whsec" is not in the store: --secrets set pay_whsec/);
  const status = await run('status');
  assert.match(status.out.join('\n'), /pay  psp  live .*secrets: pay_whsec MISSING/, 'the webhook secret is one the connector needs, like a request secret');
  w.store.set('pay_whsec', SECRET);
  const refusing = async () => ({ ok: false, status: 401, text: async () => '{"ok":false,"error":"unauthorized"}' });
  const refused = []; const refusedErr = [];
  const { code: refusedCode } = await main([graphFile, '--connectors', 'simulate', 'pay', 'payment.succeeded', '--data', file, '--db', path.join(w.dir, 'data.sqlite')], { log: (m) => refused.push(m), err: (m) => refusedErr.push(m), fetchImpl: refusing, clock: w.clock });
  assert.equal(refusedCode, 1, 'the app refused');
  assert.deepEqual(refused, ['401 {"ok":false,"error":"unauthorized"}']);
  assert.match(refusedErr.join('\n'), /the app answered 401/);
  assert.match((await run('nonsense')).errs.join('\n'), /simulate NAME EVENT --data FILE/);
});

test('the simulated request is exactly the one a provider would send: the secret never appears on the command line or in the output', async (t) => {
  const w = await world(t);
  const graphFile = path.join(tmpDir('ag-simapp2-', t), 'app.json');
  for (const [k, d] of Object.entries(DESCRIPTORS)) fs.writeFileSync(path.join(path.dirname(graphFile), `${k}.json`), JSON.stringify(d));
  fs.writeFileSync(graphFile, JSON.stringify(APP));
  const file = path.join(w.dir, 'p.json');
  fs.writeFileSync(file, JSON.stringify(succeeded('sim-shape')));
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
  const out = [];
  const { code } = await main([graphFile, '--connectors', 'simulate', 'pay', 'payment.succeeded', '--data', file, '--port', '4567', '--db', path.join(w.dir, 'data.sqlite')], { log: (m) => out.push(m), err: (m) => out.push(m), fetchImpl, clock: w.clock });
  assert.equal(code, 0);
  assert.equal(seen[0].url, 'http://127.0.0.1:4567/hook/pay');
  assert.equal(seen[0].init.method, 'POST');
  const t0 = Math.floor(T0 / 1000);
  assert.equal(seen[0].init.headers['stripe-signature'], `t=${t0},v1=${hmacHex('sha256', SECRET, `${t0}.${fs.readFileSync(file)}`)}`);
  assert.deepEqual(Buffer.from(seen[0].init.body), fs.readFileSync(file));
  assert.ok(!out.join('\n').includes(SECRET));
});
