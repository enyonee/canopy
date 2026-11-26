import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDescriptor } from './replay.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';

const key = '0123456789abcdef0123456789abcdef';
const returnUrl = 'https://merchant.example.test/return';
const cancelUrl = 'https://merchant.example.test/cancel';
const checkout = { orderId: 'test-order', amount: '12.50', returnUrl };
const paypalCheckout = { ...checkout, currency: 'USD', cancelUrl };
const paypalAmount = { value: '12.50', currency_code: 'USD' };
const approve = 'https://www.paypal.com/checkoutnow?token=ORDER123';
const paypalCapture = { id: 'CAPTURE123', status: 'COMPLETED', amount: paypalAmount };
const paypalRefund = { id: 'REFUND123', status: 'PENDING', amount: paypalAmount };
const captured = { id: 'ORDER123', status: 'COMPLETED', purchase_units: [
  { reference_id: 'test-order', payments: { captures: [paypalCapture] } },
] };
const captureResult = { id: 'ORDER123', status: 'COMPLETED', orderId: 'test-order',
  captureId: 'CAPTURE123', captureStatus: 'COMPLETED', amount: '12.50', currency: 'USD' };
const mollieCheckout = { ...checkout, description: 'Order', currency: 'EUR' };
const mollieAmount = { value: '12.50', currency: 'EUR' };
const mollieResult = { id: 'tr_12345', status: 'open', orderId: 'test-order', ...checkoutMoney('EUR') };
const molliePayment = { id: 'tr_12345', status: 'open', amount: mollieAmount, metadata: { orderId: 'test-order' } };
const mollieRefund = { id: 're_12345', paymentId: 'tr_12345', status: 'pending', amount: mollieAmount };
const mollieRefundResult = { id: 're_12345', paymentId: 'tr_12345', status: 'pending', ...checkoutMoney('EUR') };
const mollieLink = 'https://www.mollie.com/checkout/demo';
const currencyInput = (currency) => ({ amount: '12.50', currency });
function checkoutMoney(currency) { return { amount: '12.50', currency }; }

const cases = {
  paypal: {
    createCheckout: ['POST', '/v2/checkout/orders', paypalCheckout, {
      intent: 'CAPTURE', purchase_units: [{ reference_id: 'test-order', custom_id: 'test-order', amount: paypalAmount }],
      payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
        return_url: returnUrl, cancel_url: cancelUrl } } },
    }, { id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', links: [
      { rel: 'self', href: 'https://api-m.paypal.com/v2/checkout/orders/ORDER123' },
      { rel: 'payer-action', href: approve },
    ] }, { id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED', checkoutUrl: approve }],
    getCheckout: ['GET', '/v2/checkout/orders/ORDER123', { id: 'ORDER123' }, undefined,
      { id: 'ORDER123', status: 'APPROVED' }, { id: 'ORDER123', status: 'APPROVED' }],
    captureCheckout: ['POST', '/v2/checkout/orders/ORDER123/capture', { id: 'ORDER123' }, {}, captured, captureResult],
    getCapturedOrder: ['GET', '/v2/checkout/orders/ORDER123', { id: 'ORDER123' }, undefined, captured, captureResult],
    getCapture: ['GET', '/v2/payments/captures/CAPTURE123', { id: 'CAPTURE123' }, undefined, paypalCapture,
      { id: 'CAPTURE123', status: 'COMPLETED', ...checkoutMoney('USD') }],
    refundCheckout: ['POST', '/v2/payments/captures/CAPTURE123/refund', { captureId: 'CAPTURE123', ...currencyInput('USD') },
      { amount: paypalAmount }, paypalRefund, { id: 'REFUND123', status: 'PENDING', ...checkoutMoney('USD') }],
    getRefund: ['GET', '/v2/payments/refunds/REFUND123', { id: 'REFUND123' }, undefined,
      { ...paypalRefund, status: 'COMPLETED' }, { id: 'REFUND123', status: 'COMPLETED', ...checkoutMoney('USD') }],
  },
  mollie: {
    createCheckout: ['POST', '/v2/payments', mollieCheckout, { amount: mollieAmount, description: 'Order',
      redirectUrl: returnUrl, metadata: { orderId: 'test-order' } },
    { ...molliePayment, _links: { checkout: { href: mollieLink } } }, { ...mollieResult, checkoutUrl: mollieLink }],
    getCheckout: ['GET', '/v2/payments/tr_12345', { id: 'tr_12345' }, undefined,
      { ...molliePayment, status: 'paid' }, { ...mollieResult, status: 'paid' }],
    refundCheckout: ['POST', '/v2/payments/tr_12345/refunds', { paymentId: 'tr_12345', ...currencyInput('EUR') },
      { amount: mollieAmount }, mollieRefund, mollieRefundResult],
    getRefund: ['GET', '/v2/payments/tr_12345/refunds/re_12345', { paymentId: 'tr_12345', id: 're_12345' }, undefined,
      { ...mollieRefund, status: 'refunded' }, { ...mollieRefundResult, status: 'refunded' }],
  },
};

