// The Driver contract (runtime/driver/sqlite.mjs) on its own, and a Store handed a driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../runtime/driver.mjs';
import { openSqlite, CACHE_MAX } from '../runtime/driver/sqlite.mjs';
import { sqlite as dialect } from '../runtime/driver/dialects.mjs';
import { Store } from '../runtime/store.mjs';

const fresh = () => {
  const drv = openSqlite(':memory:');
  drv.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER)');
  return drv;
};

test('all/get/run: rows, a missing row, changes and the id of the row a run inserted', () => {
  const drv = fresh();
  assert.equal(drv.run('INSERT INTO t (n) VALUES (?)', [10]).lastId, 1);
  assert.deepEqual(drv.run('INSERT INTO t (n) VALUES (?)', [20]), { changes: 1, lastId: 2 });
  assert.equal(drv.run('UPDATE t SET n=n+1').changes, 2, 'params are optional');
  assert.deepEqual(drv.all('SELECT n FROM t ORDER BY id').map((r) => r.n), [11, 21]);
  assert.equal(drv.get('SELECT n FROM t WHERE id=?', [2]).n, 21);
  assert.equal(drv.get('SELECT n FROM t WHERE id=?', [99]), undefined);
  assert.equal(drv.run('DELETE FROM t WHERE id=?', [1]).changes, 1);
  assert.equal(drv.get('SELECT $x AS x', [{ $x: 7 }]).x, 7, 'a named-parameter object is bound too');
});

test('transaction commits on return and rolls back on a throw, rethrowing the error', () => {
  const drv = fresh();
  assert.equal(drv.transaction(() => { drv.run('INSERT INTO t (n) VALUES (1)'); return 'ok'; }), 'ok');
  assert.throws(() => drv.transaction(() => { drv.run('INSERT INTO t (n) VALUES (2)'); throw new Error('stop'); }), /stop/);
  assert.deepEqual(drv.all('SELECT n FROM t').map((r) => r.n), [1], 'the failed transaction left nothing behind');
  drv.transaction(() => { drv.run('INSERT INTO t (n) VALUES (3)'); });
  assert.equal(drv.all('SELECT n FROM t').length, 2, 'and the driver is usable after a rollback');
});

test('the statement cache reuses one statement per SQL text and is bounded, least recently used out first', () => {
  const drv = fresh();
  const sql = 'SELECT 1 AS one';
  drv.get(sql);
  const first = drv.cache.get(sql);
  drv.get(sql);
  assert.equal(drv.cache.get(sql), first, 'the same statement object is reused');
  for (let i = 0; i < CACHE_MAX - 1; i++) drv.get(`SELECT ${i} AS n`);
  assert.equal(drv.cache.size, CACHE_MAX);
  drv.get(sql); // touch: `sql` is now the most recent, `SELECT 0` the oldest
  drv.get('SELECT -1 AS n');
  assert.equal(drv.cache.size, CACHE_MAX, 'one in, one out');
  assert.ok(drv.cache.has(sql), 'a recently used statement survives');
  assert.ok(!drv.cache.has('SELECT 0 AS n'), 'the least recently used one was evicted');
  for (let i = 0; i < 250; i++) drv.get(`SELECT ${i} + 1000 AS n`);
  assert.ok(drv.cache.size <= CACHE_MAX, `cache grew to ${drv.cache.size}`);
});

test('{ cache: false } neither reads nor fills the cache', () => {
  const drv = fresh();
  drv.all('SELECT 5 AS n', [], { cache: false });
  assert.equal(drv.cache.size, 0);
});

test('onQuery sees every statement, cached or not, exec included', () => {
  const drv = fresh();
  const seen = [];
  drv.onQuery = (sql) => seen.push(sql);
  drv.get('SELECT 1');
  drv.get('SELECT 1');
  drv.all('SELECT 2', [], { cache: false });
  drv.run('INSERT INTO t (n) VALUES (1)');
  drv.exec('DELETE FROM t');
  assert.deepEqual(seen, ['SELECT 1', 'SELECT 1', 'SELECT 2', 'INSERT INTO t (n) VALUES (1)', 'DELETE FROM t']);
  const opts = [];
  drv.onQuery = (sql, o) => opts.push(o);
  drv.all('SELECT 3', [], { cache: false });
  assert.deepEqual(opts, [{ cache: false }], 'the hook is told how the call asked to be run');
});

test('schema helpers: tables, columns, indexes (with a literal prefix), DDL', () => {
  const drv = openSqlite(':memory:');
  drv.createTable('a', [['x', 'TEXT'], ['we"ird', 'INTEGER DEFAULT 0']]);
  drv.createTable('s', [['id', 'TEXT PRIMARY KEY']], { serial: false });
  drv.createTable('s', [['id', 'TEXT PRIMARY KEY']], { serial: false, ifNotExists: true });
  assert.throws(() => drv.createTable('s', [['id', 'TEXT']], { serial: false }), /already exists/);
  assert.deepEqual(drv.tables().sort(), ['a', 's', 'sqlite_sequence'].sort());
  assert.deepEqual(drv.columns('a'), [{ name: 'id', type: 'INTEGER' }, { name: 'x', type: 'TEXT' }, { name: 'we"ird', type: 'INTEGER' }]);
  drv.addColumn('a', 'y', 'TEXT');
  assert.ok(drv.columns('a').some((c) => c.name === 'y'));
  drv.createIndex('idx_a_x', 'a', ['x']);
  drv.createIndex('idx_a_x', 'a', ['x']);
  drv.createIndex('idxXa_y', 'a', ['y', 'x']);
  assert.deepEqual(drv.indexes('a', 'idx_'), ['idx_a_x'], 'the underscore in a prefix is literal, not a wildcard');
  assert.deepEqual(drv.indexes('a').sort(), ['idxXa_y', 'idx_a_x']);
  drv.dropIndex('idx_a_x');
  drv.dropIndex('idx_a_x');
  assert.deepEqual(drv.indexes('a'), ['idxXa_y']);
  assert.equal(dialect.name, 'sqlite');
  assert.equal(dialect.quote('a"b'), '"a""b"');
  assert.equal(drv.dialect, dialect);
  drv.close();
  assert.throws(() => drv.get('SELECT 1'), /not open/);
});

test('open(): a path opens SQLite, a driver object is used as it is; a Store runs on either', async () => {
  const drv = open(':memory:');
  assert.equal(open(drv), drv);
  const graph = { app: 'd', data: { Note: { body: 'text!' } } };
  const store = new Store(graph, 'ignored when a driver is given', undefined, drv);
  assert.equal(store.drv, drv);
  const id = await store.insert('Note', { body: 'hi' });
  assert.equal(drv.get('SELECT body FROM note WHERE id=?', [id]).body, 'hi');
  assert.deepEqual(drv.columns('note').map((c) => c.name), ['id', 'body']);
  assert.ok(drv.tables().includes('_outbox') && drv.tables().includes('_session'));
});
