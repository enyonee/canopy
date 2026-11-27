import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createBridge } from '../bridges/data-sources/server.mjs';
import { types, updateTypes } from '../bridges/data-sources/contracts.mjs';
import { asyncTransaction, sqlWriter } from '../bridges/data-sources/sql-write.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';
import { loadDescriptor } from './replay.mjs';

const token = 'read-only-fixture-token-value';
const writeToken = 'write-only-fixture-token-value';
const relation = (type) => type === 'sqlite' ? ['export_rows'] : ['report', 'export_rows'];
const spec = (type) => type === 'redis'
  ? { type, connectionEnv: 'READ_DSN', key: 'export:rows', write: { connectionEnv: 'WRITE_DSN' } }
  : { type, connectionEnv: 'READ_DSN', relation: relation(type), columns: [type === 'mongodb' ? '_id' : 'id', 'label'],
    orderBy: [type === 'mongodb' ? '_id' : 'id'], write: { connectionEnv: 'WRITE_DSN',
      columns: [type === 'mongodb' ? '_id' : 'id', 'label'], ...(updateTypes.includes(type) && { key: type === 'mongodb' ? '_id' : 'id' }) } };

async function start(t, settings) {
  const server = await createBridge({ token, writeToken, ...settings });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((done) => server.close(done)));
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function send(base, type, action, body, credential) {
  return fetch(base + '/' + type + '/' + action, {
    method: 'POST', headers: { authorization: 'Bearer ' + credential },
    body: JSON.stringify({ dataset: 'exported', ...body }),
  });
}

test('all database descriptors expose only the configured write, with an offline sandbox and no replay', async (t) => {
  const observed = [];
  const base = await start(t, { datasets: Object.fromEntries(types.map((type) => [type, spec(type)])),
    env: { READ_DSN: 'reader', WRITE_DSN: 'writer' }, open: async (type, dsn, writable) => {
      assert.equal(dsn, writable ? 'writer' : 'reader');
      return { close() {}, write: async (bound, op, input) => { assert.equal(bound.type, type); assert.equal(writable, true);
        observed.push([type, op, input]); return 1; } };
    } });
  const wanted = [];
  for (const type of types) {
    const descriptor = loadDescriptor(type + '-source'), cfg = { dataset: type };
    descriptor.base = base;
    const mongo = type === 'mongodb';
    const data = { [mongo ? '_id' : 'id']: mongo ? 'sample' : 1, label: "'quoted ; data" };
    const actions = type === 'redis' ? [['appendValue', 'append', { value: 'example' }, { value: 'example' }]]
      : [['insertRow', 'insert', { values: data }, { values: Object.entries(data) }]];
    if (updateTypes.includes(type)) actions.push(['updateRow', 'update', { key: mongo ? 'sample' : 1, values: { label: 'new' } },
      { key: mongo ? 'sample' : 1, values: [['label', 'new']] }]);
    assert.deepEqual(Object.keys(descriptor.operations).sort(), ['readPage', ...actions.map(([op]) => op)].sort());
    for (const [op, action, params, input] of actions) {
      const row = { kind: descriptor.name, op, payload: prepare(descriptor, cfg, op, params).input };
      assert.equal(noReplay({ descriptors: { [descriptor.name]: descriptor } }, row), true);
      assert.equal(descriptor.operations[op].idempotent, false);
      const offline = await deliverRow(descriptor, row, cfg, { mode: 'sandbox',
        secret: () => assert.fail('sandbox read a secret'), fetchImpl: () => assert.fail('sandbox called the bridge') });
      assert.deepEqual(JSON.parse(offline.result), { affected: 1 });
      const live = await deliverRow(descriptor, row, cfg, { secret: (slot) => {
        assert.equal(slot, 'writeToken'); return writeToken;
      } });
      assert.deepEqual(JSON.parse(live.result), { affected: 1 });
      assert.equal(live.response, undefined);
      wanted.push([type, action, input]);
    }
  }
  assert.deepEqual(observed, wanted);
});

