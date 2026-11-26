import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildRequest, deliverRow, prepare, secretSlots } from '../runtime/connectors/engine.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { checkToken, tokenRequest } from '../runtime/connectors/token.mjs';
import { noReplay } from '../runtime/settle.mjs';

const d = JSON.parse(fs.readFileSync(new URL('../connectors/bitrix24/descriptor.json', import.meta.url), 'utf8'));
const config = { portal: 'fixture.bitrix24.ru', userId: '42' };
const key = 'bitrix-only-test-token';
const secret = (name) => { assert.equal(name, 'webhookToken'); return key; };
const operations = [
  ['createContact', { name: 'Demo', phone: '+70000000000', email: 'demo@example.test' },
    'crm.contact.add', { fields: { NAME: 'Demo', PHONE: [{ VALUE: '+70000000000', VALUE_TYPE: 'WORK' }], EMAIL: [{ VALUE: 'demo@example.test', VALUE_TYPE: 'WORK' }] } },
    { result: 11 }, { id: 11 }],
  ['getContact', { id: '11' }, 'crm.contact.get', { id: '11' },
    { result: { ID: '11', NAME: key, PHONE: ['private value'] } }, { id: '11', name: '«secret»' }],
  ['createDeal', { title: 'Order 1', contactId: '11' }, 'crm.deal.add', { fields: { TITLE: 'Order 1', CONTACT_ID: '11' } }, { result: 12 }, { id: 12 }],
  ['updateDealStage', { id: '12', stage: 'WON' }, 'crm.deal.update', { id: '12', fields: { STAGE_ID: 'WON' } }, { result: true }, { updated: true }],
];

test('Bitrix24 calls expose only a masked outbox target and deny redirects', async () => {
  assert.deepEqual(checkDescriptor(d), []);
  assert.deepEqual(secretSlots(d), ['webhookToken']);
  for (const [op, input, method, request, reply, projected] of operations) {
    const safe = prepare(d, config, op, input);
    assert.equal(safe.target, `https://fixture.bitrix24.ru/rest/42/redacted/${method}.json`);
    const value = await deliverRow(d, { op, payload: safe.input }, config, {
      secret, fetchImpl: async (url, init) => {
        assert.equal(url, `https://fixture.bitrix24.ru/rest/42/${key}/${method}.json`);
        assert.equal(init.redirect, 'manual');
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), request);
        return Response.json(reply);
      },
    });
    assert.equal(value.status, 'sent');
    assert.deepEqual(JSON.parse(value.result), projected);
    assert.equal(value.response, undefined);
    const sandbox = await deliverRow(d, { op, payload: safe.input }, config, {
      mode: 'sandbox', fetchImpl: () => assert.fail('sandbox called a network endpoint'),
    });
    assert.equal(sandbox.status, 'sent');
  }
});

test('path credential is confined to the HTTPS origin, never leaks a failed request, and refuses write replay', async () => {
  const row = { kind: 'bitrix24', op: 'getContact', payload: { id: '12' } };
  const call = (fetchImpl, overrides = {}) => deliverRow(d, row, config, { secret, fetchImpl, ...overrides });
  const registry = { descriptors: { bitrix24: d } };
  assert.equal(noReplay(registry, row), false);
  assert.equal(noReplay(registry, { ...row, op: 'createDeal' }), true);
  assert.throws(() => buildRequest(d, config, row.op, row.payload, { secret: () => '../escape' }), /invalid path credential/);
  assert.throws(() => prepare({ ...d, base: 'http://fixture.bitrix24.ru' }, config, row.op, row.payload), /HTTPS target/);
  const otherOrigin = structuredClone(d);
  otherOrigin.operations.getContact.request.url = 'https://unrelated.example/rest/{secret.webhookToken}/get';
  assert.throws(() => buildRequest(otherOrigin, config, row.op, row.payload, { secret }), /declared origin/);
  await assert.rejects(call(async () => { throw new Error(`fetch failed at /${key}`); }),
    err => err.message === 'authorized provider request failed' && !Object.hasOwn(err, 'cause'));
  const denied = await call(async () => new Response(null, { status: 302, headers: { location: 'https://unrelated.example' } }));
  assert.equal(denied.status, 'failed');
  const malformed = structuredClone(d);
  malformed.operations.getContact.request.url = '{base}/get?token={secret.webhookToken}';
  assert.ok(checkDescriptor(malformed).some(([path]) => path.endsWith('/pathSecret')));
  delete malformed.operations.getContact.resultOnly;
  assert.ok(checkDescriptor(malformed).some(([, message]) => message.includes('requires resultOnly')));
  malformed.token = { url: 'https://fixture.bitrix24.ru/oauth', scheme: 'basic', clientId: 'id', clientSecret: 'key' };
  assert.ok(checkDescriptor(malformed).some(([, message]) => message.includes('cannot be combined')));
});

test('form token opt-in includes client_credentials without changing existing form providers', () => {
  const base = 'https://api.example.test';
  const form = { url: base + '/token', scheme: 'form', clientId: 'id', clientSecret: 'key', grantType: 'client_credentials' };
  assert.deepEqual(checkToken(form, base), []);
  assert.match(tokenRequest(form, name => name, 1000).body, /&grant_type=client_credentials$/);
  assert.doesNotMatch(tokenRequest({ ...form, grantType: undefined }, name => name, 1000).body, /grant_type/);
  assert.ok(checkToken({ ...form, scheme: 'basic' }, base).some(([path]) => path === '/token/grantType'));
});
