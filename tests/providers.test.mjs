// C5, the first real providers — Stripe, Postmark, Slack — as data (connectors/<name>/descriptor.json) and tested
// without a network: the contract tests of docs/CONNECTORS.md section 6 over every fixture (a sandbox answer
// validates against the operation's output; a recorded answer has the shape of the sandbox's; the request built for
// a fixture's input is the recorded one after redaction), a replayed `fetch` that throws on a miss, a scan that keeps
// secrets out of the fixtures, and the webhooks of each provider signed with a fixed test secret on an injected
// clock, through the real route. The fixtures are written by hand from the providers' public documentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRequest, deliverRow, mapResponse } from '../runtime/connectors/engine.mjs';
import { sandboxAnswer } from '../runtime/connectors/sandbox.mjs';
import { withDefaults, validate } from '../runtime/connectors/schema.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { signHeaders, verifySignature } from '../runtime/connectors/signature.mjs';
import { typeOf, eventIdOf, valuesOf, payloadProblems, challengeOf } from '../runtime/connectors/inbound.mjs';
import { createRegistry, registerDescriptor } from '../runtime/registry.mjs';
import { openSecrets } from '../runtime/secrets.mjs';
import { boot, tmpDir, fakeClock } from './helpers.mjs';
import { loadFixtures, loadDescriptor, connectorNames, replayFetch, canonicalBody, redactHeaders, suspicious, REDACTED } from './replay.mjs';

const NAMES = ['postmark', 'slack', 'stripe'];
const T0 = 1_700_000_000_000;
const KEY = 'sandbox-key-for-the-test';
const DESC = Object.fromEntries(NAMES.map((n) => [n, loadDescriptor(n)]));
const FIX = Object.fromEntries(NAMES.map((n) => [n, loadFixtures(n)]));
const opFixtures = (n) => FIX[n].filter((f) => f.op);
const inboundFixtures = (n) => FIX[n].filter((f) => f.inbound);
const TEST_SECRET = 'TEST_VALUE_OF_';
const secretOf = (slot) => `${TEST_SECRET}${slot}`;
const CONFIG = { postmark: { from: 'shop@example.test' }, slack: {}, stripe: {} };
const rowOf = (op, payload) => ({ id: 1, kind: 'x', connector: 'c', op, payload });

test('the descriptors are the connectors/ directory: three, each valid, sandbox first, each operation says whether it is idempotent', () => {
  assert.deepEqual(connectorNames(), NAMES);
  for (const n of NAMES) {
    const d = DESC[n];
    assert.deepEqual(checkDescriptor(d), [], n);
    assert.deepEqual(d.modes, ['sandbox', 'live'], `${n}: sandbox is the default mode`);
    assert.equal(d.base.startsWith('https://'), true, `${n}: a live base is https`);
    registerDescriptor(createRegistry(), d, `${n}/descriptor.json`);
  }
  assert.deepEqual(Object.keys(DESC.stripe.operations), ['createPaymentIntent', 'retrievePaymentIntent', 'confirmPaymentIntent', 'createRefund']);
  assert.deepEqual(Object.values(DESC.stripe.operations).map((o) => o.idempotent), [true, true, true, true], 'Stripe dedups on the Idempotency-Key header');
  assert.deepEqual(DESC.stripe.idempotency, { header: 'Idempotency-Key' });
  assert.equal(DESC.postmark.operations.sendEmail.idempotent, false, 'a letter is not sent twice on a guess');
  assert.equal(DESC.slack.operations.postMessage.idempotent, false, 'a message is not posted twice on a guess');
  assert.deepEqual(DESC.postmark.inbound.signature, { scheme: 'basic' });
  assert.deepEqual(DESC.slack.inbound.signature, { scheme: 'slack' });
  assert.deepEqual(DESC.stripe.inbound.signature, { scheme: 'stripe' });
  assert.deepEqual(Object.keys(DESC.stripe.inbound.events), ['payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.refunded']);
  assert.deepEqual(Object.keys(DESC.postmark.inbound.events), ['Bounce', 'SubscriptionChange']);
});

// --- (a) the sandbox answers validate against each operation's output ------------------------------------

