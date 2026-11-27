import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { deliverRow, prepare } from '../../runtime/connectors/engine.mjs';
import { loadDescriptor } from '../../tests/replay.mjs';
import { createBridge } from './server.mjs';

const type = process.env.CANOPY_TEST_DB_TYPE;
const token = 'local-data-integration-fixture';

test('database source reads the same bounded export through the real driver', { skip: !type }, async (t) => {
  assert.ok(['postgres', 'mysql', 'clickhouse', 'sqlserver', 'mongodb', 'redis'].includes(type));
  const redis = type === 'redis';
  const server = await createBridge({ token, datasets: { example: {
    type, connectionEnv: 'CANOPY_TEST_DB_DSN', ...(redis ? { key: 'export:rows' } : {
      relation: [type === 'sqlserver' ? 'dbo' : 'report', 'export_rows'],
      columns: ['id', 'label'], orderBy: ['id'],
    }),
  } } });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const descriptor = loadDescriptor(type + '-source');
  descriptor.base = 'http://127.0.0.1:' + server.address().port;
  const config = { dataset: 'example' };
  const expectedRows = redis ? [['First'], ['Second']] : [[type === 'mongodb' ? 2 : '2', 'First'], ['9007199254740993', 'Second']];
  for (const offset of [0, 1, 2]) {
    const rows = expectedRows.slice(offset, offset + 1);
    const { input } = prepare(descriptor, config, 'readPage', { limit: 1, offset });
    const result = await deliverRow(descriptor, { op: 'readPage', payload: input }, config, { secret: () => token });
    assert.equal(result.status, 'sent', result.error);
    const expected = { columns: redis ? ['value'] : ['id', 'label'], rows, hasMore: offset === 0 };
    assert.deepEqual(JSON.parse(result.result), { ...expected, rowsJson: JSON.stringify(rows) });
  }
});
