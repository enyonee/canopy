import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { buildRequest, deliverRow, prepare, secretSlots } from '../runtime/connectors/engine.mjs';
import { checkRecipe, signHeaders, verifySignature } from '../runtime/connectors/signature.mjs';
import { eventIdOf, valuesOf } from '../runtime/connectors/inbound.mjs';
import { settle, policyOf } from '../runtime/settle.mjs';
import { flush } from '../runtime/outbox.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { validate } from '../runtime/validate.mjs';
import { boot, tmpGraph } from './helpers.mjs';

const descriptor = (kind) => JSON.parse(readFileSync(new URL(`../connectors/${kind}/descriptor.json`, import.meta.url), 'utf8'));
const stripe = descriptor('stripe'), bog = descriptor('bog-payment-manager'), tbc = descriptor('tbc-checkout');
const KEY = '0123456789abcdef0123456789abcdef';
const ORDER = '00112233-4455-4677-8899-aabbccddeeff';
const RETURN = 'https://shop.test/checkout';
const TOKEN = 'short-lived-example';
const credentials = { apiKey: 'app-api-example', clientId: 'client-a', clientSecret: 'secret+a&b' };
const secret = (name) => credentials[name];
const opts = { secret, idemKey: KEY };
const row = (op, payload) => ({ op, payload });
const result = (patch) => JSON.parse(patch.result);
const reply = (body, status = 200) => Response.json(body, { status });
const bankToken = () => reply({ access_token: TOKEN });
const bogus = () => assert.fail('sandbox must not use the network');
const startStripe = { amountMinor: 1234, currency: 'usd', attemptId: 'order-123', productName: 'Coffee', successUrl: RETURN, cancelUrl: RETURN };
const startBog = { amount: 12.34, attemptId: 'order-123', productId: 'coffee', successUrl: RETURN, cancelUrl: RETURN, callbackUrl: RETURN };
const startTbc = { amount: 12.34, attemptId: 'order-123', returnUrl: RETURN };

test('Adyen SDK keeps the v71 requests, exact response patches and retry headers', async () => {
  const d = descriptor('adyen');
  const { registry, errors } = await loadPlugins({ plugins: ['connectors/adyen/descriptor.json'] }, process.cwd());
  assert.deepEqual(errors, []);
  const transport = registry.transports.adyen;
  const config = { endpointPrefix: 'fixture', merchantAccount: 'merchant', countryCode: 'NL' };
  const cases = [
    ['createCheckout', { orderId: 'order-41', amountMinor: 1250, currency: 'EUR', returnUrl: RETURN },
      { id: 'PL12345', url: 'https://eu.adyen.link/PL12345', status: 'active', reference: 'order-41', amount: { value: 1250, currency: 'EUR' } }],
    ['getCheckout', { id: 'PL12345' }, { id: 'PL12345', status: 'completed', reference: 'order-41', amount: { value: 1250, currency: 'EUR' } }],
    ['refundCheckout', { paymentPspReference: '123456789', reference: 'refund-41', amountMinor: 1250, currency: 'EUR' },
      { pspReference: '987654321', paymentPspReference: '123456789', status: 'received', reference: 'refund-41' }],
  ];
  for (const [op, input, body] of cases) {
    const delivery = row(op, input);
    const request = buildRequest(d, config, op, input, opts);
    const legacy = await deliverRow(d, delivery, config, { ...opts, fetchImpl: async () => reply(body) });
    const patch = await transport.deliver(delivery, config, { ...opts, fetchImpl: async (url, init) => {
      assert.equal(url, request.url);
      assert.equal(init.method, request.method);
      assert.equal(init.redirect, 'manual');
      assert.deepEqual(init.headers, request.headers);
      assert.deepEqual(JSON.parse(init.body || 'null'), JSON.parse(request.body || 'null'));
      return reply(body);
    } });
    assert.deepEqual(patch, legacy);
    assert.equal(patch.status, 'sent');
  }
  const [op, input] = cases[0];
  const limited = await transport.deliver(row(op, input), config, { ...opts, fetchImpl: async () =>
    new Response('not JSON', { status: 429, headers: { 'Retry-After': '20' } }) });
  assert.equal(limited.retryAfter, '20');
  assert.equal(limited.code, 429);
  const drift = await transport.deliver(row(op, input), config, { ...opts, fetchImpl: async () => new Response('not JSON') });
  assert.equal(drift.code, 502);
  const clock = { setTimer: (fn) => fn(), clear: () => {} };
  await assert.rejects(transport.deliver(row(op, input), config, { ...opts, clock, fetchImpl: bogus }), { fault: 'timeout' });
  // The SDK target must agree with the descriptor before sending anything.
  await assert.rejects(transport.deliver(row(op, input), { ...config, endpointPrefix: 'Bad Host' }, { ...opts, fetchImpl: bogus }),
    /differs from its descriptor|Invalid URL/);
});

