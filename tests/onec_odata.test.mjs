import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { deliverRow, prepare, synthesize } from '../runtime/connectors/engine.mjs';
import { loadDescriptor } from './replay.mjs';

const descriptor = loadDescriptor('onec-odata');
const base = 'https://erp.example.test:8443/publication/odata/standard.odata/';
const config = { host: 'erp.example.test:8443', publication: 'publication', catalog: '\u0422\u043e\u0432\u0430\u0440\u044b', document: '\u0417\u0430\u043a\u0430\u0437' };
const id = '01234567-89ab-4cde-8f01-23456789abcd';
const catalog = { Ref_Key: id, Description: 'Demo item' };
const doc = { Ref_Key: id, Number: '0000041', Date: '2026-11-01T09:30:00' };
const catalogFields = '?$format=json&$select=Ref_Key,Description';
const docFields = '?$format=json&$select=Ref_Key,Number,Date';
const pathId = "(guid'" + id + "')";
const cases = [
  ['listCatalog', {}, 'Catalog_' + config.catalog + catalogFields + '&$top=20&$skip=0&$orderby=Ref_Key', { value: [catalog] }, { rows: [catalog] }],
  ['getCatalogItem', { id }, 'Catalog_' + config.catalog + pathId + catalogFields, catalog, { id, description: catalog.Description }],
  ['listDocuments', { limit: 10, offset: 20 }, 'Document_' + config.document + docFields + '&$top=10&$skip=20&$orderby=Ref_Key',
    { value: [doc] }, { rows: [doc] }],
  ['getDocument', { id }, 'Document_' + config.document + pathId + docFields, doc, { id, number: doc.Number, date: doc.Date }],
];

test('1C OData reads only selected fields, with bounded pages and a restricted HTTP credential', async () => {
  assert.deepEqual(checkDescriptor(descriptor), []);
  assert.deepEqual(synthesize(descriptor).validate(config), []);
  assert.deepEqual(Object.keys(descriptor.operations).sort(), cases.map(([op]) => op).sort());
  for (const [op, data, path, reply, result] of cases) {
    const { target, input } = prepare(descriptor, config, op, data);
    const row = { op, payload: input };
    assert.equal(target, base + path);
    const sandbox = await deliverRow(descriptor, row, config, {
      mode: 'sandbox', secret: () => assert.fail('sandbox read a secret'),
      fetchImpl: () => assert.fail('sandbox contacted OData'),
    });
    assert.equal(sandbox.status, 'sent');
    const live = await deliverRow(descriptor, row, config, {
      secret: (slot) => 'fixture-' + slot,
      fetchImpl: async (url, init) => {
        assert.equal(url, base + path);
        assert.equal(decodeURI(new URL(url).pathname), '/publication/odata/standard.odata/' + path.split('?')[0]);
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.authorization, 'Basic fixture-basicCredential');
        assert.equal(init.redirect, 'manual');
        return Response.json({ ...reply, 'odata.metadata': base + '$metadata' });
      },
    });
    assert.equal(live.status, 'sent');
    assert.deepEqual(JSON.parse(live.result), result);
    assert.equal(live.response, undefined);
  }
});

test('1C rejects malformed config, invalid keys and overbroad list replies', async () => {
  const checks = synthesize(descriptor).validate({ ...config, host: 'erp.example.test@untrusted.test', catalog: '../Catalog' });
  assert.equal(checks.length, 2);
  assert.throws(() => prepare(descriptor, config, 'getDocument', { id: 'anything/else' }), /id/);
  const { input } = prepare(descriptor, config, 'listCatalog', {});
  const denied = await deliverRow(descriptor, { op: 'listCatalog', payload: input }, config, {
    secret: () => 'fixture',
    fetchImpl: async () => Response.json({ value: [{ ...catalog, privateField: 'credential' }] }),
  });
  assert.equal(denied.status, 'failed');
  assert.equal(denied.response, undefined);
  assert.equal(denied.result, undefined);
});
