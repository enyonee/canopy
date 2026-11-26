import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDescriptor } from './replay.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const ret = 'https://shop.example/return';
const key = '0123456789abcdef0123456789abcdef';
const credentials = slot => 'fixture-' + slot;
const config = { 'halyk-epay': { shopId: id } };
const date = '2026-11-01T00:00:00Z';
const cdekPackage = { number: 'box', weight: 1000, length: 20, width: 20, height: 20,
  items: [{ name: 'Demo', ware_key: 'sku', payment: { value: 0 }, cost: 100, weight: 1000, amount: 1 }] };
const endpoints = {
  'ozon-seller': {
    listPostings: ['POST', '/v3/posting/fbs/list', { since: date, to: date }, { dir: 'ASC', filter: { since: date, to: date }, limit: 50, offset: 0 }],
    getPosting: ['POST', '/v3/posting/fbs/get', { postingNumber: 'posting-1' }, { posting_number: 'posting-1' }],
  },
  wildberries: {
    listNewOrders: ['GET', '/api/v3/orders/new', {}],
    getOrderStatuses: ['POST', '/api/v3/orders/status', { orders: [12] }, { orders: [12] }],
    getStocks: ['POST', '/api/v3/stocks/30', { warehouseId: 30, chrtIds: [12345] }, { chrtIds: [12345] }],
  },
  'kaspi-shop': {
    listOrders: ['GET', '/shop/api/v2/orders?page%5Bnumber%5D=0&page%5Bsize%5D=20&filter%5Borders%5D%5Bstate%5D=NEW&filter%5Borders%5D%5BcreationDate%5D%5B%24ge%5D=1', { fromMs: 1 }],
    getOrder: ['GET', '/shop/api/v2/orders?filter%5Borders%5D%5Bcode%5D=1000', { code: '1000' }],
    listOrderEntries: ['GET', '/shop/api/v2/orders/abcd%3D/entries', { id: 'abcd=' }],
  },
  moysklad: {
    getOrder: ['GET', '/api/remap/1.2/entity/customerorder/' + id, { id }],
    createOrder: ['POST', '/api/remap/1.2/entity/customerorder', { organizationId: id, agentId: id, externalCode: 'order-1', productId: id, quantity: 2, unitPriceMinor: 100 }],
    listStocks: ['GET', '/api/remap/1.2/report/stock/all?limit=50&offset=0', {}],
  },
  cdek: {
    calculateTariffs: ['POST', '/v2/calculator/tarifflist', { fromCode: 44, toCode: 137, weight: 1000, length: 20, width: 20, height: 20 },
      { type: 1, from_location: { code: 44 }, to_location: { code: 137 }, packages: [{ weight: 1000, length: 20, width: 20, height: 20 }] }],
    createShipment: ['POST', '/v2/orders', { number: 'order-1', tariffCode: 137, from: { code: 44, address: 'Pickup' },
      to: { code: 137, address: 'Delivery' }, recipientName: 'Demo', recipientPhone: '+70000000000', package: cdekPackage }],
    getShipment: ['GET', '/v2/orders/' + id, { id }],
  },
  yookassa: {
    createCheckout: ['POST', '/v3/payments', { amount: '10.00', orderId: 'order-1', returnUrl: ret, description: 'Demo' },
      { amount: { value: '10.00', currency: 'RUB' }, capture: true, confirmation: { type: 'redirect', return_url: ret }, description: 'Demo', metadata: { orderId: 'order-1' } }],
    getCheckout: ['GET', '/v3/payments/' + id, { id }],
    refundCheckout: ['POST', '/v3/refunds', { paymentId: id, amount: '10.00' }, { payment_id: id, amount: { value: '10.00', currency: 'RUB' } }],
  },
  'halyk-epay': {
    createCheckout: ['POST', '/invoice', { invoiceId: '123456', amount: 100, description: 'Demo', returnUrl: ret, callbackUrl: ret,
      accountId: 'buyer-fixture', recipientEmail: 'invoice@example.test', recipientPhone: '+70000000000' }],
    getCheckout: ['GET', '/check-status/payment/transaction/123456', { invoiceId: '123456' }],
    refundCheckout: ['POST', '/operation/' + id + '/refund', { id }],
    refundPartial: ['POST', '/operation/' + id + '/refund?amount=30', { id, amount: 30 }],
  },
  bepaid: {
    createCheckout: ['POST', '/ctp/api/checkouts', { amountMinor: 100, currency: 'BYN', orderId: 'order-1', description: 'Demo', returnUrl: ret }],
    getCheckout: ['GET', '/ctp/api/checkouts/sample-token', { id: 'sample-token' }],
    getPayment: ['GET', '/ctp/api/checkouts/sample-token', { id: 'sample-token' }],
    refundCheckout: ['POST', 'https://gateway.bepaid.by/transactions/refunds', { paymentId: 'payment-1', amountMinor: 100 }, { request: { parent_uid: 'payment-1', amount: 100 } }],
  },
};

