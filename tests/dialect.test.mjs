// S2: the SQL text every store builder produces, per dialect. SQLite runs for real (the
// text is what the driver was handed); PostgreSQL is generated against a recording driver
// with no server — the same Store, the same calls, a different `dialect`. The expected
// text is tests/golden/dialect.<name>.sql, one statement per line; a deliberate change
// regenerates it with UPDATE_GOLDEN=1 and the diff is what a reviewer reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../runtime/store.mjs';
import { parse } from '../runtime/expr.mjs';
import { compileAgg, runAggOne, runAggBatch } from '../runtime/store/aggsql.mjs';
import { openSqlite } from '../runtime/driver/sqlite.mjs';
import { sqlite, postgres } from '../runtime/driver/dialects.mjs';

const GRAPH = {
  app: 'dialect',
  data: {
    Customer: { name: 'text!', email: 'text' },
    Order: {
      title: 'text!', status: 'enum[new,paid]', total: 'money', qty: 'int', placed: 'date', seen: 'time',
      customer: 'ref:Customer', done: 'bool=false',
    },
    Item: { order: 'ref:Order!', qty: 'int=1', price: 'money=1', ok: 'bool=false', due: 'date', disc: 'money' },
    Blank: { n: 'int := 1' },
  },
  rules: { Order: [{ unique: ['title', 'status'] }] },
  states: { Order: { field: 'status' } },
};

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

// Every $n of a statement is bound: the numbering the dialect emitted matches the values passed.
function checkBound(sql, params) {
  const nums = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  assert.deepEqual(nums, params.map((_, i) => i + 1), `placeholders of ${flat(sql)} do not match ${params.length} bound value(s)`);
}

// A driver that records instead of executing: what the store would send to PostgreSQL.
// It keeps a catalog that cuts identifiers at 63 bytes as the engine does, so a second
// Store over the same catalog behaves like a restart of the process.
function recorder(dialect, catalog = { tables: new Set(), cols: new Map(), idx: new Map() }) {
  const log = [];
  const rec = (sql, params) => { if (params && dialect === postgres) checkBound(sql, params); log.push(flat(sql)); };
  const cut = (n) => Buffer.from(n).subarray(0, 63).toString();
  return {
    dialect, log, catalog, onQuery: null,
    all: (sql, params = []) => { rec(sql, params); return []; },
    get: (sql, params = []) => { rec(sql, params); return sql.startsWith('SELECT id') ? undefined : { n: 0, v: 0, c: 0, id: 1, user: 1 }; },
    run: (sql, params = []) => { rec(sql, params); return { changes: 1, lastId: 1 }; },
    exec: (sql) => rec(sql), transaction: (fn) => fn(), close() {},
    tables: () => [...catalog.tables],
    columns: (t) => (catalog.cols.get(t) || []).map((name) => ({ name, type: '' })),
    indexes: (t, prefix = '') => [...(catalog.idx.get(t) || [])].filter((n) => n.startsWith(prefix)),
    createTable(t, c, o) {
      rec(dialect.createTable(t, c, o));
      catalog.tables.add(t);
      catalog.cols.set(t, [...(o?.serial === false ? [] : ['id']), ...c.map(([n]) => n)]);
    },
    addColumn(t, n, ty) { rec(dialect.addColumn(t, n, ty)); catalog.cols.get(t).push(n); },
    createIndex(n, t, c) { rec(dialect.createIndex(n, t, c)); catalog.idx.set(t, new Set([...(catalog.idx.get(t) || []), cut(n)])); },
    dropIndex(n) { rec(dialect.dropIndex(n)); for (const set of catalog.idx.values()) set.delete(cut(n)); },
  };
}