const SANDBOX_CASES = {
  stripe: {
    createPaymentIntent: [
      [{ amount: 1000, currency: 'usd' }, 'sent', 200, 'requires_payment_method'],
      [{ amount: 1000, currency: 'usd', paymentMethod: 'pm_card_visa' }, 'sent', 200, 'requires_confirmation'],
      [{ amount: 1000, currency: 'usd', paymentMethod: 'pm_card_visa', confirm: true, metadata: { order: '1' } }, 'sent', 200, 'succeeded'],
      [{ amount: 1000, currency: 'usd', paymentMethod: 'pm_card_chargeDeclined', confirm: true }, 'failed', 402],
    ],
    retrievePaymentIntent: [[{ id: 'pi_x1' }, 'sent', 200, 'succeeded']],
    confirmPaymentIntent: [[{ id: 'pi_x1' }, 'sent', 200, 'succeeded'], [{ id: 'pi_x1', paymentMethod: 'pm_card_chargeDeclined' }, 'failed', 402]],
    createRefund: [[{ paymentIntent: 'pi_x1' }, 'sent', 200, 'succeeded'], [{ paymentIntent: 'pi_x1', amount: 5, reason: 'duplicate' }, 'sent', 200, 'succeeded']],
  },
  postmark: {
    sendEmail: [[{ to: 'ann@example.test', subject: 'Hi', text: 'x' }, 'sent', 200], [{ to: 'inactive@example.test', subject: 'Hi', text: 'x' }, 'failed', 422]],
  },
  slack: {
    postMessage: [[{ channel: '#orders', text: 'x' }, 'sent', 200], [{ channel: '#nowhere', text: 'x' }, 'failed', 400], [{ channel: '#flaky', text: 'x' }, 'failed', 503]],
  },
};

test('contract (a): every sandbox rule answers, a success validates against the operation\'s output and a refusal is a failed delivery', async () => {
  for (const n of NAMES) {
    assert.deepEqual(Object.keys(SANDBOX_CASES[n]), Object.keys(DESC[n].operations), `${n}: every operation has sandbox cases`);
    for (const [opName, cases] of Object.entries(SANDBOX_CASES[n])) {
      for (const [input, status, code, state] of cases) {
        const patch = await deliverRow(DESC[n], rowOf(opName, input), CONFIG[n], { mode: 'sandbox', idemKey: KEY });
        const label = `${n}.${opName} ${JSON.stringify(input)}`;
        assert.deepEqual([patch.status, patch.code], [status, code], label);
        if (status === 'sent') {
          assert.equal(patch.drift, 0, `${label}: the sandbox answer fits the output schema`);
          const result = JSON.parse(patch.result);
          assert.deepEqual(Object.keys(result).sort(), Object.keys(DESC[n].operations[opName].result).sort(), label);
          if (state) assert.equal(result.status, state, label);
        }
      }
    }
  }
  // the declined card of the Stripe sandbox, and the sandbox's idempotent fake id
  const a = await deliverRow(DESC.stripe, rowOf('createPaymentIntent', { amount: 1, currency: 'usd' }), {}, { mode: 'sandbox', idemKey: 'k1' });
  const b = await deliverRow(DESC.stripe, rowOf('createPaymentIntent', { amount: 1, currency: 'usd' }), {}, { mode: 'sandbox', idemKey: 'k1' });
  const c = await deliverRow(DESC.stripe, rowOf('createPaymentIntent', { amount: 1, currency: 'usd' }), {}, { mode: 'sandbox', idemKey: 'k2' });
  assert.equal(JSON.parse(a.result).id, JSON.parse(b.result).id, 'a retry gets the same fake id');
  assert.notEqual(JSON.parse(a.result).id, JSON.parse(c.result).id);
  assert.match(JSON.parse(a.result).id, /^pi_sbx_k1$/);
  const declined = await deliverRow(DESC.stripe, rowOf('createPaymentIntent', { amount: 9, currency: 'usd', paymentMethod: 'pm_card_chargeDeclined', confirm: true }), {}, { mode: 'sandbox', idemKey: 'k1' });
  assert.equal(declined.error, 'HTTP 402');
});

test('the inputs are refused by the schema before anything is queued: a bad currency, a bad id, an amount out of range, a bad channel', () => {
  const bad = (n, op, input) => validate(DESC[n].operations[op].input, withDefaults(DESC[n].operations[op].input, input)).map(([, m]) => m).join('; ');
  assert.match(bad('stripe', 'createPaymentIntent', { amount: 100, currency: 'USD' }), /three lower case letters/);
  assert.match(bad('stripe', 'createPaymentIntent', { amount: 0, currency: 'usd' }), /./);
  assert.match(bad('stripe', 'createPaymentIntent', { amount: 100000000, currency: 'usd' }), /./);
  assert.match(bad('stripe', 'createPaymentIntent', { amount: 1.5, currency: 'usd' }), /./);
  assert.match(bad('stripe', 'createPaymentIntent', { amount: 5, currency: 'usd', paymentMethod: '4242424242424242' }), /Stripe id, pm_/);
  assert.match(bad('stripe', 'retrievePaymentIntent', { id: '../refunds' }), /Stripe id, pi_/);
  assert.match(bad('stripe', 'createRefund', { paymentIntent: 'pi_1', reason: 'because' }), /./);
  assert.match(bad('stripe', 'createPaymentIntent', { amount: 5, currency: 'usd', card: '4242' }), /./, 'an input the operation does not know');
  assert.match(bad('postmark', 'sendEmail', { to: 'not-an-address', subject: 'x' }), /./);
  assert.match(bad('postmark', 'sendEmail', { to: 'a@b.test', subject: '' }), /./);
  assert.match(bad('slack', 'postMessage', { channel: 'two words', text: 'x' }), /channel is its id/);
  assert.match(bad('slack', 'postMessage', { channel: '#x', text: '' }), /./);
  assert.equal(bad('slack', 'postMessage', { channel: 'C0123456', text: 'x', threadTs: '1700000000.000100' }), '');
});

