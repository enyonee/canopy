// Storage, second surface: derived fields, ranges, in-memory aggregation, the outbox, passwords.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { isHashed } from '../runtime/auth.mjs';

const G = (data, extra = {}) => ({ app: 'x', data, ...extra });
const shop = () => new Store(G({
  Customer: { name: 'text!', tier: 'enum[gold,plain]=plain', discount: 'int=0' },
  Order: { customer: 'ref:Customer', status: 'enum[cart,paid]=cart', createdAt: 'time=now', due: 'date',
    items: 'int := count(Item)', total: 'money := sum(Item: qty * price)', net: 'money := total * (100 - customer.discount) / 100', big: 'bool := total > 100', name: 'text := concat("#", status)' },
  Item: { order: 'ref:Order!', qty: 'int=1', price: 'money', line: 'money := qty * price' },
}), ':memory:');

test('derived fields are computed on read, in money and through references, and never stored', () => {
  const store = shop();
  assert.ok(!store.db.prepare(`PRAGMA table_info("order")`).all().some((c) => c.name === 'total'), 'no column for a derived field');
  const c = store.insert('Customer', { name: 'Ann', tier: 'gold', discount: 10 });
  const o = store.insert('Order', { customer: c, status: 'cart' });
  store.insert('Item', { order: o, qty: 2, price: 12.5 });
  store.insert('Item', { order: o, qty: 1, price: '100' });
  const row = store.get('Order', o);
  assert.equal(row.items, 2);
  assert.equal(row.total, 12500, 'money is stored in minor units, derived included');
  assert.equal(row.net, 11250, 'a hop through the reference reads the discount');
  assert.equal(row.big, 1, 'a derived bool is 1/0');
  assert.equal(row.name, '#cart');
  assert.equal(store.get('Item', 1).line, 2500);
  store.update('Order', o, { total: 1, items: 9 });
  assert.equal(store.get('Order', o).total, 12500, 'writing a derived field is ignored');
  assert.equal(store.list('Order', {})[0].total, 12500, 'list hydrates too');
  const orphan = store.insert('Order', {});
  assert.equal(store.get('Order', orphan).net, null, 'a null reference reads as null');
  assert.equal(store.get('Order', orphan).total, 0);
  assert.equal(store.get('Order', orphan).items, 0);
  assert.equal(store.hydrate('Order', undefined), undefined);
  assert.equal(store.hydrate('Order', null), null);
});

test('reverse references are found, named, or refused with a hint', () => {
  const store = new Store(G({
    A: { n: 'text', kids: 'int := count(B)', ambiguous: 'int := count(C)', named: 'int := count(C.second)', none: 'int := count(D)' },
    B: { a: 'ref:A' }, C: { first: 'ref:A', second: 'ref:A' }, D: { n: 'text' },
  }), ':memory:');
  const a = store.insert('A', { n: 'x' });
  store.insert('B', { a }); store.insert('C', { first: a, second: null }); store.insert('C', { first: null, second: a });
  const row = store.raw('A', a);
  assert.equal(store.ctx('A', row).get(['kids']), 1);
  assert.equal(store.ctx('A', row).get(['named']), 1);
  assert.throws(() => store.ctx('A', row).get(['ambiguous']), /C references A through first and second; name one: C\.first/);
  assert.throws(() => store.ctx('A', row).get(['none']), /D has no reference to A; add a "ref:A" field to D/);
  assert.throws(() => store.childVia('Ghost', 'A'), /unknown entity "Ghost"/);
  assert.throws(() => store.childVia('C', 'A', 'nope'), /C\.nope is not a reference to A/);
  assert.throws(() => store.childVia('B', 'A', 'a') && store.childVia('D', 'A', 'n'), /D\.n is not a reference to A/);
  assert.throws(() => store.ctx('A', row).get(['ghost']), /A has no field "ghost"/);
  assert.throws(() => store.ctx('A', row).get(['n', 'deeper']), /A\.n is text, cannot read \.deeper of it/);
  assert.equal(store.fieldAt('C', ['first', 'n']).name, 'n');
  assert.equal(store.fieldAt('C', ['first', 'ghost']), null);
  assert.equal(store.fieldAt('C', ['ghost']), null);
  assert.equal(store.fieldAt('A', ['n', 'deeper']), null, 'a text field has no fields');
});