// Every builder shape once. Returns the statements in order.
function scenario(store, log) {
  const at = (label) => log.push(`-- ${label}`);
  at('write');
  const id = store.insert('Order', { title: 'a', status: 'new' });
  store.insert('Blank', {});
  store.update('Order', id, { title: 'b', total: 5 });
  store.remove('Order', id);
  store.raw('Order', id);
  store.exists('Customer', 'name', 'Ann', 1);
  store.exists('Order', 'qty', 3);
  store.existsAll('Order', ['title', 'status'], { title: 'a', status: 'new' }, 2);
  store.count('Order', { qty: { gte: 2 } });
  at('read');
  const where = { status: 'paid', qty: { gte: 1, lte: 9, gt: 0, lt: 10, ne: 4, in: [1, 2] }, customer: null, seen: { ne: null }, title: { like: '50%_x' } };
  store.listRaw('Order', { where, q: 'Bo\\b', search: ['title', 'status'], sort: { field: 'title', dir: 'asc' } });
  store.listRaw('Order', { sort: { field: 'total', dir: 'desc' } });
  store.listRaw('Order');
  store.listRawPage('Order', { where: { qty: 3 }, sort: { field: 'placed', dir: 'desc' } }, 50, 100);
  store.countRaw('Order', { where: { done: 1 } });
  store.listRawIn('Item', 'order', [1, 2, 3]);
  at('aggregate');
  store.aggregate('Order', { groupBy: 'placed', groupUnit: 'month', metrics: [{ fn: 'sum', field: 'total', as: 'sum_total' }, { fn: 'count', as: 'n' }], sort: { field: 'grp', dir: 'asc' }, limit: 5, where: { status: 'paid' } });
  store.aggregate('Order', { groupBy: 'status', metrics: [{ fn: 'avg', field: 'qty', as: 'a' }], sort: { field: 'a', dir: 'desc' } });
  store.aggregate('Order', { groupBy: 'qty', metrics: [{ fn: 'max', field: 'qty', as: 'm' }], sort: { field: 'grp', dir: 'desc' } });
  store.aggregate('Order', { groupBy: 'seen', groupUnit: 'year', metrics: [{ fn: 'min', field: 'total', as: 'm' }], sort: { field: 'grp', dir: 'asc' } });
  store.aggregate('Order', { groupBy: 'placed', groupUnit: 'day', metrics: [{ fn: 'count', as: 'n' }] });
  at('compiled aggregates');
  const one = compileAgg(store, 'Order', parse('sum(Item: if(ok and not(qty > 1) or price != disc, qty * price, 0) + qty)'));
  runAggOne(store, one, 7, new Date('2026-01-02T03:04:05Z'));
  runAggBatch(store, one, [7, 8], new Date('2026-01-02T03:04:05Z'));
  const cond = compileAgg(store, 'Order', parse("count(Item: due >= today and ok and due < now and price = 2 and qty != 1)"));
  runAggOne(store, cond, 7, new Date('2026-01-02T03:04:05Z'));
  runAggBatch(store, cond, [7], new Date('2026-01-02T03:04:05Z'));
  const nested = compileAgg(store, 'Customer', parse('sum(Order: total + count(Item: ok))'));
  runAggOne(store, nested, 1);
  at('outbox and sessions');
  store.enqueue({ kind: 'http', connector: 'c', target: 't', payload: { a: 1 } });
  store.outbox({ status: 'queued', id: 3 });
  store.outboxDue(1000, 500);
  store.outboxClaim(3, 1000, 500);
  store.outboxUpdate(3, { status: 'failed', error: 'x' });
  store.outboxFinish(3, 1000, { status: 'sent', code: 200 });
  store.sessionSet('sid', 4);
  store.sessionUser('sid');
  store.sessionEnd('sid');
}

const GOLDEN = (name) => new URL(`./golden/dialect.${name}.sql`, import.meta.url);

function statements(dialect) {
  let drv;
  if (dialect === sqlite) {
    drv = openSqlite(':memory:');
    drv.log = [];
    drv.onQuery = (sql) => drv.log.push(flat(sql));
  } else drv = recorder(dialect);
  const store = new Store(GRAPH, ':memory:', undefined, drv);
  scenario(store, drv.log);
  return `${drv.log.join('\n')}\n`;
}

for (const dialect of [sqlite, postgres]) {
  test(`golden SQL: every builder shape, ${dialect.name}`, () => {
    const got = statements(dialect);
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN(dialect.name), got);
    assert.equal(got, fs.readFileSync(GOLDEN(dialect.name), 'utf8'));
  });
}