for (const [name, operations] of Object.entries(endpoints)) test(`${name}: every operation has a request contract and an offline response`, async () => {
  const descriptor = loadDescriptor(name);
  assert.deepEqual(checkDescriptor(descriptor), []);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), Object.keys(operations).sort());
  for (const [op, [method, path, input, body]] of Object.entries(operations)) {
    const cfg = config[name] || {};
    const prepared = prepare(descriptor, cfg, op, input);
    const target = path.startsWith('https://') ? path : descriptor.base + path;
    assert.equal(prepared.target, target, op);
    const sent = await deliverRow(descriptor, { op, payload: prepared.input }, cfg, {
      mode: 'sandbox', idemKey: key, fetchImpl: () => assert.fail('sandbox has no network'),
    });
    assert.equal(sent.status, 'sent', op);
    const declared = descriptor.operations[op];
    let called = 0;
    const delivered = await deliverRow(descriptor, { op, payload: prepared.input }, cfg, {
      secret: credentials, idemKey: key, fetchImpl: async (url, init) => {
        if (url === descriptor.token?.url) {
          assert.equal(init.redirect, 'manual');
          const form = new URLSearchParams(init.body);
          assert.equal(form.get('client_id'), 'fixture-clientId');
          assert.equal(form.get('client_secret'), 'fixture-clientSecret');
          assert.equal(form.get('grant_type'), 'client_credentials');
          assert.equal(form.get('scope'), declared.tokenScope ?? null);
          return Response.json({ access_token: 'test-access-token' });
        }
        called++;
        assert.equal(url, target);
        assert.equal(init.method, method);
        assert.equal(init.redirect, 'manual');
        if (body) assert.deepEqual(JSON.parse(init.body), body);
        if (descriptor.token) assert.equal(init.headers.authorization, 'Bearer test-access-token');
        if (name === 'yookassa') assert.equal(init.headers['Idempotence-Key'], key);
        if (name === 'ozon-seller') assert.equal(init.headers['Client-Id'], 'fixture-clientId');
        if (name === 'wildberries') assert.equal(init.headers.authorization, 'fixture-apiToken');
        if (name === 'kaspi-shop') assert.equal(init.headers['X-Auth-Token'], 'fixture-apiToken');
        if (name === 'bepaid' || name === 'yookassa') assert.equal(init.headers.authorization, 'Basic fixture-basicCredential');
        return Response.json({ contract_fixture: true });
      },
    });
    assert.equal(called, 1);
    assert.equal(delivered.status, declared.resultOnly ? 'failed' : 'sent', op);
    if (declared.resultOnly) {
      assert.equal(delivered.drift, 1);
      assert.equal(delivered.response, undefined);
      assert.ok(JSON.parse(sent.result));
    }
  }
});

test('provider scope and no-replay declarations are fail-closed', () => {
  const d = loadDescriptor('halyk-epay');
  const op = d.operations.createCheckout;
  assert.equal(noReplay({ descriptors: { [d.name]: d } }, { kind: d.name, op: 'createCheckout' }), true);
  op.tokenScope = '{input.scope}';
  op.noReplay = false;
  assert.ok(checkDescriptor(d).some(([k]) => k.endsWith('/tokenScope')));
  assert.ok(checkDescriptor(d).some(([k]) => k.endsWith('/noReplay')));
});