test('a derived field that depends on itself is refused at read time', () => {
  const store = new Store(G({ A: { x: 'int := y + 1', y: 'int := x + 1' } }), ':memory:');
  const a = store.insert('A', {});
  assert.throws(() => store.get('A', a), /derived field A\.x depends on itself \(A\.x → A\.y → A\.x\)/);
});

test('where clauses: ranges, sets, likes, null, and the same on derived fields in memory', () => {
  const store = shop();
  const c = store.insert('Customer', { name: 'Ann' });
  const cheap = store.insert('Order', { customer: c, status: 'cart', due: '2026-01-05', createdAt: '2026-01-05T10:00:00Z' });
  const dear = store.insert('Order', { customer: c, status: 'paid', due: '2026-02-05', createdAt: '2026-02-05T10:00:00Z' });
  const bare = store.insert('Order', { status: 'cart' });
  store.insert('Item', { order: cheap, qty: 1, price: 10 });
  store.insert('Item', { order: dear, qty: 3, price: 100 });
  const ids = (opts) => store.list('Order', opts).map((r) => r.id).sort();
  assert.deepEqual(ids({ where: { due: { gte: '2026-02-01' } } }), [dear]);
  assert.deepEqual(ids({ where: { due: { gte: '2026-02-05' } } }), [dear], 'gte includes the bound');
  assert.deepEqual(ids({ where: { due: { lte: '2026-01-05' } } }), [cheap], 'lte includes the bound');
  assert.deepEqual(ids({ where: { due: { lt: '2026-02-01' } } }), [cheap]);
  assert.deepEqual(ids({ where: { due: { gt: '2026-01-05', lte: '2026-02-05' } } }), [dear]);
  assert.deepEqual(ids({ where: { status: { in: ['paid'] } } }), [dear]);
  assert.deepEqual(ids({ where: { status: { in: 'paid' } } }), [dear], 'a scalar "in" is a one-element set');
  assert.deepEqual(ids({ where: { status: { ne: 'paid' } } }), [cheap, bare].sort());
  assert.deepEqual(ids({ where: { due: { like: '2026-01' } } }), [cheap]);
  assert.deepEqual(ids({ where: { customer: null } }), [bare]);
  assert.deepEqual(ids({ where: { customer: undefined, status: '' } }), [cheap, dear, bare].sort(), 'empty comparisons are dropped');
  assert.deepEqual(ids({ where: { due: { gte: '', lte: null } } }), [cheap, dear, bare].sort());
  assert.throws(() => store.list('Order', { where: { due: { between: 1 } } }), /unknown comparison "between" on Order\.due; known: gte, lte, gt, lt, ne, in, like/);
  // derived fields cannot go to SQL: they are filtered and sorted after hydration
  assert.deepEqual(ids({ where: { big: 1 } }), [dear]);
  assert.deepEqual(ids({ where: { total: { gte: 100 } } }), [dear]);
  assert.deepEqual(ids({ where: { total: { gt: 5, lt: 100 } } }), [cheap], 'derived money compares in major units like stored money');
  assert.deepEqual(ids({ where: { total: { lte: 10 } } }), [cheap, bare].sort());
  assert.deepEqual(ids({ where: { total: 300 } }), [dear]);
  assert.deepEqual(ids({ where: { total: { in: [10, 300] } } }), [cheap, dear].sort());
  assert.deepEqual(ids({ where: { items: { in: [1, 2] } } }), [cheap, dear].sort());
  assert.deepEqual(ids({ where: { name: { like: 'CART' } } }), [cheap, bare].sort());
  assert.deepEqual(ids({ where: { items: { ne: 0 } } }), [cheap, dear].sort());
  assert.deepEqual(ids({ where: { net: null } }), [bare]);
  assert.deepEqual(ids({ where: { total: { gte: '' } } }), [cheap, dear, bare].sort(), 'an empty bound is no bound');
  assert.deepEqual(store.list('Order', { sort: { field: 'total', dir: 'desc' } }).map((r) => r.id), [dear, cheap, bare]);
  assert.deepEqual(store.list('Order', { sort: { field: 'total', dir: 'asc' } }).map((r) => r.id), [bare, cheap, dear]);
  assert.equal(store.count('Order', { big: 1 }), 1);
});