async function stripeTransport() {
  const { registry, errors } = await loadPlugins({ plugins: ['connectors/stripe/descriptor.json'] }, process.cwd());
  assert.deepEqual(errors, []);
  return registry.transports.stripe;
}

test('the shipped Stripe connector uses SDK methods for every live operation', async () => {
  const transport = await stripeTransport();
  const checkout = { id: 'cs_test_123', url: 'https://checkout.stripe.com/123', status: 'complete',
    client_reference_id: 'order-123', payment_status: 'paid', amount_total: 1234, currency: 'usd',
    livemode: false, payment_intent: 'pi_123' };
  const intent = { id: 'pi_123', status: 'succeeded' };
  const refund = { id: 're_123', status: 'succeeded', amount: 100, currency: 'usd', payment_intent: 'pi_123' };
  const cases = {
    createCheckout: [startStripe, checkout], getCheckout: [{ id: checkout.id }, checkout],
    refundCheckout: [{ paymentIntent: 'pi_123', amountMinor: 100 }, refund],
    createPaymentIntent: [{ amount: 1234, currency: 'usd', confirm: false,
      metadata: { order: '7', ignored: null, nested: { values: [null, 'second'] } } }, intent],
    retrievePaymentIntent: [{ id: 'pi_123' }, intent], confirmPaymentIntent: [{ id: 'pi_123' }, intent],
    createRefund: [{ paymentIntent: 'pi_123', amount: 100 }, refund],
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(stripe.operations).sort());
  for (const [op, [input, response]] of Object.entries(cases)) {
    const expected = buildRequest(stripe, {}, op, input, opts);
    const raw = JSON.stringify(response, null, 2);
    const old = await deliverRow(stripe, row(op, input), {}, { ...opts, fetchImpl: async () => new Response(raw) });
    const patch = await transport.deliver(row(op, input), {}, { ...opts, fetchImpl: async (url, request) => {
      const headers = new Headers(request.headers);
      assert.equal(url, expected.url);
      assert.equal(request.method, expected.method);
      assert.equal(request.redirect, 'manual');
      assert.match(headers.get('user-agent'), /Stripe/);
      assert.equal(headers.get('authorization'), 'Bearer ' + credentials.apiKey);
      assert.equal(headers.get('stripe-version'), '2024-06-20');
      assert.equal(headers.get('idempotency-key'), KEY);
      assert.deepEqual([...new URLSearchParams(request.body)].sort(), [...new URLSearchParams(expected.body)].sort());
      return new Response(raw);
    } });
    assert.deepEqual(patch, old, op);
    assert.equal(patch.status, 'sent', op);
  }
});

test('Stripe leaves retries, timeouts and HTTP error handling to Canopy', async () => {
  const transport = await stripeTransport();
  const payment = row('createCheckout', startStripe);
  let attempts = 0;
  await assert.rejects(transport.deliver(payment, {}, { ...opts, fetchImpl: async () => {
    attempts++;
    throw Object.assign(new Error('lost connection'), { code: 'ECONNRESET' });
  } }), { message: 'lost connection', fault: 'net' });
  assert.equal(attempts, 1);
  const failed = await transport.deliver(payment, {}, { ...opts, fetchImpl: async () =>
    new Response('provider diagnostic', { status: 429, headers: { 'retry-after': '12' } }) });
  assert.deepEqual(failed, { code: 429, status: 'failed', error: 'HTTP 429', retryAfter: '12' });
  const invalid = await transport.deliver(payment, {}, { ...opts, fetchImpl: async () => new Response('not JSON') });
  assert.equal(invalid.code, 502);
  const clock = { setTimer: (fn, ms) => { assert.equal(ms, 7); fn(); }, clear: () => {} };
  await assert.rejects(transport.deliver(payment, {}, { ...opts, timeoutCapMs: 7, clock, fetchImpl: bogus }), { fault: 'timeout' });
  assert.equal((await transport.deliver(payment, {}, { ...opts, mode: 'sandbox', fetchImpl: bogus })).status, 'sent');
});