// --- (b) a recorded answer has the shape of the sandbox's -----------------------------------------------

// What `a` has, `b` has too, with the same kind of value (keys and types, not values): the sandbox invents nothing the provider lacks.
function lacks(a, b, at = '') {
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (kind(a) !== kind(b)) return [`${at || '/'}: sandbox ${kind(a)}, recorded ${kind(b)}`];
  if (kind(a) !== 'object') return [];
  return Object.keys(a).flatMap((k) => (k in b ? lacks(a[k], b[k], `${at}/${k}`) : [`${at}/${k}: the sandbox has it, the recording does not`]));
}

test('contract (b): for every fixture the sandbox answers with the same keys and types (the recording may have more)', () => {
  const checked = [];
  for (const n of NAMES) {
    for (const f of opFixtures(n)) {
      const op = DESC[n].operations[f.op];
      const hit = sandboxAnswer(DESC[n].sandbox.operations[f.op], { input: withDefaults(op.input, f.input), key: KEY, config: f.config || {} });
      const ok = f.response.status >= 200 && f.response.status < 300;
      if (ok) assert.ok(hit && hit.status === f.response.status, `${n}/${f.file}: the sandbox answers a success where the provider did`);
      if (!hit || hit.status !== f.response.status) continue; // a recorded case the sandbox has no rule for (a rate limit)
      assert.deepEqual(lacks(hit.body, f.response.body), [], `${n}/${f.file}`);
      checked.push(`${n}/${f.file}`);
    }
  }
  assert.ok(checked.length >= 10, `compared ${checked.length} fixtures`);
  for (const n of NAMES) for (const op of Object.keys(DESC[n].operations)) assert.ok(opFixtures(n).some((f) => f.op === op && f.response.status === 200), `${n}.${op} has a recorded success`);
  assert.deepEqual(lacks({ a: 1, b: { c: 'x' } }, { a: 2, b: { c: 'y', d: 1 }, e: 1 }), []);
  assert.deepEqual(lacks({ a: 1 }, {}), ['/a: the sandbox has it, the recording does not']);
  assert.deepEqual(lacks({ a: { b: 1 } }, { a: { b: 'x' } }), ['/a/b: sandbox number, recorded string']);
  assert.deepEqual(lacks({ a: null }, { a: 'x' }), ['/a: sandbox null, recorded string']);
});

// --- (c) the request built for a fixture's input is the recorded one ------------------------------------------

test('contract (c): the request built for each fixture\'s input equals the recording after redaction', () => {
  let count = 0;
  for (const n of NAMES) {
    for (const f of opFixtures(n)) {
      const built = buildRequest(DESC[n], f.config || {}, f.op, withDefaults(DESC[n].operations[f.op].input, f.input), { secret: secretOf, idemKey: f.idemKey });
      const label = `${n}/${f.file}`;
      assert.equal(built.method, f.request.method, label);
      assert.equal(built.url, f.request.url, label);
      assert.deepEqual(redactHeaders(built.headers, [TEST_SECRET]), redactHeaders(f.request.headers, [TEST_SECRET]), `${label}: headers`);
      assert.equal(canonicalBody(built.body), canonicalBody(f.request.body), `${label}: body`);
      if (typeof f.request.body === 'string') assert.equal(built.body, f.request.body, `${label}: a form body is written exactly as recorded, nesting included`);
      assert.equal(JSON.stringify(f.request).includes(TEST_SECRET), false, `${label}: no secret in the recording`);
      count++;
    }
  }
  assert.equal(count, 12);
  const stripe = opFixtures('stripe');
  assert.ok(stripe.every((f) => f.request.headers['idempotency-key'] === 'idem_fixture_1'), 'Stripe\'s native idempotency header carries the row\'s key');
  assert.ok(stripe.filter((f) => f.request.method === 'POST').every((f) => f.request.headers['content-type'] === 'application/x-www-form-urlencoded'));
  assert.ok(opFixtures('stripe').some((f) => /metadata\[order\]=7/.test(f.request.body)), 'nested keys are metadata[k]');
  assert.ok(opFixtures('postmark').every((f) => f.request.headers['x-postmark-server-token'] === REDACTED));
  assert.ok(opFixtures('slack').every((f) => f.request.headers.authorization === REDACTED));
});

// --- the replayed network ----------------------------------------------------------------------------------