for (const [name, operations] of Object.entries(cases)) test(`${name}: offline sandbox and authenticated request contracts`, async () => {
  const descriptor = loadDescriptor(name);
  assert.deepEqual(checkDescriptor(descriptor), []);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), Object.keys(operations).sort());
  for (const [op, [method, path, data, body, reply, result]] of Object.entries(operations)) {
    const prepared = prepare(descriptor, {}, op, data);
    const row = { kind: name, op, payload: prepared.input };
    const offline = await deliverRow(descriptor, row, {}, {
      mode: 'sandbox', idemKey: key, secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox made a network call'),
    });
    assert.equal(offline.status, 'sent', op);
    let authorized = false, requests = 0;
    const live = await deliverRow(descriptor, row, {}, {
      idemKey: key, secret: (slot) => 'fixture-' + slot,
      fetchImpl: async (url, req) => {
        assert.equal(req.redirect, 'manual');
        if (url === 'https://api-m.paypal.com/v1/oauth2/token') {
          assert.equal(name, 'paypal');
          assert.equal(req.method, 'POST');
          assert.equal(req.body, 'grant_type=client_credentials');
          assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('fixture-clientId:fixture-clientSecret').toString('base64'));
          authorized = true;
          return Response.json({ access_token: 'access-fixture' });
        }
        requests++;
        assert.equal(url, (name === 'paypal' ? 'https://api-m.paypal.com' : 'https://api.mollie.com') + path);
        assert.equal(req.method, method);
        assert.equal(req.headers.authorization, name === 'paypal' ? 'Bearer access-fixture' : 'Bearer fixture-apiKey');
        assert.equal(authorized, name === 'paypal');
        assert.equal(req.headers[name === 'paypal' ? 'PayPal-Request-Id' : 'Idempotency-Key'], key);
        assert.deepEqual(req.body === undefined ? undefined : JSON.parse(req.body), body);
        return Response.json({ ...reply, private_data: 'should never be recorded' });
      },
    });
    assert.equal(requests, 1, op);
    assert.equal(live.status, 'sent', op);
    assert.equal(live.response, undefined, op);
    assert.deepEqual(JSON.parse(live.result), result, op);
    if (name === 'paypal') assert.equal(noReplay({ descriptors: { paypal: descriptor } }, row), method === 'POST');
  }
});

test('PayPal fails closed on expired credentials, off-provider links, and absent captures', async () => {
  const descriptor = loadDescriptor('paypal');
  const op = 'createCheckout', row = { op, payload: paypalCheckout };
  const secret = () => 'fixture-key';
  await assert.rejects(deliverRow(descriptor, row, {}, {
    secret, fetchImpl: async (url) => {
      assert.equal(url, 'https://api-m.paypal.com/v1/oauth2/token');
      return new Response(null, { status: 401 });
    },
  }), /could not authorize/);
  const live = (row, reply) => deliverRow(descriptor, row, {}, {
    secret, fetchImpl: async (url) => Response.json(url.endsWith('/oauth2/token') ? { access_token: 'fixture-access' } : reply),
  });
  const offsite = await live(row, { id: 'ORDER123', status: 'PAYER_ACTION_REQUIRED',
    links: [{ rel: 'payer-action', href: 'https://www.paypal.com.evil.test/checkoutnow?token=ORDER123' }] });
  assert.equal(offsite.status, 'failed');
  assert.equal(offsite.result, undefined);
  const uncaptured = await live({ op: 'getCapturedOrder', payload: { id: 'ORDER123' } }, { id: 'ORDER123', status: 'APPROVED' });
  assert.equal(uncaptured.status, 'failed');
  assert.equal(uncaptured.result, undefined);
  assert.throws(() => prepare(descriptor, {}, op, { ...paypalCheckout, amount: '0.00101' }), /amount/);
});
