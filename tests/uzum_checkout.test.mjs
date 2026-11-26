import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBridge } from '../bridges/uzum-checkout/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';
import { loadDescriptor } from './replay.mjs';

const config = { apiOrigin: 'https://uzum-api.example.test', checkoutOrigin: 'https://uzum-pay.example.test',
  successUrl: 'https://merchant.example.test/return', failureUrl: 'https://merchant.example.test/failure',
  apiKey: 'fixture-api-credential', terminalId: 'fixture-terminal', operatorToken: 'fixture-operator-credential' };
const id = '01234567-89ab-4cde-8f01-23456789abcd';
const operationId = '11234567-89ab-4cde-8f01-23456789abcd';
const checkoutUrl = config.checkoutOrigin + '/payment/fixture';
const create = { orderId: 'order-41', customerRef: 'customer-1', amountMinor: 1250 };
const refund = { id, amountMinor: 250 };
const status = { orderId: id, merchantOrderId: 'order-41', status: 'COMPLETED', amount: 1250, totalAmount: 1250,
  completedAmount: 1250, refundedAmount: 0, reversedAmount: 0, ofdPan: 'never retain', operations: [] };

async function launch(t, mock) {
  const server = createBridge(config, mock);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

test('Uzum Checkout registers a hosted payment, verifies status and reconciles a specific refund', async (t) => {
  const cases = [
    ['createCheckout', create, 'payment/register', {
      orderNumber: 'order-41', clientId: 'customer-1', amount: 1250, currency: 860, viewType: 'REDIRECT',
      paymentParams: { operationType: 'PAYMENT', payType: 'ONE_STEP' },
      successUrl: config.successUrl, failureUrl: config.failureUrl, sessionTimeoutSecs: 900,
    }, { orderId: id, paymentRedirectUrl: checkoutUrl }, { id, orderId: 'order-41', checkoutUrl }],
    ['getCheckout', { id }, 'payment/getOrderStatus', { orderId: id }, status, {
      id, orderId: 'order-41', status: 'COMPLETED', currency: 'UZS', amountMinor: 1250, totalMinor: 1250,
      completedMinor: 1250, refundedMinor: 0, reversedMinor: 0,
    }],
    ['refundCheckout', refund, 'acquiring/refund', { orderId: id, amount: 250 },
      { operationId }, { id, operationId, status: 'accepted' }],
    ['getRefund', { id, operationId }, 'payment/getOrderStatus', { orderId: id },
      { ...status, refundedAmount: 250, operations: [{ operationId, operationType: 'REFUND', state: 'SUCCESS' }] },
      { id, operationId, status: 'SUCCESS', refundedMinor: 250 }],
  ];
  let calls = 0;
  const descriptor = loadDescriptor('uzum-bank');
  descriptor.base = await launch(t, async (url, request) => {
    const [, , endpoint, payload, result] = cases[calls++];
    assert.equal(url, config.apiOrigin + '/api/v1/' + endpoint);
    assert.equal(request.redirect, 'manual');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['X-Terminal-Id'], config.terminalId);
    assert.equal(request.headers['X-API-Key'], config.apiKey);
    assert.equal(request.headers['Content-Language'], 'uz-UZ');
    assert.deepEqual(JSON.parse(request.body), payload);
    return Response.json({ errorCode: 0, result });
  });
  assert.deepEqual(Object.keys(descriptor.operations), cases.map(([op]) => op));
  for (const [op, data, , , , expected] of cases) {
    const { input } = prepare(descriptor, {}, op, data);
    const row = { kind: 'uzum-bank', op, payload: input };
    const sandbox = await deliverRow(descriptor, row, {}, {
      mode: 'sandbox', secret: () => assert.fail('sandbox touched a secret'),
      fetchImpl: () => assert.fail('sandbox used the network'),
    });
    assert.equal(sandbox.status, 'sent', op);
    const delivery = await deliverRow(descriptor, row, {}, { secret: (slot) => {
      assert.equal(slot, 'operatorToken');
      return config.operatorToken;
    } });
    assert.equal(delivery.status, 'sent', op);
    assert.equal(delivery.response, undefined);
    assert.deepEqual(JSON.parse(delivery.result), expected);
    assert.equal(noReplay({ descriptors: { 'uzum-bank': descriptor } }, row), ['createCheckout', 'refundCheckout'].includes(op));
  }
  assert.equal(calls, cases.length);
});

test('Uzum bridge denies invalid and untrusted requests and reports unconfirmed operations as such', async (t) => {
  const pending = { operationId, operationType: 'REFUND', state: 'IN_PROGRESS' };
  const replies = [
    { errorCode: 0, result: { orderId: id, paymentRedirectUrl: 'https://untrusted.example.test/pay' } },
    { errorCode: 10, message: 'private error details' },
    { errorCode: 0, result: { ...status, status: 'AUTHORIZED', completedAmount: 0 } },
    { errorCode: 0, result: { ...status, operations: [{ ...pending, operationType: 'COMPLETE' }] } },
    { errorCode: 0, result: { ...status, operations: [pending] } },
  ];
  const base = await launch(t, async () => Response.json(replies.shift()));
  const call = (path, data, token = config.operatorToken) => fetch(base + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(data),
  });
  assert.equal((await call('/checkout', create, 'wrong')).status, 401);
  assert.equal((await call('/refund', { ...refund, amountMinor: 0 })).status, 400);
  assert.equal((await call('/checkout', create)).status, 502);
  const rejected = await call('/status', { id });
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: 'bank rejected the operation' });
  const approved = await (await call('/status', { id })).json();
  assert.equal(approved.status, 'AUTHORIZED');
  assert.equal(approved.completedMinor, 0);
  assert.equal((await call('/refund-status', { id, operationId })).status, 502);
  assert.deepEqual(await (await call('/refund-status', { id, operationId })).json(),
    { id, operationId, status: 'IN_PROGRESS', refundedMinor: 0 });
  assert.equal(replies.length, 0);
});