test('replayFetch answers from the recordings and throws on a miss — never a default answer, never the network', async () => {
  const fixtures = opFixtures('stripe');
  const fetchImpl = replayFetch(fixtures);
  const f = fixtures.find((x) => x.case === 'created');
  const res = await fetchImpl(f.request.url, { method: 'POST', body: f.request.body, headers: {} });
  assert.equal(res.status, 200);
  assert.equal((await res.json?.() ?? JSON.parse(await res.text())).id, 'pi_3Fixture0001');
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('x-none'), null);
  const reordered = f.request.body.split('&').reverse().join('&');
  assert.equal((await fetchImpl(f.request.url, { method: 'POST', body: reordered })).status, 200, 'a form body in another order is the same request');
  await assert.rejects(fetchImpl(f.request.url, { method: 'POST', body: 'amount=1&currency=usd' }), /replay miss/, 'another body');
  await assert.rejects(fetchImpl(f.request.url, { method: 'GET' }), /replay miss/, 'another method');
  await assert.rejects(fetchImpl('https://api.stripe.com/v1/other', { method: 'POST', body: f.request.body }), /replay miss/, 'another url');
  await assert.rejects(fetchImpl(f.request.url), /replay miss/, 'no init at all');
  assert.equal(fetchImpl.calls.length, 6);
  const json = replayFetch(opFixtures('slack'));
  const p = opFixtures('slack').find((x) => x.case === 'posted');
  assert.equal((await json(p.request.url, { method: 'POST', body: JSON.stringify({ text: p.request.body.text, channel: p.request.body.channel }) })).status, 200, 'a JSON body with its keys in another order is the same request');
  assert.equal(canonicalBody(undefined), '');
  assert.equal(canonicalBody(null), '');
  assert.equal(canonicalBody('b=2&a=1'), 'a=1&b=2');
  assert.equal(canonicalBody('{"b":1,"a":[{"d":1,"c":2}]}'), '{"a":[{"c":2,"d":1}],"b":1}');
});

const UNRECORDED = { stripe: ['retrievePaymentIntent', { id: 'pi_unrecorded' }], postmark: ['sendEmail', { to: 'nobody@example.test', subject: 'x', text: 'y' }], slack: ['postMessage', { channel: '#never', text: 'x' }] };

test('through the engine, replayed: each recording delivers as the provider answered it, and a request nothing recorded is an error', async () => {
  for (const n of NAMES) {
    const fetchImpl = replayFetch(opFixtures(n));
    for (const f of opFixtures(n)) {
      const patch = await deliverRow(DESC[n], rowOf(f.op, f.input), f.config || {}, { mode: 'live', fetchImpl, secret: secretOf, idemKey: f.idemKey });
      const ok = f.response.status >= 200 && f.response.status < 300;
      const want = f.outcome ?? { status: ok ? 'sent' : 'failed', code: f.response.status };
      for (const [k, v] of Object.entries(want)) assert.equal(patch[k], v, `${n}/${f.file}: ${k}`);
      if (ok && !f.outcome) assert.equal(patch.drift, 0, `${n}/${f.file}: the recorded answer fits the output schema`);
    }
    assert.equal(fetchImpl.calls.length, opFixtures(n).length);
    const [op, input] = UNRECORDED[n];
    await assert.rejects(deliverRow(DESC[n], rowOf(op, input), CONFIG[n], { mode: 'live', fetchImpl, secret: secretOf, idemKey: 'k' }), /replay miss/, `${n}: a request nobody recorded`);
  }
  const slack = opFixtures('slack');
  const limited = await deliverRow(DESC.slack, rowOf('postMessage', slack.find((f) => f.case === 'ratelimited').input), {}, { mode: 'live', fetchImpl: replayFetch(slack), secret: secretOf });
  assert.equal(limited.retryAfter, '30', 'the provider\'s Retry-After reaches the retry policy');
});

// --- the fixtures hold no secret -------------------------------------------------------------------------

