import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBridge } from '../bridges/robokassa/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { loadDescriptor } from './replay.mjs';

const operatorToken = 'fixture-operator-credential';
const merchantLogin = 'fixture-shop';
const password = 'fixture-key';
const origin = 'https://services.robokassa.ru/InvoiceServiceWebApi/api/';
const id = '01234567-89ab-4cde-8f01-23456789abcd';
const checkoutUrl = 'https://auth.robokassa.ru/merchant/Invoice/example';
const invoice = { invId: 1001, id, invoiceType: 'OneTime', outSum: 245.50, invoiceStatus: 'Paid', userFields: { private: 'not recorded' } };

async function launch(t, fetchImpl) {
  const server = createBridge({ operatorToken, merchantLogin, password }, fetchImpl);
  t.after(() => new Promise((done) => server.close(done)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

const object = (segment) => JSON.parse(Buffer.from(segment, 'base64url'));

test('Robokassa creates and looks up a single-use invoice through a signed loopback request', async (t) => {
  const request = [];
  const descriptor = loadDescriptor('robokassa');
  descriptor.base = await launch(t, async (url, init) => {
    request.push(url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['content-type'], 'application/json');
    const [head, body, digest] = JSON.parse(init.body).split('.');
    assert.deepEqual(object(head), { typ: 'JWT', alg: 'HS256' });
    assert.equal(digest, createHmac('sha256', merchantLogin + ':' + password).update(head + '.' + body).digest('base64url'));
    if (url === origin + 'CreateInvoice') {
      assert.deepEqual(object(body), { MerchantLogin: merchantLogin, InvId: 1001,
        InvoiceType: 'OneTime', Culture: 'ru', OutSum: 245.5, Description: 'Order' });
      return Response.json({ id, invId: 1001, url: checkoutUrl, isSuccess: true });
    }
    assert.equal(url, origin + 'GetInvoiceInformation');
    assert.deepEqual(object(body), { MerchantLogin: merchantLogin, InvId: 1001 });
    return Response.json({ invoiceInformation: invoice, isSuccess: true });
  });
  const cases = [
    ['createCheckout', { invoiceId: 1001, amountMinor: 24550, description: 'Order' }, { checkoutUrl }],
    ['getCheckout', { invoiceId: 1001 }, { amountMinor: 24550, status: 'Paid' }],
  ];
  for (const [op, data, projected] of cases) {
    const { input } = prepare(descriptor, {}, op, data);
    const row = { op, payload: input };
    const offline = await deliverRow(descriptor, row, {}, {
      mode: 'sandbox', secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox made a network call'),
    });
    assert.equal(offline.status, 'sent');
    const live = await deliverRow(descriptor, row, {}, { secret: () => operatorToken });
    assert.equal(live.status, 'sent');
    assert.deepEqual(JSON.parse(live.result), { id, invoiceId: 1001, currency: 'RUB', ...projected });
    assert.equal(live.response, undefined);
  }
  assert.deepEqual(request, [origin + 'CreateInvoice', origin + 'GetInvoiceInformation']);
});

test('Robokassa rejects invalid operator calls, provider refusal, invoice mismatch and imprecise amounts', async (t) => {
  const replies = [{ isSuccess: false, private: password },
    { isSuccess: true, invoiceInformation: { ...invoice, invId: 1002 } },
    { isSuccess: true, invoiceInformation: { ...invoice, outSum: 0.001 } }];
  const url = await launch(t, async () => Response.json(replies.shift()));
  const status = (token = operatorToken, invoiceId = 1001) => fetch(url + '/status', {
    method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ invoiceId }),
  });
  assert.equal((await status('other-token')).status, 401);
  assert.equal((await status(operatorToken, -1)).status, 400);
  const rejected = await status();
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: 'provider rejected the invoice operation' });
  assert.equal((await status()).status, 502);
  assert.equal((await status()).status, 502);
});
