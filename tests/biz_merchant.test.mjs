import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { createBridge } from '../bridges/uz-payments/server.mjs';
import { tmpDir } from './helpers.mjs';
import { loadDescriptor } from './replay.mjs';
import { deliverRow } from '../runtime/connectors/engine.mjs';

const config = {
  operatorToken: 'not-a-real-operator-token', returnUrl: 'https://shop.example/return',
  paymeMerchant: 'fixture-merchant', paymeKey: 'fixture-payme-key',
  clickMerchant: '1234', clickService: '5678', clickSecret: 'fixture-click-key',
};
const amounts = { payme: 250000, click: 125025 };

async function fixture(t) {
  const file = path.join(tmpDir('uz-payments-', t), 'ledger.sqlite');
  let now = 1700000000000, server, base, seq = 0;
  const stop = async () => {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.closeAllConnections(); server.close();
    await closed;
  };
  async function start() {
    server = createBridge({ config, file, now: () => now });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  await start();
  t.after(stop);
  const rpc = async (method, params, auth = 'Basic ' + Buffer.from('Paycom:' + config.paymeKey).toString('base64')) => {
    const id = ++seq;
    const response = await fetch(base + '/payme', { method: 'POST', headers: { authorization: auth }, body: JSON.stringify({ method, params, id }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, id);
    return body;
  };
  async function sendClick(fields) {
    const f = { click_trans_id: '9901', service_id: config.clickService, merchant_trans_id: 'click-order',
      amount: '1250.25', action: '0', sign_time: '2026-11-26 12:00:00', ...fields };
    f.sign_string ??= createHash('md5').update([f.click_trans_id, f.service_id, config.clickSecret,
      f.merchant_trans_id, f.action === '1' ? f.merchant_prepare_id : '', f.amount, f.action, f.sign_time].join('')).digest('hex');
    const response = await fetch(base + '/click', { method: 'POST', body: new URLSearchParams(f) });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function connector(provider, op, payload) {
    return deliverRow(loadDescriptor(provider), { op, payload }, {}, { mode: 'live', secret: () => config.operatorToken,
      fetchImpl: (target, init) => fetch(base + new URL(target).pathname, init) });
  }
  const op = (provider, name, payload) => connector(provider, name, payload).then(result => {
    assert.equal(result.status, 'sent');
    assert.equal(result.response, undefined);
    return JSON.parse(result.result);
  });
  const register = (provider, id = provider + '-order') => op(provider, 'createCheckout', { id, amountMinor: amounts[provider] });
  const get = (provider, id = provider + '-order') => op(provider, 'getCheckout', { id });
  return { rpc, sendClick, connector, register, get, at: () => now, step: (ms) => { now += ms; },
    restart: async () => { await stop(); await start(); }, unauthenticated: () => fetch(base + '/orders/payme-order') };
}

test('Payme merchant protocol persists a single charge, validates immutable amount and supports reconciliation', async (t) => {
  const f = await fixture(t);
  const { checkoutUrl } = await f.register('payme');
  assert.equal(new URL(checkoutUrl).hostname, 'checkout.paycom.uz');
  const account = { order_id: 'payme-order' }, amount = amounts.payme;
  const params = { account, amount, id: 'provider-1', time: f.at() };
  assert.equal((await f.unauthenticated()).status, 401);
  assert.equal((await f.rpc('CheckPerformTransaction', params, 'Basic wrong')).error.code, -32504);
  assert.equal((await f.rpc('CheckPerformTransaction', { ...params, amount: 1 })).error.code, -31001);
  assert.equal((await f.rpc('CheckPerformTransaction', params)).result.allow, true);
  const created = (await f.rpc('CreateTransaction', params)).result;
  assert.equal(created.state, 1);
  assert.deepEqual((await f.rpc('CreateTransaction', params)).result, created);
  assert.equal((await f.rpc('CreateTransaction', { ...params, id: 'other' })).error.code, -31008);
  assert.equal((await f.connector('payme', 'createCheckout', { id: 'payme-order', amountMinor: 100 })).code, 409);
  assert.equal((await f.get('payme')).state, 'pending');
  f.step(1000);
  const paid = (await f.rpc('PerformTransaction', { id: params.id })).result;
  assert.equal(paid.state, 2);
  await f.restart();
  assert.deepEqual((await f.rpc('PerformTransaction', { id: params.id })).result, paid);
  assert.equal((await f.get('payme')).state, 'paid');
  const stmt = (await f.rpc('GetStatement', { from: params.time, to: f.at() })).result.transactions;
  assert.equal(stmt.length, 1);
  assert.equal(stmt[0].amount, amount);
  const cancel = (await f.rpc('CancelTransaction', { id: params.id, reason: 5 })).result;
  assert.equal(cancel.state, -2);
  assert.equal((await f.get('payme')).state, 'reversed');
  assert.deepEqual((await f.rpc('CancelTransaction', { id: params.id, reason: 5 })).result, cancel);
});

test('CLICK Prepare/Complete checks signatures, amount and ownership, and does not double-charge', async (t) => {
  const f = await fixture(t);
  assert.equal(new URL((await f.register('click')).checkoutUrl).searchParams.get('amount'), '1250.25');
  await f.register('click', 'other-order');
  assert.equal((await f.sendClick({ sign_string: 'bad' })).error, -1);
  assert.equal((await f.sendClick({ amount: '1250.26' })).error, -2);
  const pending = await f.sendClick({});
  assert.equal(pending.error, 0);
  assert.deepEqual(await f.sendClick({}), pending);
  assert.equal((await f.get('click')).state, 'pending');
  const complete = { action: '1', merchant_prepare_id: String(pending.merchant_prepare_id), error: '0' };
  assert.equal((await f.sendClick({ ...complete, merchant_trans_id: 'other-order' })).error, -6);
  assert.equal((await f.sendClick({ ...complete, merchant_prepare_id: '123' })).error, -6);
  assert.equal((await f.sendClick(complete)).error, 0);
  await f.restart();
  assert.equal((await f.sendClick(complete)).error, -4);
  assert.equal((await f.get('click')).state, 'paid');
  assert.equal((await f.get('click', 'other-order')).state, 'unpaid');
});

test('expired Payme and declined CLICK callbacks cannot turn an order into paid', async (t) => {
  const f = await fixture(t);
  await f.register('payme');
  await f.register('click');
  const id = 'provider-expired';
  assert.equal((await f.rpc('CreateTransaction', { id, account: { order_id: 'payme-order' }, time: f.at(), amount: amounts.payme })).result.state, 1);
  f.step(43_200_000);
  assert.equal((await f.rpc('PerformTransaction', { id })).error.code, -31008);
  assert.equal((await f.get('payme')).state, 'cancelled');
  const pending = await f.sendClick({});
  const complete = { action: '1', merchant_prepare_id: String(pending.merchant_prepare_id), error: '-9' };
  assert.equal((await f.sendClick(complete)).error, -9);
  assert.equal((await f.sendClick({ ...complete, error: '0' })).error, -9);
  assert.equal((await f.get('click')).state, 'cancelled');
});