test('payment descriptors load and their default sandbox builds a projected checkout', async () => {
  for (const [d, input] of [[stripe, startStripe], [bog, startBog], [tbc, startTbc]]) {
    assert.deepEqual(checkDescriptor(d), []);
    const queued = prepare(d, {}, 'createCheckout', input);
    assert.ok(queued.target.startsWith(d.base));
    const patch = await deliverRow(d, row('createCheckout', queued.input), {}, { ...opts, mode: 'sandbox', fetchImpl: bogus });
    assert.equal(patch.status, 'sent');
    assert.equal(patch.response, undefined);
    assert.match(result(patch).checkoutUrl, /^https:/);
  }
  assert.deepEqual(secretSlots(bog).sort(), ['clientId', 'clientSecret', 'webhookPublicKey']);
  assert.deepEqual(secretSlots(tbc).sort(), ['apiKey', 'clientId', 'clientSecret']);
});

test('Stripe Checkout uses a hosted session and reduces the provider response to allowed fields', async () => {
  const id = 'cs_test_123', checkoutUrl = 'https://checkout.stripe.com/c/pay/' + id;
  const patch = await deliverRow(stripe, row('createCheckout', startStripe), {}, {
    ...opts, fetchImpl: async (url, req) => {
      assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
      assert.equal(req.method, 'POST');
      assert.equal(req.redirect, 'manual');
      assert.equal(req.headers.authorization, 'Bearer ' + credentials.apiKey);
      assert.equal(req.headers['Idempotency-Key'], KEY);
      const body = new URLSearchParams(req.body);
      assert.equal(body.get('mode'), 'payment');
      assert.equal(body.get('line_items[0][price_data][unit_amount]'), '1234');
      assert.equal(body.get('client_reference_id'), startStripe.attemptId);
      assert.equal(body.has('payment_method'), false);
      return reply({ id, url: checkoutUrl, client_secret: 'do-not-store' });
    },
  });
  assert.deepEqual(result(patch), { id, checkoutUrl });
  assert.doesNotMatch(JSON.stringify(patch), /do-not-store/);
  const state = await deliverRow(stripe, row('getCheckout', { id }), {}, {
    ...opts, fetchImpl: async (url, req) => {
      assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions/' + id);
      assert.equal(req.method, 'GET');
      return reply({ id, status: 'complete', client_reference_id: startStripe.attemptId, payment_status: 'unpaid', amount_total: 1234, currency: 'usd', livemode: false, payment_intent: null });
    },
  });
  assert.equal(result(state).paymentStatus, 'unpaid');
  assert.equal(result(state).paymentIntent, null);
  const refund = buildRequest(stripe, {}, 'refundCheckout', { paymentIntent: 'pi_123', amountMinor: 100 }, opts);
  assert.equal(refund.body, 'payment_intent=pi_123&amount=100');
});