test('the fixtures are marked as written from the docs, and none holds anything that looks like a secret', () => {
  let files = 0;
  for (const n of NAMES) {
    for (const f of FIX[n]) {
      files++;
      assert.equal(f.recordedAt, null, `${n}/${f.file}`);
      assert.equal(f.source, 'docs', `${n}/${f.file}`);
      assert.equal(typeof f.providerVersion, 'string', `${n}/${f.file}`);
      assert.match(f.note, /written by hand/, `${n}/${f.file}`);
      const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'connectors', n, 'fixtures', f.file), 'utf8');
      assert.deepEqual(suspicious(text), [], `${n}/${f.file}`);
    }
  }
  assert.equal(files, 20);
  assert.deepEqual(suspicious('{"authorization": "Bearer abc"}'), ['a bearer token']);
  // Assembled at run time: a literal key-shaped string would trip the host's push protection.
  assert.equal(suspicious(['sk', 'test', 'Fake0Key0For0The0Scanner0'].join('_'))[0], 'a Stripe secret key (sk_)');
  assert.deepEqual(suspicious('rk_live_abc whsec_abc xoxb-1-2-3'), ['a Stripe key', 'a Stripe webhook secret', 'a Slack token']);
  assert.deepEqual(suspicious('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd'), ['a JWT']);
  assert.equal(suspicious('{"a":"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo="}').length, 1, 'a long random token');
  assert.equal(suspicious('0123456789abcdef0123456789abcdef').length, 1, 'a long hex string');
  assert.deepEqual(suspicious('{"task_id": "sketch", "url": "https://api.stripe.com/v1/payment_intents/pi_3Fixture0001/confirm", "type": "application/x-www-form-urlencoded"}'), [], 'ordinary words, urls and media types');
  assert.deepEqual(suspicious('pi_3Fixture0001_secret_f01'), [], 'a plainly fake id');
});

// --- the webhooks of each provider, signed with a fixed test secret --------------------------------------------

const WEBHOOK_SECRET = { stripe: 'whsec_TEST_ONLY_1', slack: 'slack_signing_TEST_ONLY', postmark: 'hook:test-only-password' };

test('inbound fixtures: signed with the test secret they verify, a changed byte or a stale clock does not, and each yields its type, id and values', () => {
  for (const n of NAMES) {
    const inbound = DESC[n].inbound;
    const secret = WEBHOOK_SECRET[n];
    const seen = new Set();
    for (const f of inboundFixtures(n)) {
      const label = `${n}/${f.file}`;
      const raw = Buffer.from(JSON.stringify(f.request.body));
      const headers = { ...f.request.headers, ...signHeaders(inbound.signature, { raw, secret, now: T0 }) };
      const ok = (extra = {}) => verifySignature(inbound.signature, { headers, raw, secrets: [secret], now: T0, toleranceS: inbound.toleranceS, ...extra });
      assert.deepEqual(ok(), { ok: true }, label);
      if (n !== 'postmark') assert.equal(ok({ raw: Buffer.from(`${raw} `) }).reason, 'signature_mismatch', `${label}: one byte more`);
      assert.equal(ok({ secrets: ['another secret'] }).reason, 'signature_mismatch', label);
      if (n !== 'postmark') assert.equal(ok({ now: T0 + 301_000 }).reason, 'timestamp_stale', `${label}: outside the window`);
      else assert.deepEqual(ok({ now: T0 + 86_400_000 }), { ok: true }, 'basic auth has no clock');
      const payload = f.request.body;
      if (f.answer) {
        assert.equal(challengeOf(inbound, payload), f.answer.challenge, label);
        continue;
      }
      const type = typeOf(inbound, payload, headers);
      assert.equal(type, f.inbound, label);
      const ev = inbound.events[type];
      assert.deepEqual(payloadProblems(ev, payload), [], label);
      assert.equal(typeof eventIdOf(inbound, payload, ev), 'string', `${label}: it has an id`);
      assert.deepEqual(JSON.parse(JSON.stringify(valuesOf(ev, payload))), f.values, label); // an absent value is left out
      seen.add(type);
    }
    assert.deepEqual([...seen].sort(), Object.keys(inbound.events).sort(), `${n}: every declared event has a fixture`);
  }
});

// A graph that takes every event of every provider: each logs one row (its kind), so what the route accepted can be counted.
const connectorsOf = { pay: 'stripe', mail: 'postmark', chat: 'slack' };
const CONN = { stripe: 'pay', postmark: 'mail', slack: 'chat' };
const GRAPH = (dir) => ({
  app: 'prov',
  plugins: NAMES.map((n) => path.join(dir, `${n}.json`)),
  data: { Log: { kind: 'text!', note: 'text' } },
  connectors: {
    pay: { kind: 'stripe', secrets: { webhookSecret: 'pay_whsec' } },
    mail: { kind: 'postmark', from: 'shop@example.test', secrets: { webhookAuth: 'mail_hook' } },
    chat: { kind: 'slack', secrets: { signingSecret: 'chat_sign' } },
  },
  actions: [
    { name: 'charge', do: [{ block: 'connector.call', connector: 'pay', op: 'createPaymentIntent', input: { amount: 2500, currency: 'usd', paymentMethod: 'pm_card_visa', confirm: true, metadata: { order: '7' } } }] },
    { name: 'decline', do: [{ block: 'connector.call', connector: 'pay', op: 'createPaymentIntent', input: { amount: 900, currency: 'usd', paymentMethod: 'pm_card_chargeDeclined', confirm: true } }] },
    { name: 'letter', do: [{ block: 'connector.call', connector: 'mail', op: 'sendEmail', input: { to: 'ann@example.test', subject: 'Receipt', text: 'Thanks' } }] },
    { name: 'sayOk', do: [{ block: 'connector.call', connector: 'chat', op: 'postMessage', input: { channel: '#orders', text: 'paid' } }] },
    { name: 'sayNowhere', do: [{ block: 'connector.call', connector: 'chat', op: 'postMessage', input: { channel: '#nowhere', text: 'x' } }] },
    { name: 'sayFlaky', do: [{ block: 'connector.call', connector: 'chat', op: 'postMessage', input: { channel: '#flaky', text: 'x' } }] },
  ],
  events: Object.entries(connectorsOf).flatMap(([c, kind]) => Object.keys(DESC[kind].inbound.events)
    .map((type) => ({ inbound: `${c}.${type}`, do: [{ block: 'db.createRow', entity: 'Log', values: { kind: `${c}.${type}`, note: '@values.email' } }] }))),
});

