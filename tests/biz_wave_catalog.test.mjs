import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDescriptor } from './replay.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';

const order = { id: 41, status: 'processing', currency: 'USD', total: '12.50' };
const email = 'person@example.test';
const orderPath = '/wp-json/wc/v3/orders';
const orderFields = '_fields=id,status,currency,total';
const catalog = {
  'yandex-market': {
    base: 'https://api.partner.market.yandex.ru',
    config: { businessId: 82 },
    auth: { 'Api-Key': 'test-apiKey' },
    ops: {
      getOrder: {
        method: 'POST', path: '/v1/businesses/82/orders?limit=1', input: { id: 41 },
        body: { orderIds: [41] },
        reply: { orders: [{ id: 41, status: 'PROCESSING', buyer: { email } }] },
        result: { id: 41, status: 'PROCESSING' },
      },
      getStock: {
        method: 'POST', path: '/v3/businesses/82/offers/stocks', input: { warehouseId: 5, sku: 'SKU & 12' },
        body: { partnerWarehouseId: 5, offerIds: ['SKU & 12'] },
        reply: { status: 'OK', result: { partnerWarehouseId: 5, offers: [{ offerId: 'SKU & 12', stocks: [{ type: 'AVAILABLE', count: 7 }] }] } },
        result: { warehouseId: 5, offers: [{ offerId: 'SKU & 12', stocks: [{ type: 'AVAILABLE', count: 7 }] }] },
      },
    },
  },
  woocommerce: {
    base: 'https://store.example.test',
    config: { host: 'store.example.test' },
    auth: { authorization: 'Basic test-basicCredential' },
    ops: {
      listOrders: { path: orderPath + '?page=1&per_page=20&' + orderFields, input: {}, reply: [order], result: { orders: [order] } },
      getOrder: { path: orderPath + '/41?' + orderFields, input: { id: 41 }, reply: { ...order, billing: { email } }, result: order },
      setOrderStatus: {
        method: 'PUT', path: orderPath + '/41?' + orderFields, input: { id: 41, status: 'completed' },
        body: { status: 'completed' }, reply: { ...order, status: 'completed' }, result: { ...order, status: 'completed' },
      },
      getStock: {
        path: '/wp-json/wc/v3/products/41?_fields=id,stock_status,manage_stock',
        input: { id: 41 }, reply: { id: 41, stock_status: 'instock', manage_stock: false }, result: { id: 41, stockStatus: 'instock', managed: false },
      },
      getStockQuantity: {
        path: '/wp-json/wc/v3/products/41?_fields=id,stock_quantity,manage_stock',
        input: { id: 41 }, reply: { id: 41, stock_quantity: 12, manage_stock: true }, result: { id: 41, quantity: 12 },
      },
    },
  },
  hubspot: {
    base: 'https://api.hubapi.com',
    config: {},
    auth: { authorization: 'Bearer test-accessToken' },
    ops: {
      createContact: {
        method: 'POST', path: '/crm/v3/objects/contacts', input: { email, firstName: 'Demo', lastName: 'Buyer' },
        body: { properties: { email, firstname: 'Demo', lastname: 'Buyer' } }, reply: { id: '41', properties: { email } }, result: { id: '41' },
      },
      getContact: {
        path: '/crm/v3/objects/contacts/41?properties=email,firstname,lastname', input: { id: '41' },
        reply: { id: '41', properties: { email, mobilephone: '+10000000000' } }, result: { id: '41', email },
      },
      createDeal: {
        method: 'POST', path: '/crm/v3/objects/deals', input: { name: 'Demo', pipeline: 'default', stage: 'qualified' },
        body: { properties: { dealname: 'Demo', pipeline: 'default', dealstage: 'qualified' } }, reply: { id: '41' }, result: { id: '41' },
      },
      setDealStage: {
        method: 'PATCH', path: '/crm/v3/objects/deals/41', input: { id: '41', stage: 'closedwon' },
        body: { properties: { dealstage: 'closedwon' } }, reply: { id: '41', properties: { dealstage: 'closedwon' } },
        result: { id: '41', stage: 'closedwon' },
      },
    },
  },
  'whatsapp-business': {
    base: 'https://graph.facebook.com',
    config: { phoneNumberId: '82' },
    auth: { authorization: 'Bearer test-accessToken' },
    ops: {
      sendTemplate: {
        method: 'POST', path: '/v23.0/82/messages',
        input: { to: '12025550134', template: 'order_ready', language: 'en_US' },
        body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '12025550134',
          type: 'template', template: { name: 'order_ready', language: { code: 'en_US' } } },
        reply: { messages: [{ id: 'wamid.fixture' }], contacts: [{ input: '12025550134' }] },
        result: { messageId: 'wamid.fixture' },
      },
    },
  },
};