test('BOG authenticates separately, fixes the retry UUID, and projects receipt and refund', async () => {
  const approval = 'https://payment.bog.ge/?order_id=' + ORDER;
  const calls = [];
  const responses = [
    { id: ORDER, _links: { redirect: { href: approval } } },
    { order_id: ORDER, external_order_id: startBog.attemptId, order_status: { key: 'completed' }, purchase_units: { transfer_amount: '12.34', currency_code: 'GEL' } },
    { key: 'request_received', action_id: 'refund-ao1' },
  ];
  const fetchImpl = async (url, req) => {
    calls.push({ url, ...req });
    assert.equal(req.redirect, 'manual');
    if (url === bog.token.url) {
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('client-a:secret+a&b').toString('base64'));
      assert.equal(req.body, 'grant_type=client_credentials');
      return bankToken();
    }
    assert.equal(req.headers.authorization, 'Bearer ' + TOKEN);
    assert.equal(req.headers['Idempotency-Key'], '01234567-89ab-4def-8123-456789abcdef');
    return reply({ ...responses.shift(), echo: TOKEN });
  };
  const send = (op, payload) => deliverRow(bog, row(op, payload), {}, { ...opts, fetchImpl });
  assert.deepEqual(result(await send('createCheckout', startBog)), { id: ORDER, checkoutUrl: approval });
  assert.equal(calls[1].url, 'https://api.bog.ge/payments/v1/ecommerce/orders');
  const create = JSON.parse(calls[1].body);
  assert.equal(create.external_order_id, startBog.attemptId);
  assert.equal(create.purchase_units.basket[0].unit_price, 12.34);
  assert.deepEqual(result(await send('getCheckout', { id: ORDER })), { id: ORDER, attemptId: 'order-123', status: 'completed', amount: '12.34', currency: 'GEL' });
  const patch = await send('refundCheckout', { id: ORDER, amount: 1.23 });
  assert.deepEqual(result(patch), { id: 'refund-ao1', status: 'request_received' });
  assert.equal(calls[5].url, 'https://api.bog.ge/payments/v1/payment/refund/' + ORDER);
  assert.equal(calls[5].body, '{"amount":1.23}');
  assert.doesNotMatch(JSON.stringify(patch), new RegExp(TOKEN));
  assert.throws(() => buildRequest(bog, {}, 'getCheckout', { id: ORDER }, { idemKey: 'bad' }), /outbox key/);
});

test('TBC selects the approval relation, uses authenticated status, and never retries an ambiguous POST', async () => {
  const id = 'tpay-123', approval = 'https://tpay.tbcbank.ge/checkout/' + id;
  const calls = [];
  const fetchImpl = async (url, req) => {
    calls.push({ url, ...req });
    assert.equal(req.headers.apikey, credentials.apiKey);
    if (url === tbc.token.url) {
      assert.equal(req.body, 'client_id=client-a&client_secret=secret%2Ba%26b');
      return bankToken();
    }
    assert.equal(req.headers.authorization, 'Bearer ' + TOKEN);
    if (req.method === 'GET') return reply({ payId: id, status: 'Succeeded', amount: 12.34, currency: 'GEL' });
    if (url.endsWith('/cancel')) return new Response(null, { status: 200 });
    return reply({ payId: id, status: 'Created', links: [{ rel: 'approval_url', uri: approval }, { rel: 'self', uri: url + '/' + id }] });
  };
  const send = (op, payload) => deliverRow(tbc, row(op, payload), {}, { ...opts, fetchImpl });
  assert.deepEqual(result(await send('createCheckout', startTbc)), { id, status: 'Created', checkoutUrl: approval });
  assert.equal(JSON.parse(calls[1].body).preAuth, false);
  assert.equal(JSON.parse(calls[1].body).merchantPaymentId, startTbc.attemptId);
  assert.deepEqual(result(await send('getCheckout', { id })), { id, status: 'Succeeded', amount: 12.34, currency: 'GEL' });
  assert.equal((await send('refundCheckout', { id })).status, 'sent');
  assert.equal(calls[5].body, '{}');
  const refund = row('refundCheckout', { id });
  let error;
  await assert.rejects(deliverRow(tbc, refund, {}, {
    ...opts, fetchImpl: async (url) => {
      if (url === tbc.token.url) return bankToken();
      throw new DOMException('timed out', 'TimeoutError');
    },
  }), (e) => { error = e; return /authorized provider request failed/.test(e.message); });
  const policy = policyOf({ descriptors: { [tbc.name]: tbc } }, { ...refund, kind: tbc.name });
  assert.equal(settle(refund, {}, error, { policy, now: 0, idemKey: KEY }).patch.status, 'unknown');
});