async function world(t) {
  const src = tmpDir('ag-prov-', t);
  for (const n of NAMES) fs.writeFileSync(path.join(src, `${n}.json`), JSON.stringify(DESC[n]));
  fs.writeFileSync(path.join(src, 'app.json'), JSON.stringify(GRAPH(src)));
  const clock = fakeClock(T0);
  const app = await boot(path.join(src, 'app.json'), { clock, noTimers: true });
  t.after(() => app.close());
  const store = openSecrets({ dir: app.dir, app: 'prov', env: {} });
  store.set('pay_whsec', WEBHOOK_SECRET.stripe);
  store.set('mail_hook', WEBHOOK_SECRET.postmark);
  store.set('chat_sign', WEBHOOK_SECRET.slack);
  // A request as the provider sends it; `at` is the time it signs with, `headers` replace after signing, `sign: false` sends it bare.
  const hook = async (n, payload, { secret = WEBHOOK_SECRET[n], at = clock.now(), headers = {}, sign = true, raw = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)) } = {}) => {
    const signed = sign ? signHeaders(DESC[n].inbound.signature, { raw, secret, now: at }) : {};
    const res = await fetch(`${app.base}/hook/${CONN[n]}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed, ...headers }, body: raw });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text), type: res.headers.get('content-type') };
  };
  const logs = () => app.app.store.drv.all('SELECT * FROM "Log"').map((r) => r.kind);
  const ledger = () => app.app.store.drv.all('SELECT * FROM "_inbound"');
  return { app, clock, hook, logs, ledger };
}

test('route: every provider fixture, signed, is accepted once and runs its event; a retry is a duplicate; a tampered body is refused', async (t) => {
  const w = await world(t);
  let accepted = 0;
  for (const n of NAMES) {
    for (const f of inboundFixtures(n).filter((x) => !x.answer)) {
      const label = `${n}/${f.file}`;
      const r = await w.hook(n, f.request.body);
      assert.deepEqual([r.status, r.body], [200, { ok: true }], label);
      assert.deepEqual((await w.hook(n, f.request.body)).body, { ok: true, duplicate: true }, `${label}: the provider's retry`);
      accepted++;
      if (n === 'postmark') continue; // basic credentials do not cover the body; the others do:
      const signed = Buffer.from(JSON.stringify(f.request.body));
      const sig = signHeaders(DESC[n].inbound.signature, { raw: signed, secret: WEBHOOK_SECRET[n], now: w.clock.now() });
      const bad = await fetch(`${w.app.base}/hook/${CONN[n]}`, { method: 'POST', headers: { 'content-type': 'application/json', ...sig }, body: Buffer.from(`${signed} `) });
      assert.equal(bad.status, 401, `${label}: a body that is not the signed one`);
    }
  }
  assert.equal(accepted, 7);
  assert.equal(w.logs().length, 7, 'one Log row per event, not per request');
  assert.equal(w.ledger().length, 7);
});

test('route: Stripe — only its three events, the signature with a window, and an event for no graph step is ignored', async (t) => {
  const w = await world(t);
  const paid = inboundFixtures('stripe').find((f) => f.case === 'paid').request.body;
  assert.equal((await w.hook('stripe', paid, { sign: false })).status, 401);
  assert.equal((await w.hook('stripe', paid, { secret: 'whsec_wrong' })).status, 401);
  assert.equal((await w.hook('stripe', paid, { at: T0 - 301_000 })).status, 401, 'a signature made five minutes ago and a second');
  assert.equal((await w.hook('stripe', paid, { at: T0 - 299_000 })).status, 200);
  const other = await w.hook('stripe', { ...paid, id: 'evt_other', type: 'customer.created' });
  assert.deepEqual(other.body, { ok: true, ignored: true });
  assert.equal(w.logs().length, 1);
  // a payment made outside this app has no order: answered (Stripe would retry anything else), never run, never remembered
  for (const [what, metadata] of [['no metadata', undefined], ['empty metadata', {}], ['a null order', { order: null }]]) {
    const r = await w.hook('stripe', { ...paid, id: `evt_noorder_${what}`, data: { object: { id: 'pi_x', amount: 5, metadata } } });
    assert.deepEqual([what, r.status, r.body], [what, 200, { ok: true, ignored: true }]);
  }
  assert.equal(w.logs().length, 1, 'no step ran for them');
  assert.equal(w.ledger().length, 1, 'and no dedup row was written');
  assert.ok(w.app.trace().some((e) => e.kind === 'webhook_ignored' && e.type === 'payment_intent.succeeded' && e.missing === 'order'));
  assert.deepEqual((await w.hook('stripe', { ...paid, id: 'evt_noorder_again', data: { object: { id: 'pi_x', amount: 5, metadata: { order: '8' } } } })).body, { ok: true }, 'with an order it runs');
});

