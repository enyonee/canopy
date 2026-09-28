import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-')), 'data.sqlite');
const G = (data, extra = {}) => ({ app: 't', data, ...extra });

test('schema is derived from the graph, not written by hand', () => {
  const store = new Store(G({ Task: { title: 'text!', n: 'int=1', done: 'bool=false' } }), ':memory:');
  const cols = store.drv.columns('task').map((c) => `${c.name}:${c.type}`);
  assert.deepEqual(cols, ['id:INTEGER', 'title:TEXT', 'n:INTEGER', 'done:INTEGER']);
  assert.deepEqual(store.migrations, ['create table task']);
});

test('a new field is added and its declared default is backfilled into existing rows', () => {
  const file = tmp();
  const before = new Store(G({ Task: { title: 'text!' } }), file);
  before.insert('Task', { title: 'old one' });
  before.insert('Task', { title: 'old two' });
  const after = new Store(G({ Task: { title: 'text!', priority: 'enum[low,high]=low', note: 'text' } }), file);
  assert.ok(after.migrations.some((m) => /backfilled 2 row\(s\) with "low"/.test(m)), after.migrations.join('; '));
  assert.ok(after.migrations.some((m) => m === 'add column task.note'), 'a field without a default is added silently');
  assert.deepEqual(after.list('Task', {}).map((r) => r.priority), ['low', 'low']);
  assert.equal(after.list('Task', {})[0].note, null);
});

test('migration is idempotent', () => {
  const file = tmp();
  const graph = G({ Task: { title: 'text!', done: 'bool=false' } });
  new Store(graph, file);
  const second = new Store(graph, file);
  assert.deepEqual(second.migrations, [], 'a second boot must change nothing');
});

test('a removed field is kept and reported, unless destruction is declared', () => {
  const file = tmp();
  new Store(G({ Task: { title: 'text!', legacy: 'text' } }), file);
  const kept = new Store(G({ Task: { title: 'text!' } }), file);
  assert.ok(kept.migrations.some((m) => /kept orphan columns legacy/.test(m)));
  const allowed = new Store(G({ Task: { title: 'text!' } }, { allowDestructive: true }), file);
  assert.deepEqual(allowed.migrations, [], 'declared destruction stops the warning');
});

test('insert applies defaults, update touches only known fields, remove deletes', () => {
  const store = new Store(G({ Task: { title: 'text!', done: 'bool=true', n: 'int=5', at: 'time=now' } }), ':memory:');
  const id = store.insert('Task', { title: 'a' });
  const row = store.get('Task', id);
  assert.equal(row.done, 1);
  assert.equal(row.n, 5);
  assert.match(row.at, /^\d{4}-/);
  store.insert('Task', { title: 'b', done: 'false', n: '' });
  assert.equal(store.list('Task', { where: { title: 'b' } })[0].done, 0);
  store.update('Task', id, { title: 'c', nonsense: 'ignored' });
  assert.equal(store.get('Task', id).title, 'c');
  store.update('Task', id, {});
  assert.equal(store.get('Task', id).title, 'c', 'an empty update is a no-op');
  store.remove('Task', id);
  assert.equal(store.get('Task', id), undefined);
  assert.equal(store.get('Task', ''), null, 'an empty id is not a lookup');
});

test('label is the first text field, or the id', () => {
  const store = new Store(G({ A: { name: 'text!', note: 'longtext' }, B: { n: 'int' } }), ':memory:');
  const a = store.insert('A', { name: 'Ann' });
  assert.equal(store.label('A', store.get('A', a)), 'Ann');
  const b = store.insert('B', { n: 1 });
  assert.equal(store.label('B', store.get('B', b)), `#${b}`);
  assert.equal(store.label('A', null), '');
  assert.equal(store.labelField('B'), null);
});

