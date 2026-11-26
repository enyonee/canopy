import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBridge } from '../bridges/uz-payments/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { loadDescriptor } from './replay.mjs';

const config = {
  operatorToken: 'paynet-fixture-operator-token', paynetUser: 'paynet-fixture', paynetPassword: 'fixture-user-pass',
  paynetService: 19, paynetOrderField: 'client_id', paynetCancelMs: 60_000,
};
const auth = 'Basic ' + Buffer.from(config.paynetUser + ':' + config.paynetPassword).toString('base64');
const now = Date.UTC(2026, 10, 27, 8, 0, 0);
const standard = '2026-11-27 13:00:00';
const historic = 'Fri Nov 27 13:00:00 UZT 2026';

async function launch(file, options = {}) {
  const server = createBridge({ config: { ...config, ...options }, file, now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const send = (path, data, authorization) => fetch(base + path, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  return { base, send, async rpc(method, params) {
    const reply = await send('/uws', { jsonrpc: '2.0', id: 'request-1', method, params: { serviceId: 19, ...params } }, auth);
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert.equal(body.id, 'request-1');
    assert.equal(body.jsonrpc, '2.0');
    assert.notEqual('result' in body, 'error' in body);
    return body;
  }, close: () => new Promise((done) => server.close(done)) };
}

test('Paynet orders reconcile against authenticated, durable UWS callbacks', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'canopy-paynet-'));
  const file = join(folder, 'ledger.sqlite');
  let bridge = await launch(file);
  t.after(async () => { await bridge.close(); await rm(folder, { recursive: true, force: true }); });
  const descriptor = loadDescriptor('paynet');
  const call = async (op, data) => {
    descriptor.base = bridge.base;
    const { input } = prepare(descriptor, {}, op, data);
    const row = { op, payload: input };
    const sandbox = await deliverRow(descriptor, row, {}, { mode: 'sandbox', fetchImpl: () => assert.fail('sandbox sent a request') });
    assert.equal(sandbox.status, 'sent');
    const result = await deliverRow(descriptor, row, {}, { secret: () => config.operatorToken });
    assert.equal(result.status, 'sent');
    return JSON.parse(result.result);
  };
  assert.deepEqual(await call('registerOrder', { id: 'order-41', amountMinor: 1250 }), { id: 'order-41', currency: 'UZS', serviceId: 19 });
  assert.equal((await call('getCheckout', { id: 'order-41' })).state, 'unpaid');
  const fields = { client_id: 'order-41' };
  const payment = { fields, amount: 1250, transactionId: 93000000001 };
  const check = { transactionId: payment.transactionId, timestamp: historic };
  const cancel = { ...check, timestamp: standard };
  const period = { dateFrom: standard, dateTo: standard };
  assert.equal((await bridge.send('/uws', { jsonrpc: '2.0' }, 'wrong')).status, 401);
  assert.equal((await bridge.rpc('GetInformation', { fields, serviceId: 20 })).error.code, 100);
  assert.equal((await bridge.rpc('GetInformation', { fields: { client_id: 'missing' } })).error.code, 302);
  assert.deepEqual((await bridge.rpc('GetInformation', { fields })).result,
    { status: 0, timestamp: standard, fields: { ...fields, amount: '1250' } });
  assert.equal((await bridge.rpc('PerformTransaction', { ...payment, amount: 1230 })).error.code, 413);
  assert.equal((await bridge.rpc('CheckTransaction', check)).result.transactionState, 3);
  const done = (await bridge.rpc('PerformTransaction', payment)).result;
  assert.ok(done.providerTrnId > 0);
  assert.equal((await bridge.rpc('PerformTransaction', payment)).error.code, 201);
  assert.equal((await bridge.rpc('PerformTransaction', { ...payment, transactionId: 22 })).error.code, 201);
  assert.deepEqual((await bridge.rpc('GetStatement', period)).result.statements, [
    { amount: 1250, transactionId: payment.transactionId, providerTrnId: done.providerTrnId, timestamp: standard },
  ]);
  await bridge.close();
  bridge = await launch(file, { paynetCancelMs: 0 });
  assert.equal((await call('getCheckout', { id: 'order-41' })).state, 'paid');
  assert.equal((await bridge.rpc('CancelTransaction', cancel)).error.code, 306);
  await bridge.close();
  bridge = await launch(file);
  assert.deepEqual((await bridge.rpc('CheckTransaction', check)).result,
    { providerTrnId: done.providerTrnId, transactionState: 1, timestamp: standard });
  const reversed = (await bridge.rpc('CancelTransaction', cancel)).result;
  assert.equal(reversed.transactionState, 2);
  assert.deepEqual((await bridge.rpc('CancelTransaction', cancel)).result, reversed);
  assert.equal((await bridge.rpc('PerformTransaction', payment)).error.code, 202);
  assert.equal((await call('getCheckout', { id: 'order-41' })).state, 'reversed');
  assert.deepEqual((await bridge.rpc('GetStatement', period)).result.statements, []);
  assert.equal((await bridge.rpc('GetStatement', { ...period, dateFrom: '2026-02-31 13:00:00' })).error.code, 414);
});
