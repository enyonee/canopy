// The blocks added for the CRM/shop class, run directly with a hand-made context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { CATALOG, search } from '../runtime/blocks.mjs';

const graph = {
  app: 'b', data: {
    Product: { name: 'text!', stock: 'int=0', price: 'money=0' },
    Order: { customer: 'text', status: 'enum[cart,placed]=cart' },
    Item: { order: 'ref:Order!', product: 'ref:Product!', qty: 'int=1' },
  },
  connectors: { hook: { kind: 'http', url: 'http://sink.test/h' }, mail: { kind: 'mail', from: 'shop@test' } },
};
const fresh = () => new Store(graph, ':memory:');
const identity = (v) => v;
const ctx = (store, extra = {}) => ({ store, graph, trace: () => {}, resolve: identity, text: identity, run: () => {}, fireCreated: () => {}, ...extra });

test('db.adjust adds to the current row or a named one, in money when the field is money, and refuses below "min"', async () => {
  const store = fresh();
  const p = await store.insert('Product', { name: 'Mug', stock: 5, price: 10 });
  assert.deepEqual(await CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: -2 } })), { adjusted: 3 });
  assert.equal((await store.get('Product', p)).stock, 3);
  await CATALOG['db.adjust'].run(ctx(store, { entity: 'Order', id: 99, step: { entity: 'Product', id: p, field: 'stock', by: '4' } }));
  assert.equal((await store.get('Product', p)).stock, 7, 'a string "by" is a number');
  await CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'price', by: 2.5 } }));
  assert.equal((await store.get('Product', p)).price, 1250, 'money moves in major units');
  await assert.rejects(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: -100, min: 0 } })), /Product\.stock cannot go below 0/);
  await assert.rejects(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: -100, min: 0, message: 'Sold out' } })), /Sold out/);
  assert.equal((await store.get('Product', p)).stock, 7, 'a refused adjustment leaves the row alone');
  await assert.rejects(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: 42, step: { field: 'stock', by: 1 } })), /db\.adjust: no Product #42/);
  await assert.rejects(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: 'lots' } })), /"by" is not a number/);
  const nullable = await store.insert('Product', { name: 'Blank' });
  await store.update('Product', nullable, { stock: null });
  await CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: nullable, step: { field: 'stock', by: 1 } }));
  assert.equal((await store.get('Product', nullable)).stock, 1, 'null counts as 0');
});

test('db.ensure finds or creates and says which; a made row fires "created" (item 14), a found one does not', async () => {
  const store = fresh();
  const created = [];
  const fireCreated = (...a) => created.push(a);
  const first = await CATALOG['db.ensure'].run(ctx(store, { step: { entity: 'Order', where: { customer: 'ann', status: 'cart' }, values: {} }, fireCreated }));
  assert.equal(first.made, true); assert.equal(first.found.customer, 'ann'); assert.equal(first.found.status, 'cart');
  assert.deepEqual(created, [['Order', first.found.id, { customer: 'ann', status: 'cart' }]]);
  const again = await CATALOG['db.ensure'].run(ctx(store, { step: { entity: 'Order', where: { customer: 'ann', status: 'cart' } }, fireCreated }));
  assert.equal(again.made, false); assert.equal(again.found.id, first.found.id);
  assert.equal(created.length, 1, 'found, not made: no event');
  assert.equal(await store.count('Order'), 1);
  await store.insert('Order', { customer: 'ann', status: 'cart' });
  assert.equal((await CATALOG['db.ensure'].run(ctx(store, { step: { entity: 'Order', where: { customer: 'ann' } } }))).found.id, first.found.id, 'the oldest match wins');
});

test('db.each runs the nested steps once per matching row, oldest first, and reports the count', async () => {
  const store = fresh();
  const o = await store.insert('Order', { customer: 'ann' });
  const other = await store.insert('Order', { customer: 'bob' });
  const prod = await store.insert('Product', { name: 'Widget' });
  await store.insert('Item', { order: o, product: prod, qty: 2 }); await store.insert('Item', { order: other, product: prod, qty: 9 }); await store.insert('Item', { order: o, product: prod, qty: 3 });
  const seen = [];
  const out = await CATALOG['db.each'].run(ctx(store, { step: { from: 'Item', where: { order: o }, do: ['nested'] }, run: (steps, extra) => seen.push([steps, extra.each.qty, extra.eachEntity]) }));
  assert.deepEqual(out, { count: 2 });
  assert.deepEqual(seen, [[['nested'], 2, 'Item'], [['nested'], 3, 'Item']]);
  assert.deepEqual(await CATALOG['db.each'].run(ctx(store, { step: { from: 'Item', do: [] } })), { count: 3 }, 'no where means every row');
});