test('list filters, searches and sorts only through declared fields', () => {
  const store = new Store(G({ Task: { title: 'text!', body: 'longtext', done: 'bool=false' } }), ':memory:');
  store.insert('Task', { title: 'alpha', body: 'about cats', done: 'true' });
  store.insert('Task', { title: 'beta', body: 'about dogs' });
  store.insert('Task', { title: 'gamma', body: 'CATS again' });
  assert.deepEqual(store.list('Task', { where: { done: 'true' } }).map((r) => r.title), ['alpha']);
  assert.deepEqual(store.list('Task', { where: { done: undefined, title: '' } }).length, 3, 'empty filters are ignored');
  assert.deepEqual(store.list('Task', { search: ['title', 'body'], q: 'cats' }).map((r) => r.title).sort(), ['alpha', 'gamma']);
  assert.deepEqual(store.list('Task', { q: 'cats' }).length, 3, 'a query without declared search fields filters nothing');
  assert.deepEqual(store.list('Task', { sort: { field: 'title', dir: 'asc' } }).map((r) => r.title), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(store.list('Task', { sort: { field: 'title', dir: 'desc' } }).map((r) => r.title), ['gamma', 'beta', 'alpha']);
  assert.deepEqual(store.list('Task', {}).map((r) => r.title), ['gamma', 'beta', 'alpha'], 'newest first by default');
  assert.equal(store.count('Task'), 3);
  assert.equal(store.count('Task', { done: 'true' }), 1);
});

// --- round 7: indexes derived from the graph ---------------------------------
test('every ref column, unique rule (single and compound), and status field gets an index', () => {
  const store = new Store(G({
    Customer: { name: 'text!' },
    Order: { customer: 'ref:Customer!', status: 'enum[cart,paid]=cart', code: 'text!' },
    Follow: { follower: 'ref:Customer', category: 'text!' },
  }, {
    rules: { Order: [{ unique: 'code' }], Follow: [{ unique: ['follower', 'category'] }] },
    states: { Order: { field: 'status', transitions: [{ name: 'pay', to: 'paid' }] } },
  }), ':memory:');
  const names = (table) => store.drv.indexes(table);
  assert.deepEqual(names('order').sort(), ['idx_order_customer', 'idx_order_code', 'idx_order_status'].sort());
  assert.deepEqual(names('follow').sort(), ['idx_follow_follower', 'idx_follow_follower_category'].sort(), 'the ref column and the compound rule are two different index tuples');
  assert.ok(store.migrations.some((m) => m === 'index order.idx_order_customer (customer)'));
  assert.ok(store.migrations.some((m) => m === 'index follow.idx_follow_follower_category (follower, category)'));
});

test('a where-key named in a saved list or a dashboard gets a best-effort index', () => {
  const store = new Store(G({ Order: { status: 'enum[cart,paid]=cart', flagged: 'bool=false' } }, {
    lists: [{ id: 'cart', entity: 'Order', where: { status: 'cart' } }],
    dashboards: [{ id: 'd', title: 'D', cards: [{ title: 'x', entity: 'Order', where: { flagged: 1 } }] }],
  }), ':memory:');
  const names = store.drv.indexes('order');
  assert.deepEqual(names.sort(), ['idx_order_flagged', 'idx_order_status'].sort());
});

test('index migration is idempotent, and a no-longer-desired index is dropped, not just left orphaned', () => {
  const file = tmp();
  const withRule = new Store(G({ Order: { code: 'text!' } }, { rules: { Order: [{ unique: 'code' }] } }), file);
  assert.ok(withRule.migrations.includes('index order.idx_order_code (code)'));
  const again = new Store(G({ Order: { code: 'text!' } }, { rules: { Order: [{ unique: 'code' }] } }), file);
  assert.deepEqual(again.migrations, [], 'a second boot with the same graph adds nothing');
  const ruleDropped = new Store(G({ Order: { code: 'text!' } }), file);
  assert.ok(ruleDropped.migrations.some((m) => m === 'dropped index idx_order_code on order'), ruleDropped.migrations.join('; '));
  const names = ruleDropped.drv.indexes('order');
  assert.deepEqual(names, []);
});

// --- round 7: paging fallback -------------------------------------------------
test('listPage: the full-scan fallback (derived sort or in-memory where) still returns one page, not every row', () => {
  const store = new Store(G({ Task: { title: 'text!', score: 'int := 1' } }), ':memory:');
  for (let i = 0; i < 10; i++) store.insert('Task', { title: `t${i}` });
  const bySort = store.listPage('Task', { sort: { field: 'score', dir: 'asc' } }, { page: 1, pageSize: 3 });
  assert.equal(bySort.rows.length, 3, 'a derived-field sort forces the fallback, which must still page');
  assert.equal(bySort.total, 10);
  assert.equal(bySort.pages, 4);
  const page2 = store.listPage('Task', { sort: { field: 'score', dir: 'asc' } }, { page: 2, pageSize: 3 });
  assert.equal(page2.rows.length, 3);
  assert.notDeepEqual(page2.rows.map((r) => r.id), bySort.rows.map((r) => r.id), 'page 2 is not page 1');
  const byWhere = store.listPage('Task', { where: { score: { gte: 0 } } }, { page: 1, pageSize: 4 });
  assert.equal(byWhere.rows.length, 4, 'an in-memory (derived-field) where forces the fallback, which must still page');
  assert.equal(byWhere.total, 10);
});

test('aggregate groups, counts and sums exactly what the graph names', () => {
  const store = new Store(G({ R: { company: 'text!', revenue: 'int=0', profit: 'int=0' } }), ':memory:');
  store.insert('R', { company: 'A', revenue: 100, profit: 10 });
  store.insert('R', { company: 'A', revenue: 300, profit: 50 });
  store.insert('R', { company: 'B', revenue: 200, profit: 20 });
  const [total] = store.aggregate('R', { metrics: [{ fn: 'sum', field: 'revenue', as: 'v' }] });
  assert.equal(total.v, 600);
  const [n] = store.aggregate('R', { metrics: [{ fn: 'count', as: 'n' }] });
  assert.equal(n.n, 3);
  const [avg] = store.aggregate('R', { metrics: [{ fn: 'avg', field: 'revenue', as: 'v' }], where: { company: 'A' } });
  assert.equal(avg.v, 200);
  const grouped = store.aggregate('R', {
    groupBy: 'company', metrics: [{ fn: 'sum', field: 'revenue', as: 'rev' }, { fn: 'max', field: 'profit', as: 'best' }],
    sort: { field: 'rev', dir: 'desc' },
  });
  assert.deepEqual(grouped.map((r) => ({ ...r })), [{ grp: 'A', rev: 400, best: 50 }, { grp: 'B', rev: 200, best: 20 }]);
  assert.equal(store.aggregate('R', { groupBy: 'company', metrics: [{ fn: 'count', as: 'n' }], limit: 1 }).length, 1);
  const asc = store.aggregate('R', { groupBy: 'company', metrics: [{ fn: 'min', field: 'profit', as: 'm' }], sort: { field: 'grp', dir: 'asc' } });
  assert.deepEqual(asc.map((r) => r.grp), ['A', 'B']);
});
