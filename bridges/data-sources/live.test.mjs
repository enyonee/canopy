import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { deliverRow, prepare } from '../../runtime/connectors/engine.mjs';
import { loadDescriptor } from '../../tests/replay.mjs';
import { createBridge } from './server.mjs';
import { updateTypes } from './contracts.mjs';

const type = process.env.CANOPY_TEST_DB_TYPE;
const token = 'local-data-integration-fixture';
const writeToken = 'local-data-integration-writer';
const writer = process.env.CANOPY_TEST_DB_WRITE_DSN;

async function connect(t, type, spec, readOnly = true) {
  const server = await createBridge({ token, writeToken, datasets: { example: {
    type, connectionEnv: 'CANOPY_TEST_DB_DSN', ...spec,
  } } });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const descriptor = loadDescriptor(type + '-source');
  descriptor.base = 'http://127.0.0.1:' + server.address().port;
  const config = { dataset: 'example' };
  return async (op, data) => {
    const { input } = prepare(descriptor, config, op, data);
    const result = await deliverRow(descriptor, { op, payload: input }, config, { secret: (slot) => {
      assert.equal(slot, op === 'readPage' ? 'operatorToken' : 'writeToken');
      assert.ok(!readOnly || slot === 'operatorToken');
      return slot === 'operatorToken' ? token : writeToken;
    } });
    assert.equal(result.status, 'sent', result.error);
    return JSON.parse(result.result);
  };
}

test('database source reads the same bounded export through the real driver', { skip: !type }, async (t) => {
  assert.ok(['postgres', 'mysql', 'clickhouse', 'sqlserver', 'mongodb', 'redis'].includes(type));
  const redis = type === 'redis';
  const call = await connect(t, type, redis ? { key: 'export:rows' } : {
      relation: [type === 'sqlserver' ? 'dbo' : 'report', 'export_rows'],
      columns: ['id', 'label'], orderBy: ['id'],
  });
  const expectedRows = redis ? [['First'], ['Second']] : [[type === 'mongodb' ? 2 : '2', 'First'], ['9007199254740993', 'Second']];
  for (const offset of [0, 1, 2]) {
    const rows = expectedRows.slice(offset, offset + 1);
    const result = await call('readPage', { limit: 1, offset });
    const expected = { columns: redis ? ['value'] : ['id', 'label'], rows, hasMore: offset === 0 };
    assert.deepEqual(result, { ...expected, rowsJson: JSON.stringify(rows) });
  }
});

test('real write credential stores exactly the requested record and leaves existing rows in place', { skip: !writer || !type }, async (t) => {
  const redis = type === 'redis', mongo = type === 'mongodb', update = updateTypes.includes(type);
  const field = mongo ? '_id' : 'id';
  const columns = [field, 'label'];
  const spec = redis ? { key: 'export:rows', write: { connectionEnv: 'CANOPY_TEST_DB_WRITE_DSN' } } : {
    relation: [type === 'sqlserver' ? 'dbo' : 'report', mongo ? 'write_rows' : 'export_rows'],
    columns, orderBy: [field], write: { connectionEnv: 'CANOPY_TEST_DB_WRITE_DSN', columns, ...(update && { key: field }) },
  };
  const call = await connect(t, type, spec, false);
  const label = "literal '; value";
  const id = mongo ? 'source-3' : 3;
  assert.deepEqual(await call(redis ? 'appendValue' : 'insertRow', redis ? { value: label } : { values: { [field]: id, label } }), { affected: 1 });
  if (update) {
    assert.deepEqual(await call('updateRow', { key: id, values: { label: 'Updated' } }), { affected: 1 });
    assert.deepEqual(await call('updateRow', { key: mongo ? 'missing' : 9, values: { label: 'Do not create' } }), { affected: 0 });
  }
  const { rows } = await call('readPage', {});
  if (redis) assert.deepEqual(rows, [['First'], ['Second'], [label]]);
  else if (mongo) assert.deepEqual(rows, [['source-3', 'Updated']]);
  else assert.deepEqual(rows, [['2', 'First'], ['3', update ? 'Updated' : label], ['9007199254740993', 'Second']]);
});