test('route: Postmark — basic credentials, a bounce by its id, an unsubscribe by message, recipient and time', async (t) => {
  const w = await world(t);
  const bounce = inboundFixtures('postmark').find((f) => f.case === 'hard').request.body;
  const unsub = inboundFixtures('postmark').find((f) => f.case === 'unsubscribed').request.body;
  assert.equal((await w.hook('postmark', bounce, { sign: false })).status, 401);
  assert.equal((await w.hook('postmark', bounce, { secret: 'hook:wrong' })).status, 401);
  assert.equal((await w.hook('postmark', bounce, { headers: { authorization: 'Basic ' } })).status, 401);
  assert.equal((await w.hook('postmark', bounce)).status, 200);
  assert.equal((await w.hook('postmark', { ...bounce, Details: 'again' })).body.duplicate, true, 'the same bounce id is the same event');
  assert.equal((await w.hook('postmark', { ...bounce, ID: 692560174 })).body.duplicate, undefined, 'another id is another event');
  assert.equal((await w.hook('postmark', unsub)).status, 200);
  assert.equal((await w.hook('postmark', unsub)).body.duplicate, true);
  assert.equal((await w.hook('postmark', { ...unsub, ChangedAt: '2024-01-01T00:00:00.0000000Z', SuppressSending: false })).body.duplicate, undefined, 'a later change of the same message is a new event');
  assert.equal((await w.hook('postmark', { ...unsub, Recipient: 'bob@example.test' })).body.duplicate, undefined, 'another recipient is a new event');
  assert.equal((await w.hook('postmark', { ...unsub, MessageID: undefined })).status, 400, 'no message id, no event id');
  assert.deepEqual(w.logs(), ['mail.Bounce', 'mail.Bounce', 'mail.SubscriptionChange', 'mail.SubscriptionChange', 'mail.SubscriptionChange']);
  assert.ok(w.ledger().some((r) => r.eventId.startsWith('["00000000')), 'the unsubscribe id is its fields, as a list');
});

test('route: Slack — events with the v0 signature; the url_verification challenge is echoed only when signed, bounded and not an event', async (t) => {
  const w = await world(t);
  const ask = inboundFixtures('slack').find((f) => f.answer).request.body;
  const mention = inboundFixtures('slack').find((f) => f.case === 'basic' && f.inbound === 'app_mention').request.body;
  const ok = await w.hook('slack', ask);
  assert.deepEqual([ok.status, ok.body, ok.type], [200, { challenge: 'challenge-fixture-0001' }, 'application/json; charset=utf-8']);
  assert.deepEqual((await w.hook('slack', ask)).body, { challenge: 'challenge-fixture-0001' }, 'asked again, answered again: it is not an event, so it is not a duplicate');
  assert.deepEqual(w.ledger(), [], 'no dedup row');
  assert.deepEqual(w.logs(), [], 'no step ran');
  assert.ok(w.app.trace().some((e) => e.kind === 'webhook_challenge' && e.connector === 'chat'));
  assert.equal(JSON.stringify(w.app.trace()).includes('challenge-fixture'), false, 'the trace keeps no part of it');
  // not signed, signed with another secret, signed too long ago, signed for another body: nothing is echoed
  for (const [what, opts] of [['unsigned', { sign: false }], ['another secret', { secret: 'nope' }], ['stale', { at: T0 - 301_000 }], ['no timestamp', { headers: { 'x-slack-request-timestamp': '' } }]]) {
    const r = await w.hook('slack', ask, opts);
    assert.deepEqual([what, r.status, r.body], [what, 401, { ok: false, error: 'unauthorized' }]);
    assert.equal(r.text.includes('challenge-fixture'), false, `${what}: the token is not echoed`);
  }
  // a value that is not a short token is refused, and the refusal does not repeat it
  for (const challenge of ['two words', '<b>x</b>', 'x'.repeat(129), '', 5, null]) {
    const r = await w.hook('slack', { ...ask, challenge });
    assert.deepEqual([r.status, r.body], [400, { ok: false, error: 'invalid_challenge' }], JSON.stringify(challenge));
  }
  assert.equal((await w.hook('slack', { ...ask, challenge: 'x'.repeat(128) })).body.challenge, 'x'.repeat(128));
  // another connector has no challenge: the same body is an unknown event there
  const stripeAsk = await w.hook('stripe', { ...ask, id: 'evt_x' });
  assert.deepEqual(stripeAsk.body, { ok: true, ignored: true });
  // an ordinary event still needs the signature, and runs once
  assert.equal((await w.hook('slack', mention, { sign: false })).status, 401);
  assert.deepEqual((await w.hook('slack', mention)).body, { ok: true });
  assert.deepEqual((await w.hook('slack', mention)).body, { ok: true, duplicate: true });
  assert.deepEqual(w.logs(), ['chat.app_mention']);
  const reaction = inboundFixtures('slack').find((f) => f.inbound === 'reaction_added').request.body;
  assert.deepEqual((await w.hook('slack', reaction)).body, { ok: true });
  assert.equal((await w.hook('slack', { ...mention, event_id: 'Ev2', event: { type: 'message', channel: 'C1' } })).body.ignored, true, 'a type it does not declare');
});