test('invalid token response and redirect never send a payment; changed origin is refused', async () => {
  for (const answer of [
    new Response(null, { status: 302, headers: { Location: 'https://foreign.test' } }),
    new Response('not JSON'),
    reply({ access_token: 'contains a space' }),
  ]) {
    let calls = 0;
    await assert.rejects(deliverRow(tbc, row('createCheckout', startTbc), {}, {
      ...opts, fetchImpl: async () => { calls++; return answer; },
    }), /could not authorize/);
    assert.equal(calls, 1);
  }
  const bad = structuredClone(tbc);
  bad.operations.createCheckout.request.url = 'https://foreign.test/checkout';
  assert.match(checkDescriptor(bad).flat().join(' '), /let the delivery set Authorization/);
  await assert.rejects(deliverRow(bad, row('createCheckout', startTbc), {}, { ...opts, fetchImpl: bogus }), /left the declared origin/);
  const invalid = { ...tbc, base: 'http://bank.test', token: { url: 'https://{config.host}/token', scheme: 'unknown', clientId: '', clientSecret: 5, unknown: true } };
  const errors = checkDescriptor(invalid).map(([p]) => p);
  for (const k of ['/base', '/token/url', '/token/scheme', '/token/clientId', '/token/clientSecret', '/token/unknown']) assert.ok(errors.includes(k), k);
  assert.ok(checkDescriptor({ ...tbc, token: null }).some(([p]) => p === '/token'));
  assert.ok(checkDescriptor({ ...tbc, idempotency: { header: 'X-Key', format: 'wrong' } }).some(([p]) => p === '/idempotency/format'));
  const empty = structuredClone(stripe);
  delete empty.operations.createCheckout.result;
  assert.ok(checkDescriptor(empty).some(([p]) => p.endsWith('/resultOnly')));
});

test('projection rejects unexpected domains, missing or ambiguous approval, and non-JSON bodies', async () => {
  for (const links of [
    [],
    [{ rel: 'approval_url', uri: 'https://foreign.test/checkout' }],
    Array(2).fill({ rel: 'approval_url', uri: 'https://tpay.tbcbank.ge/checkout' }),
  ]) {
    const patch = await deliverRow(tbc, row('createCheckout', startTbc), {}, {
      ...opts, fetchImpl: async (url) => url === tbc.token.url ? bankToken() : reply({ payId: 'tpay-1', status: 'Created', links }),
    });
    assert.equal(patch.code, 502);
    assert.equal(patch.result, undefined);
  }
  const patch = await deliverRow(stripe, row('createCheckout', startStripe), {}, { ...opts, fetchImpl: async () => new Response('private-error-sample') });
  assert.equal(patch.status, 'failed');
  assert.doesNotMatch(JSON.stringify(patch), /private-error-sample/);
});

test('BOG authenticates callback bytes using a public key and derives deduplication and lookup values', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const event = { event: 'order_payment', zoned_request_time: '2026-11-26T11:00:00Z', body: { order_id: ORDER, external_order_id: 'order-123' } };
  const raw = Buffer.from(JSON.stringify(event)), recipe = bog.inbound.signature, now = 0;
  const headers = signHeaders(recipe, { raw, secret: privateKey, now });
  assert.deepEqual(checkRecipe(recipe, '/sig'), []);
  assert.match(checkRecipe({ scheme: 'rsa-sha256' }, '/sig').flat().join(' '), /names its header/);
  const verify = (changes = {}) => verifySignature(recipe, { headers, raw, secrets: ['broken key', publicKey], now, ...changes });
  assert.deepEqual(verify(), { ok: true });
  assert.equal(verify({ raw: Buffer.concat([raw, Buffer.from(' ')]) }).reason, 'signature_mismatch');
  assert.equal(verify({ headers: {} }).reason, 'signature_missing');
  assert.equal(verify({ headers: { 'callback-signature': 'not base 64' } }).reason, 'signature_malformed');
  assert.equal(verify({ secrets: [] }).reason, 'secret_not_set');
  assert.equal(verify({ secrets: ['broken key'] }).reason, 'signature_mismatch');
  assert.equal(eventIdOf(bog.inbound, event, bog.inbound.events.order_payment), JSON.stringify([ORDER, event.zoned_request_time]));
  assert.deepEqual(valuesOf(bog.inbound.events.order_payment, event), { id: ORDER, attemptId: 'order-123' });
});

