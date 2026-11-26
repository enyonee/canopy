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
  'mercado-pago': {
    createCheckout: ['POST', '/checkout/preferences', { ...checkout, amount: 12.5, currency: 'BRL', title: 'Order' }, {
      items: [{ id: 'test-order', title: 'Order', quantity: 1, currency_id: 'BRL', unit_price: 12.5 }],
      external_reference: 'test-order', back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
    }, { id: '123-demo', init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123-demo' },
    { id: '123-demo', checkoutUrl: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123-demo' }],
    getPayment: ['GET', '/v1/payments/123', { id: 123 }, undefined,
      { id: 123, status: 'approved', transaction_amount: 12.5, currency_id: 'BRL', external_reference: 'test-order' },
      { id: 123, status: 'approved', amount: 12.5, currency: 'BRL', orderId: 'test-order' }],
    refundCheckout: ['POST', '/v1/payments/123/refunds', { paymentId: 123, amount: 12.5 }, { amount: 12.5 },
      { id: 456, payment_id: 123, status: 'approved', amount: 12.5 }, { id: 456, paymentId: 123, status: 'approved', amount: 12.5 }],
    getRefund: ['GET', '/v1/payments/123/refunds/456', { paymentId: 123, id: 456 }, undefined,
      { id: 456, payment_id: 123, status: 'approved', amount: 12.5 }, { id: 456, paymentId: 123, status: 'approved', amount: 12.5 }],
  },
  adyen: {
    createCheckout: ['POST', '/checkout/v71/paymentLinks', { orderId: 'test-order', amountMinor: 1250, currency: 'EUR', returnUrl }, {
      merchantAccount: 'TestMerchant', reference: 'test-order', countryCode: 'NL', amount: { value: 1250, currency: 'EUR' },
      returnUrl, reusable: false,
    }, { id: 'PL12345', status: 'active', reference: 'test-order', amount: { value: 1250, currency: 'EUR' }, url: 'https://eu.adyen.link/PL12345' },
    { id: 'PL12345', status: 'active', orderId: 'test-order', amountMinor: 1250, currency: 'EUR', checkoutUrl: 'https://eu.adyen.link/PL12345' }],
    getCheckout: ['GET', '/checkout/v71/paymentLinks/PL12345', { id: 'PL12345' }, undefined,
      { id: 'PL12345', status: 'paymentPending', reference: 'test-order', amount: { value: 1250, currency: 'EUR' } },
      { id: 'PL12345', status: 'paymentPending', orderId: 'test-order', amountMinor: 1250, currency: 'EUR' }],
    refundCheckout: ['POST', '/checkout/v71/payments/123456789/refunds',
      { paymentPspReference: '123456789', reference: 'refund-1', amountMinor: 1250, currency: 'EUR' },
      { merchantAccount: 'TestMerchant', reference: 'refund-1', amount: { value: 1250, currency: 'EUR' } },
      { pspReference: '987654321', paymentPspReference: '123456789', status: 'received', reference: 'refund-1' },
      { id: '987654321', paymentId: '123456789', status: 'received', reference: 'refund-1' }],
  },
};

const auth = {
  paypal: ['https://api-m.paypal.com', 'PayPal-Request-Id', 'authorization', 'Bearer access-fixture'],
  mollie: ['https://api.mollie.com', 'Idempotency-Key', 'authorization', 'Bearer fixture-apiKey'],
  'mercado-pago': ['https://api.mercadopago.com', 'X-Idempotency-Key', 'authorization', 'Bearer fixture-accessToken'],
  adyen: ['https://test-prefix-checkout-live.adyenpayments.com', 'idempotency-key', 'X-API-Key', 'fixture-apiKey'],
};

for (const [name, operations] of Object.entries(cases)) test(`${name}: offline sandbox and authenticated request contracts`, async () => {
  const descriptor = loadDescriptor(name);
  const config = name === 'adyen' ? { endpointPrefix: 'test-prefix', merchantAccount: 'TestMerchant', countryCode: 'NL' } : {};
  const [base, idemHeader, authHeader, authValue] = auth[name];
  assert.deepEqual(checkDescriptor(descriptor), []);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), Object.keys(operations).sort());
  for (const [op, [method, path, data, body, reply, result]] of Object.entries(operations)) {
    const prepared = prepare(descriptor, config, op, data);
    const row = { kind: name, op, payload: prepared.input };
    const offline = await deliverRow(descriptor, row, config, {
      mode: 'sandbox', idemKey: key, secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox made a network call'),
    });
    assert.equal(offline.status, 'sent', op);
    let authorized = false, requests = 0;
    const live = await deliverRow(descriptor, row, config, {
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
        assert.equal(url, base + path);
        assert.equal(req.method, method);
        assert.equal(req.headers[authHeader], authValue);
        assert.equal(authorized, name === 'paypal');
        assert.equal(req.headers[idemHeader], key);
        assert.deepEqual(req.body === undefined ? undefined : JSON.parse(req.body), body);
        return Response.json({ ...reply, private_data: 'should never be recorded' });
      },
    });
    assert.equal(requests, 1, op);
    assert.equal(live.status, 'sent', op);
    assert.equal(live.response, undefined, op);
    assert.deepEqual(JSON.parse(live.result), result, op);
    if (name === 'paypal') assert.equal(noReplay({ descriptors: { paypal: descriptor } }, row), method === 'POST');
    if (name === 'mercado-pago') assert.equal(noReplay({ descriptors: { [name]: descriptor } }, row), op === 'createCheckout');
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