test('placeholders, quoting and column types per dialect', () => {
  assert.deepEqual([sqlite.ph(3), postgres.ph(3)], ['?', '$3']);
  assert.equal(sqlite.phs(3), '?,?,?');
  assert.equal(postgres.phs(3), '$1,$2,$3');
  assert.equal(postgres.phs(2, 4), '$4,$5', 'a list can start after earlier parameters');
  for (const d of [sqlite, postgres]) assert.equal(d.quote('a"b'), '"a""b"', 'a quote inside an identifier is doubled');
  assert.equal(sqlite.colType('INTEGER DEFAULT 0'), 'INTEGER DEFAULT 0');
  assert.equal(postgres.colType('INTEGER DEFAULT 0'), 'BIGINT DEFAULT 0', 'int, bool and money never fit int4');
  assert.equal(postgres.colType('TEXT'), 'TEXT');
  assert.equal(sqlite.createTable('t', [], {}), 'CREATE TABLE "t" (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  assert.equal(postgres.createTable('t', [['a', 'TEXT']], { serial: false, ifNotExists: true }), 'CREATE TABLE IF NOT EXISTS "t" ("a" TEXT)');
  assert.equal(postgres.insert('t', ['a']), 'INSERT INTO "t" ("a") VALUES ($1) RETURNING id');
  assert.equal(sqlite.insert('t', []), 'INSERT INTO "t" DEFAULT VALUES');
});

test('LIKE: what the user typed is what is searched for, on both dialects', () => {
  for (const d of [sqlite, postgres]) {
    assert.equal(d.likeArg('50%_a\\B'), '%50\\%\\_a\\\\b%', 'wildcards and the escape itself are escaped, the text lower-cased');
    assert.equal(d.escapeLike('idx_'), 'idx\\_');
    assert.equal(d.like('"c"', d.ph(2)), `LOWER("c") LIKE ${d.ph(2)} ESCAPE '\\'`);
    assert.equal(d.lowerEq('"c"', d.ph(1)), `LOWER("c")=LOWER(${d.ph(1)})`);
  }
  const store = new Store({ app: 'l', data: { Note: { body: 'text' } } }, ':memory:');
  for (const body of ['100% sure', '1000 sure', 'a_b', 'axb']) store.insert('Note', { body });
  assert.deepEqual(store.list('Note', { where: { body: { like: '0% s' } } }).map((r) => r.body), ['100% sure']);
  assert.deepEqual(store.list('Note', { q: 'a_b', search: ['body'] }).map((r) => r.body), ['a_b']);
});

test('date buckets, NULL order, ties and collation per dialect', () => {
  assert.deepEqual(['day', 'month', 'year'].map((u) => sqlite.bucket('"d"', u)), [`strftime('%Y-%m-%d', "d")`, `strftime('%Y-%m', "d")`, `strftime('%Y', "d")`]);
  assert.deepEqual(['day', 'month', 'year'].map((u) => postgres.bucket('"d"', u)), ['SUBSTR("d", 1, 10)', 'SUBSTR("d", 1, 7)', 'SUBSTR("d", 1, 4)']);
  assert.equal(sqlite.order('"c"', 'DESC', { text: true, tie: true }), '"c" DESC', 'SQLite order is left exactly as it was');
  assert.equal(postgres.order('"c"', 'ASC'), '"c" ASC NULLS FIRST', 'NULLs are smallest: first ascending');
  assert.equal(postgres.order('"c"', 'DESC'), '"c" DESC NULLS LAST', 'last descending');
  assert.equal(postgres.order('"c"', 'ASC', { text: true, tie: true }), '"c" COLLATE "C" ASC NULLS FIRST, id ASC');
  assert.equal(sqlite.collate('"c"'), '"c"');
  assert.equal(postgres.collate('"c"'), '"c" COLLATE "C"');
});

test('upsert, named parameters and schema introspection per dialect', () => {
  assert.equal(sqlite.upsert('s', ['id', 'user', 'at'], 'id'), 'INSERT OR REPLACE INTO "s" ("id", "user", "at") VALUES (?,?,?)');
  assert.equal(postgres.upsert('s', ['id', 'user', 'at'], 'id'),
    'INSERT INTO "s" ("id", "user", "at") VALUES ($1,$2,$3) ON CONFLICT ("id") DO UPDATE SET "user"=EXCLUDED."user", "at"=EXCLUDED."at"');
  assert.deepEqual([sqlite.named('$today', 1), postgres.named('$today', 1)], ['$today', '$2']);
  const named = { $now: 'N', $today: 'T' };
  assert.deepEqual(sqlite.args(['$today', '$now'], named, ['x']), [named, 'x']);
  assert.deepEqual(postgres.args(['$today', '$now'], named, ['x']), ['T', 'N', 'x']);
  assert.match(postgres.tablesSql().sql, /information_schema\.tables/);
  assert.deepEqual(postgres.columnsSql('t').params, ['t']);
  assert.match(postgres.columnsSql('t').sql, /information_schema\.columns/);
  assert.deepEqual(postgres.indexesSql('t', 'idx_').params, ['t', 'idx\\_%']);
  assert.match(postgres.indexesSql('t').sql, /pg_indexes/);
  assert.deepEqual(sqlite.indexesSql('t', 'idx_').params, ['t', 'idx\\_%']);
  assert.equal(sqlite.columnsSql('a"b').sql, 'PRAGMA table_info("a""b")');
  assert.equal(sqlite.boolInt('x'), '(CASE WHEN x THEN 1 ELSE 0 END)');
  assert.equal(postgres.boolInt('x'), sqlite.boolInt('x'));
  assert.equal(sqlite.dropIndex('i'), 'DROP INDEX IF EXISTS "i"');
});

test('index names: SQLite keeps today\'s names, PostgreSQL truncates to 63 bytes with a stable hash', () => {
  const long = 'a'.repeat(40);
  assert.equal(sqlite.indexName('post', ['topic']), 'idx_post_topic');
  assert.equal(sqlite.indexName('t', [long, long]), `idx_t_${long}_${long}`, 'SQLite never renames an index that already exists');
  assert.equal(postgres.indexName('post', ['topic']), 'idx_post_topic', 'a short name is untouched');
  const a = postgres.indexName('t', [long, long]), b = postgres.indexName('t', [long, long + 'b']);
  assert.ok(Buffer.byteLength(a) <= 63 && Buffer.byteLength(b) <= 63, `${a} / ${b}`);
  assert.equal(a, postgres.indexName('t', [long, long]), 'the same columns always give the same name');
  assert.notEqual(a, b, 'two long names with one head stay apart');
  assert.match(a, /^idx_t_a+_a*_[0-9a-f]{8}$/);
  const wide = postgres.indexName('t', ['é'.repeat(40)]);
  assert.ok(Buffer.byteLength(wide) <= 63 && !wide.includes('�'), 'a multi-byte character is never cut in half');
  assert.equal(Buffer.byteLength(a), 63, 'the cut fills the limit exactly');
});

test('PostgreSQL: a second boot over the same catalog recreates and drops no index, however long the names', () => {
  const graph = { app: 'long', data: {
    Customer: { name: 'text' },
    // idx_shipment_<40>_<40> is longer than 63 bytes: the engine cuts it, so only our own cut is stable.
    Shipment: { customer: 'ref:Customer', [`${'x'.repeat(40)}`]: 'text', [`${'y'.repeat(40)}`]: 'text' },
  }, rules: { Shipment: [{ unique: ['x'.repeat(40), 'y'.repeat(40)] }] } };
  const first = recorder(postgres);
  const one = new Store(graph, 'x', undefined, first);
  assert.ok(one.migrations.some((m) => m.startsWith('index shipment.idx_shipment_xxx')));
  const second = recorder(postgres, first.catalog);
  const two = new Store(graph, 'x', undefined, second);
  assert.deepEqual(two.migrations, [], `nothing to migrate: ${two.migrations}`);
  assert.ok(!second.log.some((l) => /CREATE INDEX|DROP INDEX/.test(l)), second.log.join('\n'));
});

test('SQLite: sessions upsert one row per id and an existing outbox keeps its mixed-case columns', () => {
  const store = new Store({ app: 'q', data: { Note: { body: 'text' } } }, ':memory:');
  store.sessionSet('s1', 1);
  store.sessionSet('s1', 2);
  assert.equal(store.sessionUser('s1'), 2);
  assert.equal(store.drv.get('SELECT COUNT(*) AS n FROM "_session"').n, 1);
  const id = store.enqueue({ kind: 'http', connector: 'c', target: 't', payload: {} });
  assert.equal(store.outboxClaim(id, 10, 5), true);
  store.outboxUpdate(id, { status: 'sent' });
  const row = store.outboxGet(id);
  assert.deepEqual([row.status, row.attempts, typeof row.updatedAt, row.claimedAt], ['sent', 0, 'string', 10]);
  assert.deepEqual(store.drv.columns('_outbox').map((c) => c.name).slice(-2), ['updatedAt', 'claimedAt']);
});