function checkoutGraph() {
  const providers = [[stripe, startStripe], [bog, startBog], [tbc, startTbc]];
  return {
    app: 'hosted-checkout', data: { Order: { label: 'text', delivery: 'int', paymentId: 'text', checkoutUrl: 'text' } },
    plugins: providers.map(([d]) => fileURLToPath(new URL(`../connectors/${d.name}/descriptor.json`, import.meta.url))),
    connectors: Object.fromEntries(providers.map(([d]) => [d.name, { kind: d.name }])),
    actions: providers.flatMap(([d, input], i) => [
      { name: 'create' + i, in: 'Order', do: [
        { block: 'connector.call', connector: d.name, op: 'createCheckout', ref: '@row', input },
        { block: 'db.update', set: { delivery: '@delivery' } },
      ] },
      { name: 'capture' + i, in: 'Order', do: [
        { block: 'connector.capture', connector: d.name, op: 'createCheckout', deliveryField: 'delivery', set: { paymentId: 'id', checkoutUrl: 'checkoutUrl' } },
      ] },
    ]),
  };
}

test('HTTP action: each provider queues, settles, and delivers a checkout URL only to the bound graph row', async (t) => {
  const graph = checkoutGraph();
  const s = await boot(tmpGraph(graph), { noTimers: true, fetchImpl: bogus });
  t.after(s.close);
  assert.equal(s.app.invalid, false);
  const store = s.app.store;
  const order = await store.insert('Order', { label: 'buyer' });
  const other = await store.insert('Order', { label: 'different buyer' });
  const post = (id, act) => s.post(`/Order/${id}/action/${act}`);
  for (const [i, host] of ['checkout.stripe.com', 'payment.bog.ge', 'tpay.tbcbank.ge'].entries()) {
    assert.equal((await post(order, 'create' + i)).status, 303);
    const { delivery } = await store.get('Order', order);
    const outbox = await store.outboxGet(delivery);
    assert.equal(outbox.status, 'sent');
    assert.equal(outbox.refEntity, 'Order');
    assert.equal(outbox.refId, order);
    assert.equal(outbox.response, null);
    await store.update('Order', other, { delivery });
    assert.equal((await post(other, 'capture' + i)).status, 400);
    assert.equal((await store.get('Order', other)).checkoutUrl, null);
    const prev = outbox.status;
    await store.outboxUpdate(delivery, { status: 'unknown' });
    assert.equal((await post(order, 'capture' + i)).status, 400);
    await store.outboxUpdate(delivery, { status: prev });
    assert.equal((await post(order, 'capture' + i)).status, 303);
    assert.equal(new URL((await store.get('Order', order)).checkoutUrl).hostname, host);
  }
  const { registry } = await loadPlugins(graph, process.cwd());
  const errors = (step) => validate({ ...graph, actions: [{ ...graph.actions[1], do: [step] }] }, registry);
  const capture = graph.actions[1].do[0];
  assert.ok(errors({ ...capture, deliveryField: 'label' }).some((e) => e.path.endsWith('/deliveryField')));
  assert.ok(errors({ ...capture, op: 'createPaymentIntent' }).some((e) => e.path.endsWith('/op')));
  assert.ok(errors({ ...capture, set: {} }).some((e) => e.path.endsWith('/set')));
  assert.ok(errors({ ...capture, set: { paymentId: 'unknown' } }).some((e) => e.path.endsWith('/paymentId')));
  const upload = { ...graph, data: { Order: { ...graph.data.Order, file: 'file' } }, actions: [{ ...graph.actions[1], do: [{ ...capture, set: { file: 'id' } }] }] };
  assert.ok(validate(upload, registry).some((e) => e.path.endsWith('/file')));
});

test('TBC POST is held for reconciliation after loss of a lease and refused by manual retry', async (t) => {
  const graph = checkoutGraph();
  const s = await boot(tmpGraph(graph), { noTimers: true, fetchImpl: bogus });
  t.after(s.close);
  const { registry } = await loadPlugins(graph, process.cwd());
  const store = s.app.store;
  const id = await store.enqueue({ kind: tbc.name, connector: tbc.name, op: 'refundCheckout', target: tbc.base, payload: { id: 'tpay-1' } });
  assert.equal(await store.outboxClaim(id, 1000, 60000), true);
  assert.deepEqual(await flush(store, graph, { now: () => 61000, registry, fetchImpl: bogus }), ['unknown']);
  const retry = await s.post(`/outbox/${id}/retry`);
  assert.equal(retry.status, 303);
  assert.match(retry.location, /cannot/);
  assert.equal((await store.outboxGet(id)).status, 'unknown');
});
