import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBridge } from '../bridges/caucasus-payments/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';
import { loadDescriptor } from './replay.mjs';

const operatorToken = 'fixture-operator-credential';
const returnUrl = 'https://merchant.example.test/return';
const failUrl = 'https://merchant.example.test/failed';
const ameria = { clientId: 'client-fixture', username: 'user-fixture', password: 'secret-fixture', returnUrl, test: true };
const epoint = { publicKey: 'i000000001', privateKey: 'key-fixture', successUrl: returnUrl, failUrl,
  checkoutOrigin: 'https://bank.example.test' };
const ameriaApi = 'https://servicestest.ameriabank.am/VPOS/api/VPOS/';
const epointApi = 'https://epoint.az/api/1';
const aId = 'pay-123', eId = 'te000000001';
const aInfo = { ResponseCode: '00', Amount: 12.5, OrderID: '41', Currency: '051', DepositedAmount: 12.5, RefundedAmount: 0,
  ClientName: 'private data', CardNumber: 'not stored' };
const eInfo = { transaction: eId, order_id: 'order-41', status: 'success', amount: '12.50', currency: 'AZN', card_id: 'not stored' };
const aInput = { orderId: 41, amountMinor: 1250, currency: 'AMD', description: 'Order' };
const eInput = { orderId: 'order-41', amountMinor: 1250, description: 'Order' };
const eResult = { id: eId, orderId: 'order-41', amountMinor: 1250, currency: 'AZN', status: 'success' };

async function launch(t, fetchImpl) {
  const server = createBridge({ operatorToken, ameriabank: ameria, epoint }, fetchImpl);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

const rows = {
  ameriabank: [
    ['createCheckout', aInput, 'InitPayment', { OrderID: 41, Amount: 12.5, Currency: '051', Description: 'Order', BackURL: returnUrl },
      { ResponseCode: 1, PaymentID: aId }, { id: aId, orderId: 41, status: 'registered',
        checkoutUrl: 'https://servicestest.ameriabank.am/VPOS/Payments/Pay?id=pay-123&lang=am' }],
    ['getCheckout', { id: aId }, 'GetPaymentDetails', { PaymentID: aId }, aInfo,
      { id: aId, orderId: 41, currency: 'AMD', amountMinor: 1250, depositedMinor: 1250, refundedMinor: 0, status: 'paid' }],
    ['findCheckout', { orderId: 41 }, 'GetPaymentId', { OrderID: 41 }, { ResponseCode: '00', PaymentId: aId }, { id: aId, orderId: 41 }],
    ['refundCheckout', { id: aId, amountMinor: 250 }, 'RefundPayment', { PaymentID: aId, Amount: 2.5 },
      { ResponseCode: '00' }, { id: aId, amountMinor: 250, status: 'accepted' }],
  ],
  epoint: [
    ['createCheckout', eInput, '/request', { order_id: 'order-41', amount: 12.5, currency: 'AZN',
      description: 'Order', language: 'az', success_redirect_url: returnUrl, error_redirect_url: failUrl },
    { status: 'success', transaction: eId, redirect_url: 'https://bank.example.test/checkout?id=41' },
    { id: eId, orderId: 'order-41', status: 'registered', checkoutUrl: 'https://bank.example.test/checkout?id=41' }],
    ['getCheckout', { id: eId }, '/get-status', { transaction: eId }, eInfo, eResult],
    ['findCheckout', { orderId: 'order-41' }, '/get-status', { order_id: 'order-41' }, eInfo, eResult],
  ],
};

for (const [name, cases] of Object.entries(rows)) test(`${name}: offline delivery and signed live contracts`, async (t) => {
  const descriptor = loadDescriptor(name);
  let current, calls = 0;
  descriptor.base = await launch(t, async (url, init) => {
    calls++;
    const [, , endpoint, params, response] = current;
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    if (name === 'ameriabank') {
      assert.equal(url, ameriaApi + endpoint);
      assert.deepEqual(JSON.parse(init.body), { ...params, ClientID: ameria.clientId, Username: ameria.username, Password: ameria.password });
    } else {
      assert.equal(url, epointApi + endpoint);
      assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(init.body), data = form.get('data');
      assert.deepEqual(JSON.parse(Buffer.from(data, 'base64')), { public_key: epoint.publicKey, ...params });
      assert.equal(form.get('signature'), createHash('sha1').update(epoint.privateKey + data + epoint.privateKey).digest('base64'));
    }
    return Response.json(response);
  });
  assert.deepEqual(Object.keys(descriptor.operations).sort(), cases.map(([op]) => op).sort());
  for (const entry of cases) {
    current = entry;
    const [op, data, , , , expected] = entry;
    const { input } = prepare(descriptor, {}, op, data);
    const row = { kind: name, op, payload: input };
    const sandbox = await deliverRow(descriptor, row, {}, {
      mode: 'sandbox', secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox made a network call'),
    });
    assert.equal(sandbox.status, 'sent', op);
    const live = await deliverRow(descriptor, row, {}, { secret: (slot) => {
      assert.equal(slot, 'operatorToken');
      return operatorToken;
    } });
    assert.equal(live.status, 'sent', op);
    assert.deepEqual(JSON.parse(live.result), expected);
    assert.equal(live.response, undefined);
    assert.equal(noReplay({ descriptors: { [name]: descriptor } }, row), ['createCheckout', 'refundCheckout'].includes(op));
  }
  assert.equal(calls, cases.length);
});

test('bridge denies unauthorized and off-origin requests and distinguishes approval from a deposit', async (t) => {
  const responses = [
    { ...aInfo, DepositedAmount: 0 },
    { ...aInfo, RefundedAmount: 2.5 },
    { status: 'success', transaction: eId, redirect_url: 'https://bank.example.test@evil.example.test/checkout' },
    { ...eInfo, currency: 'USD' },
    { ...eInfo, order_id: 'other-order' },
  ];
  const base = await launch(t, async () => Response.json(responses.shift()));
  const send = (path, data, token = operatorToken) => fetch(base + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(data),
  });
  assert.equal((await send('/ameriabank/status', { id: aId }, 'wrong')).status, 401);
  assert.equal((await send('/ameriabank/status', { id: aId + '/bad' })).status, 400);
  assert.equal((await (await send('/ameriabank/status', { id: aId })).json()).status, 'not_paid');
  assert.equal((await (await send('/ameriabank/status', { id: aId })).json()).status, 'refunded');
  assert.equal((await send('/epoint/checkout', eInput)).status, 502);
  assert.equal((await send('/epoint/status', { id: eId })).status, 502);
  assert.equal((await send('/epoint/find', { orderId: 'order-41' })).status, 502);
  assert.equal(responses.length, 0);
});
