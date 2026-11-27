import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createBridge } from '../bridges/data-sources/server.mjs';
import { openSource } from '../bridges/data-sources/drivers.mjs';
import { deliverRow, prepare, synthesize } from '../runtime/connectors/engine.mjs';
import { loadDescriptor } from './replay.mjs';

const token = 'fixture-data-source-operator-token';
const spec = (type) => ({
  type, connectionEnv: 'FIXTURE_DB', relation: type === 'sqlite' ? ['export_rows'] : ['report', 'export_rows'],
  columns: ['id', 'label'], orderBy: ['id'],
});
async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((done) => server.close(done)));
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const request = (base, type, body, key = token) => fetch(base + '/' + type + '/read', {
  method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify(body),
});
const withJson = (value) => ({ ...value, rowsJson: JSON.stringify(value.rows) });

async function read(base, type, opts, mode = 'live') {
  const d = loadDescriptor(type + '-source');
  d.base = base;
  const cfg = { dataset: 'exported' };
  assert.deepEqual(synthesize(d).validate(cfg), []);
  const op = 'readPage';
  const prepared = prepare(d, cfg, op, opts);
  assert.equal(prepared.target, base + '/' + type + '/read');
  const row = { op, payload: prepared.input };
  const call = mode === 'sandbox' ? {
    mode, fetchImpl: () => assert.fail('sandbox contacted a database'), secret: () => assert.fail('sandbox read a secret'),
  } : { secret: (slot) => { assert.equal(slot, 'operatorToken'); return token; } };
  return deliverRow(d, row, cfg, call);
}

test('SQLite descriptor reads an external file with paging and lossless integer projection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-db-source-'));
  const file = join(dir, 'external.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE source(id INTEGER PRIMARY KEY, label TEXT, private TEXT);
    INSERT INTO source VALUES(2, 'First', 'private'), (9007199254740993, 'Second', 'private');
    CREATE VIEW export_rows AS SELECT id, label FROM source;`);
  db.close();
  const secure = await openSource('sqlite', file);
  assert.throws(() => secure.query("DELETE FROM source"), /readonly/);
  secure.close();
  const env = { FIXTURE_DB: file };
  const base = await listen(await createBridge({ token, datasets: { exported: spec('sqlite') }, env }), t);
  assert.equal((await read(base, 'sqlite', {}, 'sandbox')).status, 'sent');
  for (const [offset, expected] of [[0, [['2', 'First']]], [1, [['9007199254740993', 'Second']]], [2, []]]) {
    const delivered = await read(base, 'sqlite', { limit: 1, offset });
    assert.equal(delivered.status, 'sent');
    assert.equal(delivered.response, undefined);
    assert.deepEqual(JSON.parse(delivered.result), withJson({ columns: ['id', 'label'], rows: expected, hasMore: offset === 0 }));
  }
});

for (const type of ['postgres', 'mysql', 'clickhouse', 'sqlserver']) test(type + ' descriptor selects only configured columns', async (t) => {
  const sql = [], quote = type === 'postgres' ? '"' : '`';
  const open = async (kind, value) => {
    assert.equal(kind, type);
    assert.equal(value, 'not-exposed');
    return { query: (query) => { sql.push(query); return [{ id: '42', label: 'export', private: 'hidden' }]; }, close() {} };
  };
  const base = await listen(await createBridge({ token, datasets: { exported: spec(type) }, env: { FIXTURE_DB: 'not-exposed' }, open }), t);
  assert.equal((await read(base, type, {}, 'sandbox')).status, 'sent');
  const live = await read(base, type, { limit: 10, offset: 4 });
  assert.equal(live.status, 'sent');
  assert.equal(live.response, undefined);
  assert.deepEqual(JSON.parse(live.result), withJson({ columns: ['id', 'label'], rows: [['42', 'export']], hasMore: false }));
  const q = (id) => type === 'sqlserver' ? '[' + id + ']' : quote + id + quote;
  const slice = type === 'sqlserver' ? 'OFFSET 4 ROWS FETCH NEXT 11 ROWS ONLY' : 'LIMIT 11 OFFSET 4';
  assert.deepEqual(sql, [`SELECT ${q('id')}, ${q('label')} FROM ${q('report')}.${q('export_rows')} ORDER BY ${q('id')} ${slice}`]);
});