test('aggregation: month buckets in SQL, derived metrics in memory, sort and limit in both', () => {
  const store = shop();
  const c = store.insert('Customer', { name: 'Ann' });
  const jan = store.insert('Order', { customer: c, status: 'paid', createdAt: '2026-01-05T10:00:00Z', due: '2026-01-05' });
  const feb = store.insert('Order', { customer: c, status: 'paid', createdAt: '2026-02-05T10:00:00Z', due: '2026-02-05' });
  const feb2 = store.insert('Order', { customer: c, status: 'cart', createdAt: '2026-02-09T10:00:00Z', due: '2026-02-09' });
  store.insert('Item', { order: jan, qty: 1, price: 10 });
  store.insert('Item', { order: feb, qty: 2, price: 10 });
  store.insert('Item', { order: feb2, qty: 4, price: 10 });
  assert.deepEqual(store.aggregate('Order', { groupBy: 'createdAt', groupUnit: 'month', metrics: [{ fn: 'count', as: 'n' }], sort: { field: 'grp', dir: 'asc' } }),
    [{ grp: '2026-01', n: 1 }, { grp: '2026-02', n: 2 }]);
  assert.deepEqual(store.aggregate('Order', { groupBy: 'due', groupUnit: 'year', metrics: [{ fn: 'count', as: 'n' }] }), [{ grp: '2026', n: 3 }]);
  assert.deepEqual(store.aggregate('Order', { groupBy: 'due', groupUnit: 'day', metrics: [{ fn: 'count', as: 'n' }], limit: 1, sort: { field: 'grp', dir: 'desc' } }), [{ grp: '2026-02-09', n: 1 }]);
  // derived metric → in memory
  const byStatus = store.aggregate('Order', { groupBy: 'status', metrics: [{ fn: 'sum', field: 'total', as: 's' }, { fn: 'avg', field: 'total', as: 'a' }, { fn: 'min', field: 'total', as: 'mn' }, { fn: 'max', field: 'total', as: 'mx' }, { fn: 'count', as: 'n' }], sort: { field: 's', dir: 'desc' } });
  assert.deepEqual(byStatus, [{ grp: 'cart', s: 4000, a: 4000, mn: 4000, mx: 4000, n: 1 }, { grp: 'paid', s: 3000, a: 1500, mn: 1000, mx: 2000, n: 2 }]);
  assert.deepEqual(store.aggregate('Order', { groupBy: 'createdAt', groupUnit: 'month', metrics: [{ fn: 'sum', field: 'total', as: 's' }], sort: { field: 'grp', dir: 'asc' } }),
    [{ grp: '2026-01', s: 1000 }, { grp: '2026-02', s: 6000 }], 'month buckets work in memory too');
  assert.deepEqual(store.aggregate('Order', { metrics: [{ fn: 'sum', field: 'total', as: 's' }], where: { status: 'paid' } }), [{ s: 3000 }]);
  assert.deepEqual(store.aggregate('Order', { groupBy: 'big', metrics: [{ fn: 'count', as: 'n' }], sort: { field: 'n', dir: 'asc' }, limit: 1 }), [{ grp: 0, n: 3 }], 'no order is over 100');
  assert.deepEqual(store.aggregate('Order', { metrics: [{ fn: 'avg', field: 'net', as: 'a' }], where: { status: 'gone' } }), [], 'no rows, no groups');
  assert.deepEqual(store.aggregate('Order', { groupBy: 'status', metrics: [{ fn: 'max', field: 'net', as: 'm' }], where: { big: 1 } }), []);
  assert.deepEqual(store.aggregate('Item', { metrics: [{ fn: 'min', field: 'line', as: 'm' }] }), [{ m: 1000 }]);
  const withNulls = new Store(G({ A: { v: 'int', d: 'int := v * 2' } }), ':memory:');
  withNulls.insert('A', { v: 1 }); withNulls.insert('A', {});
  assert.deepEqual(withNulls.aggregate('A', { metrics: [{ fn: 'sum', field: 'd', as: 's' }, { fn: 'avg', field: 'd', as: 'a' }] }), [{ s: 2, a: 2 }], 'nulls are skipped');
  assert.deepEqual(withNulls.aggregate('A', { metrics: [{ fn: 'max', field: 'd', as: 'm' }], where: { v: { gt: 5 } } }), [], 'no rows at all');
  const onlyNull = new Store(G({ A: { v: 'int', d: 'int := v * 2' } }), ':memory:');
  onlyNull.insert('A', {});
  assert.deepEqual(onlyNull.aggregate('A', { metrics: [{ fn: 'max', field: 'd', as: 'm' }] }), [{ m: null }], 'only nulls is null');
  assert.deepEqual(store.aggregate('Order', { groupBy: 'total', metrics: [{ fn: 'count', as: 'n' }], sort: { field: 'grp', dir: 'asc' } }).map((r) => r.grp), [1000, 2000, 4000]);
});

