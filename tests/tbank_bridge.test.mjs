import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBridge } from '../bridges/tbank-payments/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { noReplay } from '../runtime/settle.mjs';
import { loadDescriptor } from './replay.mjs';

const config = { terminalKey: 'TESTTERMINAL', password: 'fixture-password', operatorToken: 'fixture-operator-credential',
  successUrl: 'https://merchant.example.test/success', failUrl: 'https://merchant.example.test/fail', apiToken: 'merchant-fixture' };
const base = { Success: true, ErrorCode: '0', OrderId: 'order-41', PaymentId: '123456' };
const common = { id: '123456', orderId: 'order-41', currency: 'RUB' };
const scope = 'https://securepay.tinkoff.ru/v2/';
const cases = [
  ['createCheckout', 'Init', { orderId: 'order-41', amountMinor: 1250, description: 'Example order' },
    { OrderId: 'order-41', Amount: 1250, Description: 'Example order', PayType: 'O', SuccessURL: config.successUrl, FailURL: config.failUrl },
    '1250Example orderhttps://merchant.example.test/failorder-41fixture-passwordOhttps://merchant.example.test/successTESTTERMINAL',
    { ...base, Status: 'NEW', Amount: 1250, PaymentURL: scope + 'fixture' },
    { ...common, status: 'NEW', amountMinor: 1250, checkoutUrl: scope + 'fixture' }],
  ['getCheckout', 'GetState', { id: '123456' }, { PaymentId: '123456' }, 'fixture-password123456TESTTERMINAL',
    { ...base, Status: 'CONFIRMED', Amount: 1250 }, { ...common, status: 'CONFIRMED', amountMinor: 1250 }],
  ['refundCheckout', 'Cancel', { id: '123456', amountMinor: 250 }, { PaymentId: '123456', Amount: 250 },
    '250fixture-password123456TESTTERMINAL', { ...base, Status: 'PARTIAL_REFUNDED', OriginalAmount: 1250, NewAmount: 1000 },
    { ...common, status: 'PARTIAL_REFUNDED', amountMinor: 250, remainingMinor: 1000 }],
];

async function localBridge(t, fetchImpl) {
  const server = createBridge(config, fetchImpl);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

test('T-Bank outbox operations pass through the authenticated bridge with correct signed data', async (t) => {
  const descriptor = loadDescriptor('tbank');
  assert.deepEqual(checkDescriptor(descriptor), []);
  const requests = [];
  descriptor.base = await localBridge(t, async (url, request) => {
    requests.push({ url, request });
    const hit = cases.find(([, method]) => url === scope + method);
    return Response.json(hit?.[5] ?? { Success: false });
  });
  for (const [op, method, data, fields, preimage, , expected] of cases) {
    const { input } = prepare(descriptor, {}, op, data);
    const row = { op, kind: 'tbank', payload: input };
    assert.equal(noReplay({ descriptors: { tbank: descriptor } }, row), op !== 'getCheckout');
    const sandbox = await deliverRow(descriptor, row, {}, {
      mode: 'sandbox', secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox made a network call'),
    });
    assert.equal(sandbox.status, 'sent');
    const live = await deliverRow(descriptor, row, {}, { secret: () => config.operatorToken });
    assert.equal(live.status, 'sent');
    assert.deepEqual(JSON.parse(live.result), expected);
    assert.equal(live.response, undefined);
    const sent = requests.at(-1);
    assert.equal(sent.url, scope + method);
    assert.equal(sent.request.redirect, 'manual');
    assert.equal(sent.request.headers.authorization, 'Bearer ' + config.apiToken);
    assert.deepEqual(JSON.parse(sent.request.body), { TerminalKey: config.terminalKey, ...fields,
      Token: createHash('sha256').update(preimage).digest('hex') });
  }
  assert.equal(requests.length, 3);
});

test('T-Bank bridge rejects missing credentials, mismatched refunds and bank errors without leakage', async (t) => {
  let calls = 0;
  const url = await localBridge(t, async () => {
    calls++;
    if (calls === 2) throw new Error('network error containing ' + config.password);
    return Response.json({ ...base, Status: 'PARTIAL_REFUNDED', OriginalAmount: 1250, NewAmount: 1100 });
  });
  const send = (path, body, auth = config.operatorToken) => fetch(url + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal((await send('/status', { id: '123456' }, 'wrong')).status, 401);
  assert.equal((await send('/refund', { id: '123456', amountMinor: -5 })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await send('/refund', { id: '123456', amountMinor: 250 })).status, 502);
  const error = await send('/status', { id: '123456' });
  assert.equal(error.status, 502);
  assert.deepEqual(await error.json(), { error: 'bank request failed' });
});