test('write scope cannot be used by a reader or bypass the dataset and column rules', async (t) => {
  const source = spec('sqlite');
  const readOnly = { ...source };
  delete readOnly.write;
  const settings = { token, datasets: { exported: source, disabled: readOnly },
    env: { READ_DSN: 'reader', WRITE_DSN: 'writer' }, open: async () => ({ close() {}, write: () => assert.fail('called') }) };
  await assert.rejects(createBridge(settings), /distinct write token/);
  await assert.rejects(createBridge({ ...settings, writeToken: token }), /distinct write token/);
  const base = await start(t, settings);
  const data = { values: { id: 1, label: 'value' } };
  assert.equal((await send(base, 'sqlite', 'insert', data, token)).status, 401);
  assert.equal((await send(base, 'sqlite', 'read', { limit: 1, offset: 0 }, writeToken)).status, 401);
  assert.equal((await send(base, 'sqlite', 'insert', { ...data, dataset: 'disabled' }, writeToken)).status, 404);
  assert.equal((await send(base, 'postgres', 'insert', data, writeToken)).status, 404);
  for (const body of [{ ...data, table: 'other' }, { values: { secret: 'x' } }, { values: { label: {} } },
    { values: { label: 'a'.repeat(4097) } }, { values: {} }])
    assert.equal((await send(base, 'sqlite', 'insert', body, writeToken)).status, 400);
  for (const key of [null, '', {}])
    assert.equal((await send(base, 'sqlite', 'update', { key, values: { label: 'x' } }, writeToken)).status, 400);
  assert.equal((await send(base, 'sqlite', 'update', { key: 1, values: { id: 3 } }, writeToken)).status, 400);
});

test('real SQLite writes bind values and roll back an update matching multiple rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-db-writes-'));
  const path = join(dir, 'data.sqlite');
  t.after(() => rm(dir, { force: true, recursive: true }));
  const fixture = new DatabaseSync(path);
  fixture.exec("CREATE TABLE export_rows (id INTEGER NOT NULL, label TEXT); INSERT INTO export_rows VALUES (2, 'a'), (2, 'b');");
  fixture.close();
  const base = await start(t, { datasets: { exported: spec('sqlite') }, env: { READ_DSN: path, WRITE_DSN: path } });
  const write = (action, body) => send(base, 'sqlite', action, body, writeToken);
  const label = "literal '; SELECT example";
  assert.deepEqual(await (await write('insert', { values: { id: 1, label } })).json(), { affected: 1 });
  assert.deepEqual(await (await write('update', { key: 1, values: { label: label + ' updated' } })).json(), { affected: 1 });
  assert.deepEqual(await (await write('update', { key: 99, values: { label: 'missing' } })).json(), { affected: 0 });
  const failed = await write('update', { key: 2, values: { label: 'do not commit' } });
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: 'provider request failed' });
  const after = await (await send(base, 'sqlite', 'read', { limit: 10, offset: 0 }, token)).json();
  assert.deepEqual(after.rows, [['1', label + ' updated'], ['2', 'a'], ['2', 'b']]);
});

test('SQL Server write statements bind named parameters and reject an ambiguous row count before commit', async () => {
  const target = { ...spec('sqlserver'), relation: ['dbo', 'export_rows'] };
  const label = "literal ' text", events = [];
  let rows = 1;
  const write = sqlWriter((work) => asyncTransaction(work, () => events.push('begin'),
    (sql, bindings) => { events.push([sql, bindings]); return rows; },
    () => events.push('commit'), () => events.push('rollback')));
  assert.equal(await write(target, 'insert', { values: [['id', 3], ['label', label]] }), 1);
  rows = 2;
  await assert.rejects(write(target, 'update', { values: [['label', label]], key: 3 }), /row count/);
  assert.deepEqual(events, [
    'begin',
    ['INSERT INTO [dbo].[export_rows] ([id], [label]) VALUES (@p0, @p1)', [3, label]],
    'commit',
    'begin',
    ['UPDATE [dbo].[export_rows] SET [label] = @p0 WHERE [id] = @p1', [label, 3]],
    'rollback',
  ]);
});
