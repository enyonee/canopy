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
  const cols = store.db.prepare(`PRAGMA table_info("task")`).all().map((c) => `${c.name}:${c.type}`);
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