test('Where: a step where key that resolved to nothing matches no rows and is traced; null is IS NULL; a route filter stays absent = no filter', async () => {
  const store = fresh();
  const paid = await store.insert('Order', { customer: 'ann', status: 'placed' });
  await store.insert('Order', { customer: 'bob', status: 'placed' });
  const events = [];
  const trace = (e) => events.push(e);
  const seen = [];
  const each = (where) => CATALOG['db.each'].run(ctx(store, { trace, step: { from: 'Order', where, do: [] }, run: (_s, x) => seen.push(x.each.id) }));
  assert.deepEqual(each({ status: 'placed', customer: undefined }), { count: 0 }, 'undefined must not widen the filter');
  assert.deepEqual(events, [{ kind: 'where_unresolved', block: 'db.each', key: 'customer' }]);
  assert.deepEqual(each({ customer: { ne: undefined } }), { count: 0 }, 'an undefined comparison value is unresolved too');
  assert.equal(events[1].key, 'customer.ne');
  assert.deepEqual(each({ status: 'placed', customer: '' }), { count: 0 }, "'' (an empty form field) is a missing value, not a dropped filter");
  assert.equal(events.pop().key, 'customer');
  assert.deepEqual(each({ customer: { in: ['ann', undefined] } }), { count: 0 });
  assert.equal(events[2].key, 'customer.in.1');
  const blank = await store.insert('Product', { name: 'Blank' });
  await store.update('Product', blank, { stock: null });
  await store.insert('Product', { name: 'Stocked', stock: 4 });
  const nulls = CATALOG['db.each'].run(ctx(store, { trace, step: { from: 'Product', where: { stock: null }, do: [] }, run: (_s, x) => seen.push(x.each.id) }));
  assert.deepEqual(nulls, { count: 1 }, 'null still means IS NULL, not unresolved');
  assert.equal(seen.at(-1), blank);
  assert.equal(events.length, 3, 'a resolved where traces nothing');
  assert.deepEqual(each({ customer: 'ann' }), { count: 1 });
  assert.equal(seen.at(-1), paid);
  const before = await store.count('Order');
  for (const where of [{ customer: '' }, { customer: undefined }, { status: 'placed', customer: undefined }]) {
    await assert.rejects(async () => await CATALOG['db.ensure'].run(ctx(store, { trace, step: { entity: 'Order', where } })), /db\.ensure: "where" key "customer" resolved to nothing/);
  }
  assert.equal(await store.count('Order'), before, 'a refused ensure creates nothing');
  assert.deepEqual(events.at(-1), { kind: 'where_unresolved', block: 'db.ensure', key: 'customer' });
  assert.equal(CATALOG['db.ensure'].run(ctx(store, { trace, step: { entity: 'Product', where: { stock: null } } })).found.id, blank, 'null finds the row without a stock');
  assert.equal((await store.list('Order', { where: { customer: undefined, status: 'placed' } })).length, 2, 'the store (list filters from ?field=) keeps absent = no filter');
  assert.equal((await store.list('Order', { where: { customer: '' } })).length, 2, "and '' too");
});

test('http.send and mail.send only queue; the outbox row carries connector, target and payload', async () => {
  const store = fresh();
  const h = await CATALOG['http.send'].run(ctx(store, { step: { connector: 'hook', body: { a: 1 }, path: '/x' } }));
  const row = await store.outboxGet(h.delivery);
  assert.equal(row.kind, 'http'); assert.equal(row.connector, 'hook'); assert.equal(row.target, 'http://sink.test/h/x'); assert.deepEqual(row.payload, { a: 1 }); assert.equal(row.status, 'queued');
  const plain = await CATALOG['http.send'].run(ctx(store, { step: { connector: 'hook', body: {} } }));
  assert.equal((await store.outboxGet(plain.delivery)).target, 'http://sink.test/h', 'no path, no suffix');
  const m = await CATALOG['mail.send'].run(ctx(store, { step: { connector: 'mail', to: 'x@y', subject: 'Hi', text: 'Body' } }));
  const letter = await store.outboxGet(m.delivery);
  assert.equal(letter.kind, 'mail'); assert.equal(letter.target, 'x@y');
  assert.deepEqual(letter.payload, { from: 'shop@test', to: 'x@y', subject: 'Hi', text: 'Body' });
  const bare = await CATALOG['mail.send'].run(ctx(store, { graph: { ...graph, connectors: { mail: { kind: 'mail' } } }, step: { connector: 'mail', to: null, subject: 's' } }));
  assert.deepEqual((await store.outboxGet(bare.delivery)).payload, { from: null, to: null, subject: 's', text: '' });
  assert.equal((await store.outboxGet(bare.delivery)).target, '');
});

test('the catalog search finds the new blocks by name and by what they do', () => {
  assert.ok(search('stock').some((l) => l.startsWith('db.adjust(')), search('stock').join('\n'));
  assert.ok(search('outbox').some((l) => l.startsWith('http.send(')));
  assert.ok(search('letter').some((l) => l.startsWith('mail.send(')));
  assert.ok(search('each').some((l) => l.includes('[db.read]')));
  assert.equal(Object.keys(CATALOG).length, 15);
  for (const b of Object.values(CATALOG)) { assert.ok(Array.isArray(b.effects) && b.effects.length); assert.ok(Array.isArray(b.requires)); assert.ok(b.summary); }
});