test('uniqueness, transactions and passwords', () => {
  const store = new Store(G({ U: { email: 'text!', password: 'password', n: 'int=0' } }), ':memory:');
  const a = store.insert('U', { email: 'a@x', password: 'pw' });
  assert.equal(store.exists('U', 'email', 'a@x'), true);
  assert.equal(store.exists('U', 'email', 'a@x', a), false, 'the row itself does not collide');
  assert.equal(store.exists('U', 'email', 'b@x'), false);
  assert.ok(isHashed(store.raw('U', a).password), 'stored hashed');
  const hashed = store.raw('U', a).password;
  store.update('U', a, { password: '' });
  assert.equal(store.raw('U', a).password, hashed, 'an empty password keeps the old one');
  store.update('U', a, { password: hashed });
  assert.equal(store.raw('U', a).password, hashed, 'an already hashed value is stored as is');
  store.update('U', a, { password: 'new' });
  assert.notEqual(store.raw('U', a).password, hashed);
  const b = store.insert('U', { email: 'b@x', password: '' });
  assert.equal(store.raw('U', b).password, null);
  assert.equal(Store.prepareValue({ kind: 'password' }, null), null);
  assert.throws(() => store.transaction(() => { store.update('U', a, { n: 5 }); throw new Error('stop'); }), /stop/);
  assert.equal(store.raw('U', a).n, 0, 'rolled back');
  assert.equal(store.transaction(() => { store.update('U', a, { n: 7 }); return 'done'; }), 'done');
  assert.equal(store.raw('U', a).n, 7, 'committed');
});

test('the outbox is a table with a status, filtered and updated by id', () => {
  const store = new Store(G({ A: { n: 'text' } }), ':memory:');
  const id = store.enqueue({ kind: 'http', connector: 'c', target: 't', payload: { x: [1, 2] } });
  const row = store.outboxGet(id);
  assert.equal(row.status, 'queued'); assert.equal(row.attempts, 0); assert.deepEqual(row.payload, { x: [1, 2] });
  assert.match(row.at, /^\d{4}-/); assert.equal(row.at, row.updatedAt);
  store.outboxUpdate(id, { status: 'sent', code: 200, attempts: 1 });
  assert.equal(store.outboxGet(id).status, 'sent');
  assert.deepEqual(store.outbox({ status: 'queued' }), []);
  assert.equal(store.outbox().length, 1);
  const two = store.enqueue({ kind: 'mail', connector: 'm', target: 'x' });
  assert.equal(store.outboxGet(two).payload, null);
  assert.equal(store.outbox()[0].id, two, 'newest first');
});

test('money, date and file columns: storage types, defaults and coercion through the store', () => {
  const store = new Store(G({ P: { price: 'money=9.99', day: 'date=today', on: 'date=2026-01-01', doc: 'file', pin: 'money' } }), ':memory:');
  const cols = Object.fromEntries(store.db.prepare(`PRAGMA table_info("p")`).all().map((c) => [c.name, c.type]));
  assert.equal(cols.price, 'INTEGER'); assert.equal(cols.day, 'TEXT'); assert.equal(cols.doc, 'TEXT');
  const id = store.insert('P', { doc: '123-x.txt' });
  const row = store.get('P', id);
  assert.equal(row.price, 999);
  assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(row.on, '2026-01-01');
  assert.equal(row.pin, null);
  store.update('P', id, { price: '12.345', pin: 3 });
  assert.equal(store.get('P', id).price, 1235, 'rounded to the cent');
  assert.equal(store.get('P', id).pin, 300);
  assert.equal(store.exists('P', 'price', '12.35'), true, 'uniqueness compares in storage units');
});