// --- the operations through the server, in the sandbox ----------------------------------------------------------

test('through the server in sandbox mode: a call is queued, answered by the descriptor\'s rules and shown in the outbox; Slack\'s ok:false is a failed delivery, not a sent one', async (t) => {
  const w = await world(t);
  const call = async (name) => { const r = await w.app.post(`/action/${name}`, {}); assert.equal(r.status, 303, `${name}: ${r.html.slice(0, 200)}`); };
  for (const name of ['charge', 'decline', 'letter', 'sayOk', 'sayNowhere', 'sayFlaky']) await call(name);
  const rows = w.app.app.store.outbox();
  const by = (op, channel) => rows.find((r) => r.op === op && (!channel || r.payload.channel === channel));
  const charge = rows.find((r) => r.op === 'createPaymentIntent' && r.payload.amount === 2500);
  assert.deepEqual([charge.status, charge.code, charge.drift, charge.target], ['sent', 200, 0, 'https://api.stripe.com/v1/payment_intents']);
  assert.equal(JSON.parse(charge.result).status, 'succeeded');
  assert.match(JSON.parse(charge.result).id, /^pi_sbx_[0-9a-f]{32}$/, 'the fake id is the row\'s idempotency key');
  assert.ok(charge.idemKey && JSON.parse(charge.result).id.endsWith(charge.idemKey));
  const declined = rows.find((r) => r.op === 'createPaymentIntent' && r.payload.amount === 900);
  assert.deepEqual([declined.status, declined.code, declined.error], ['failed', 402, 'HTTP 402']);
  assert.equal(declined.attempts, 1, 'a refusal is final: Stripe\'s 402 is not retried');
  assert.deepEqual([by('sendEmail').status, by('sendEmail').code], ['sent', 200]);
  assert.equal(JSON.parse(by('sendEmail').result).to, 'ann@example.test');
  assert.deepEqual([by('postMessage', '#orders').status, by('postMessage', '#orders').code], ['sent', 200]);
  const nowhere = by('postMessage', '#nowhere');
  assert.deepEqual([nowhere.status, nowhere.code, nowhere.error, nowhere.attempts], ['failed', 400, 'rejected: channel_not_found', 1]);
  const flaky = by('postMessage', '#flaky');
  assert.deepEqual([flaky.status, flaky.code, flaky.error, flaky.attempts, flaky.nextAttemptAt], ['failed', 503, 'rejected: internal_error', 1, null], 'a message is not posted twice: no automatic retry');
  const breaker = w.app.app.store.breakers().find((b) => b.connector === 'chat');
  assert.equal(breaker.failures, 1, 'but the 503 counts against the provider\'s breaker, and the refusal does not');
  const page = await w.app.get('/outbox');
  assert.match(page.html, /rejected: channel_not_found/);
  assert.match(page.html, /sandbox/);
  assert.equal(JSON.stringify(w.app.trace()).includes(TEST_SECRET), false);
});

test('Slack\'s ok:false reasons count as the statuses the descriptor says: transient ones retryable, auth ones 401/403, the rest 400', async () => {
  const op = DESC.slack.operations.postMessage;
  const codeOf = async (error) => (await mapResponse(op, { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ ok: false, error }) })).patch.code;
  const want = { ratelimited: 429, internal_error: 503, fatal_error: 503, service_unavailable: 503, request_timeout: 503, not_authed: 401, invalid_auth: 401,
    token_revoked: 401, account_inactive: 401, missing_scope: 403, channel_not_found: 400, is_archived: 400, msg_too_long: 400 };
  for (const [error, code] of Object.entries(want)) assert.equal(await codeOf(error), code, error);
});