for (const type of ['mongodb', 'redis']) test(type + ' uses only the registered resource and page', async (t) => {
  const definition = type === 'redis'
    ? { type, connectionEnv: 'FIXTURE_DB', key: 'exports:orders' } : spec(type);
  const columns = type === 'redis' ? ['value'] : ['id', 'label'];
  const rows = type === 'redis' ? [['record']] : [['42', 'record']];
  const calls = [];
  const open = async () => ({
    readPage: (...args) => {
      calls.push(args);
      return [Object.fromEntries(columns.map((key, index) => [key, rows[0][index]]))];
    },
    close() {},
  });
  const base = await listen(await createBridge({ token, datasets: { exported: definition }, env: { FIXTURE_DB: 'fixture' }, open }), t);
  assert.equal((await read(base, type, {}, 'sandbox')).status, 'sent');
  const input = { dataset: 'exported', limit: 2, offset: 1 };
  for (const extra of [{ key: 'other' }, { filter: {} }, { collection: 'other' }, { command: 'LRANGE' }])
    assert.equal((await request(base, type, { ...input, ...extra })).status, 400);
  assert.equal(calls.length, 0);
  const live = await read(base, type, { limit: 2, offset: 1 });
  assert.equal(live.status, 'sent');
  assert.deepEqual(JSON.parse(live.result), withJson({ columns, rows, hasMore: false }));
  assert.deepEqual(calls, [[{ ...definition, columns }, 2, 1]]);
});

test('document drivers reject plaintext remote endpoints and TLS certificate bypasses', async () => {
  await assert.rejects(openSource('mongodb', 'mongodb://example.test/report?tls=false'), /TLS/);
  await assert.rejects(openSource('mongodb', 'mongodb://localhost,example.test/report?tls=false'), /TLS/);
  await assert.rejects(openSource('mongodb', 'mongodb://localhost/report?tlsAllowInvalidCertificates=true'), /options/);
  await assert.rejects(openSource('redis', 'redis://example.test/0'), /connection/);
  await assert.rejects(openSource('redis', 'rediss://example.test/0?tls=false'), /connection/);
  await assert.rejects(openSource('sqlserver', 'sqlserver://reader:fixture@example.test/report?tls=off'), /connection/);
});

test('bridge rejects unregistered datasets, raw SQL and overlong replies', async (t) => {
  let count = 0;
  const open = async () => ({ query: () => { count++; return [{ id: '1', label: 'X'.repeat(4097) }]; }, close() {} });
  const settings = { token, env: { FIXTURE_DB: 'not-exposed' }, open };
  await assert.rejects(createBridge({ ...settings, datasets: { exported: { ...spec('postgres'), relation: ['report', 'bad.sql'] } } }), /definition/);
  const base = await listen(await createBridge({ ...settings, datasets: { exported: spec('postgres') } }), t);
  const good = { dataset: 'exported', limit: 10, offset: 0 };
  assert.equal((await request(base, 'postgres', good, 'wrong')).status, 401);
  assert.equal((await request(base, 'postgres', { ...good, dataset: 'other' })).status, 404);
  assert.equal((await request(base, 'mysql', good)).status, 404);
  assert.equal((await request(base, 'postgres', { ...good, limit: 51 })).status, 400);
  assert.equal((await request(base, 'postgres', { ...good, sql: 'SELECT invalid' })).status, 400);
  assert.equal(count, 0);
  const response = await request(base, 'postgres', good);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'provider request failed' });
  assert.equal(count, 1);
});

test('one connection serves only one in-flight query even across dataset aliases', async (t) => {
  const begin = Promise.withResolvers(), result = Promise.withResolvers();
  let opens = 0, calls = 0;
  const open = async () => { opens++; return { query: () => { calls++; begin.resolve(); return result.promise; }, close() {} }; };
  const base = await listen(await createBridge({ token, datasets: { exported: spec('postgres'), other: spec('postgres') },
    env: { FIXTURE_DB: 'fixture' }, open }), t);
  const pending = request(base, 'postgres', { dataset: 'exported', limit: 10, offset: 0 });
  try {
    await begin.promise;
    assert.equal((await request(base, 'postgres', { dataset: 'other', limit: 10, offset: 0 })).status, 429);
    assert.equal(opens, 1);
    assert.equal(calls, 1);
  } finally { result.resolve([]); }
  assert.equal((await pending).status, 200);
});