for (const [name, { base, config, auth, ops }] of Object.entries(catalog)) test(`${name}: sandbox and live request/reply contracts`, async () => {
  const descriptor = loadDescriptor(name);
  assert.deepEqual(checkDescriptor(descriptor), []);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), Object.keys(ops).sort());
  for (const [op, spec] of Object.entries(ops)) {
    const { target, input } = prepare(descriptor, config, op, spec.input);
    assert.equal(target, base + spec.path, op);
    const row = { op, payload: input, target };
    const sandbox = await deliverRow(descriptor, row, config, {
      mode: 'sandbox', idemKey: 'test',
      secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox made a network call'),
    });
    assert.equal(sandbox.status, 'sent', op);
    assert.equal(sandbox.response, undefined, op);
    let calls = 0;
    const live = await deliverRow(descriptor, row, config, {
      secret: (slot) => `test-${slot}`,
      fetchImpl: async (url, request) => {
        calls++;
        assert.equal(url, target);
        assert.equal(request.method, spec.method ?? 'GET');
        assert.equal(request.redirect, 'manual');
        for (const [header, value] of Object.entries(auth)) assert.equal(request.headers[header], value);
        if (spec.body !== undefined) assert.deepEqual(JSON.parse(request.body), spec.body);
        return Response.json(spec.reply);
      },
    });
    assert.equal(calls, 1, op);
    assert.equal(live.status, 'sent', op);
    assert.equal(live.response, undefined, op);
    assert.deepEqual(JSON.parse(live.result), spec.result, op);
  }
});

test('order lookups fail closed on an empty provider result; writes reject unsupported statuses', async () => {
  const descriptor = loadDescriptor('yandex-market');
  const res = await deliverRow(descriptor, { op: 'getOrder', payload: { id: 41 } }, { businessId: 82 }, {
    secret: () => 'test-apiKey',
    fetchImpl: async () => Response.json({ orders: [], unrelated: email }),
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.response, undefined);
  assert.equal(res.result, undefined);
  assert.throws(() => prepare(loadDescriptor('woocommerce'), { host: 'store.example.test' }, 'setOrderStatus', { id: 41, status: 'paid' }), /status/);
});

test('WooCommerce does not retain buyer data if the server ignores its list field filter', async () => {
  const descriptor = loadDescriptor('woocommerce');
  const config = { host: 'store.example.test' };
  const { input } = prepare(descriptor, config, 'listOrders', {});
  const result = await deliverRow(descriptor, { op: 'listOrders', payload: input }, config, {
    secret: () => 'test-basicCredential',
    fetchImpl: async () => Response.json([{ ...order, billing: { email } }]),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.response, undefined);
  assert.equal(result.result, undefined);
});

test('Telegram sends a Bot API request without exposing its path credential', async () => {
  const descriptor = loadDescriptor('telegram-bot');
  assert.deepEqual(checkDescriptor(descriptor), []);
  const op = 'sendMessage';
  const data = { chatId: '-100123', text: 'Order ready' };
  const { input, target } = prepare(descriptor, {}, op, data);
  assert.equal(target, 'https://api.telegram.org/redacted/sendMessage');
  const row = { kind: 'telegram-bot', op, payload: input, target };
  assert.equal(noReplay({ descriptors: { [row.kind]: descriptor } }, row), true);
  const offline = await deliverRow(descriptor, row, {}, {
    mode: 'sandbox', secret: () => assert.fail('sandbox read a secret'),
    fetchImpl: () => assert.fail('sandbox made a network call'),
  });
  assert.deepEqual(JSON.parse(offline.result), { messageId: 123 });
  const token = 'bot12345:fixture-token';
  const secret = (slot) => { assert.equal(slot, 'botPath'); return token; };
  const result = await deliverRow(descriptor, row, {}, {
    secret,
    fetchImpl: async (url, req) => {
      assert.equal(url, `https://api.telegram.org/${token}/sendMessage`);
      assert.equal(req.method, 'POST');
      assert.equal(req.redirect, 'manual');
      assert.deepEqual(JSON.parse(req.body), { chat_id: '-100123', text: 'Order ready', link_preview_options: { is_disabled: true } });
      return Response.json({ ok: true, result: { message_id: 33, text: token } });
    },
  });
  assert.deepEqual(JSON.parse(result.result), { messageId: 33 });
  assert.equal(result.response, undefined);
  await assert.rejects(deliverRow(descriptor, row, {}, {
    secret, fetchImpl: async () => { throw new Error('failed at /' + token); },
  }), (err) => err.message === 'authorized provider request failed' && !Object.hasOwn(err, 'cause'));
  await assert.rejects(deliverRow(descriptor, row, {}, {
    secret: () => 'bot12345:abc/unsafe', fetchImpl: () => assert.fail('unsafe URL was requested'),
  }), /invalid path credential/);
  const refused = await deliverRow(descriptor, row, {}, { secret, fetchImpl: async () => Response.json({ ok: false, description: token }) });
  assert.equal(refused.status, 'failed');
  assert.ok(!JSON.stringify(refused).includes(token));
});
