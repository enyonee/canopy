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
const ctx = (store, extra = {}) => ({ store, graph, resolve: identity, text: identity, run: () => {}, fireCreated: () => {}, ...extra });

test('db.adjust adds to the current row or a named one, in money when the field is money, and refuses below "min"', () => {
  const store = fresh();
  const p = store.insert('Product', { name: 'Mug', stock: 5, price: 10 });
  assert.deepEqual(CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: -2 } })), { adjusted: 3 });
  assert.equal(store.get('Product', p).stock, 3);
  CATALOG['db.adjust'].run(ctx(store, { entity: 'Order', id: 99, step: { entity: 'Product', id: p, field: 'stock', by: '4' } }));
  assert.equal(store.get('Product', p).stock, 7, 'a string "by" is a number');
  CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'price', by: 2.5 } }));
  assert.equal(store.get('Product', p).price, 1250, 'money moves in major units');
  assert.throws(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: -100, min: 0 } })), /Product\.stock cannot go below 0/);
  assert.throws(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: -100, min: 0, message: 'Sold out' } })), /Sold out/);
  assert.equal(store.get('Product', p).stock, 7, 'a refused adjustment leaves the row alone');
  assert.throws(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: 42, step: { field: 'stock', by: 1 } })), /db\.adjust: no Product #42/);
  assert.throws(() => CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: p, step: { field: 'stock', by: 'lots' } })), /"by" is not a number/);
  const nullable = store.insert('Product', { name: 'Blank' });
  store.update('Product', nullable, { stock: null });
  CATALOG['db.adjust'].run(ctx(store, { entity: 'Product', id: nullable, step: { field: 'stock', by: 1 } }));
  assert.equal(store.get('Product', nullable).stock, 1, 'null counts as 0');
});

test('db.ensure finds or creates and says which; a made row fires "created" (item 14), a found one does not', () => {
  const store = fresh();
  const created = [];
  const fireCreated = (...a) => created.push(a);
  const first = CATALOG['db.ensure'].run(ctx(store, { step: { entity: 'Order', where: { customer: 'ann', status: 'cart' }, values: {} }, fireCreated }));
  assert.equal(first.made, true); assert.equal(first.found.customer, 'ann'); assert.equal(first.found.status, 'cart');
  assert.deepEqual(created, [['Order', first.found.id, { customer: 'ann', status: 'cart' }]]);
  const again = CATALOG['db.ensure'].run(ctx(store, { step: { entity: 'Order', where: { customer: 'ann', status: 'cart' } }, fireCreated }));
  assert.equal(again.made, false); assert.equal(again.found.id, first.found.id);
  assert.equal(created.length, 1, 'found, not made: no event');
  assert.equal(store.count('Order'), 1);
  store.insert('Order', { customer: 'ann', status: 'cart' });
  assert.equal(CATALOG['db.ensure'].run(ctx(store, { step: { entity: 'Order', where: { customer: 'ann' } } })).found.id, first.found.id, 'the oldest match wins');
});

test('db.each runs the nested steps once per matching row, oldest first, and reports the count', () => {
  const store = fresh();
  const o = store.insert('Order', { customer: 'ann' });
  const other = store.insert('Order', { customer: 'bob' });
  const prod = store.insert('Product', { name: 'Widget' });
  store.insert('Item', { order: o, product: prod, qty: 2 }); store.insert('Item', { order: other, product: prod, qty: 9 }); store.insert('Item', { order: o, product: prod, qty: 3 });
  const seen = [];
  const out = CATALOG['db.each'].run(ctx(store, { step: { from: 'Item', where: { order: o }, do: ['nested'] }, run: (steps, extra) => seen.push([steps, extra.each.qty, extra.eachEntity]) }));
  assert.deepEqual(out, { count: 2 });
  assert.deepEqual(seen, [[['nested'], 2, 'Item'], [['nested'], 3, 'Item']]);
  assert.deepEqual(CATALOG['db.each'].run(ctx(store, { step: { from: 'Item', do: [] } })), { count: 3 }, 'no where means every row');
});

test('http.send and mail.send only queue; the outbox row carries connector, target and payload', () => {
  const store = fresh();
  const h = CATALOG['http.send'].run(ctx(store, { step: { connector: 'hook', body: { a: 1 }, path: '/x' } }));
  const row = store.outboxGet(h.delivery);
  assert.equal(row.kind, 'http'); assert.equal(row.connector, 'hook'); assert.equal(row.target, 'http://sink.test/h/x'); assert.deepEqual(row.payload, { a: 1 }); assert.equal(row.status, 'queued');
  const plain = CATALOG['http.send'].run(ctx(store, { step: { connector: 'hook', body: {} } }));
  assert.equal(store.outboxGet(plain.delivery).target, 'http://sink.test/h', 'no path, no suffix');
  const m = CATALOG['mail.send'].run(ctx(store, { step: { connector: 'mail', to: 'x@y', subject: 'Hi', text: 'Body' } }));
  const letter = store.outboxGet(m.delivery);
  assert.equal(letter.kind, 'mail'); assert.equal(letter.target, 'x@y');
  assert.deepEqual(letter.payload, { from: 'shop@test', to: 'x@y', subject: 'Hi', text: 'Body' });
  const bare = CATALOG['mail.send'].run(ctx(store, { graph: { ...graph, connectors: { mail: { kind: 'mail' } } }, step: { connector: 'mail', to: null, subject: 's' } }));
  assert.deepEqual(store.outboxGet(bare.delivery).payload, { from: null, to: null, subject: 's', text: '' });
  assert.equal(store.outboxGet(bare.delivery).target, '');
});

test('the catalog search finds the new blocks by name and by what they do', () => {
  assert.ok(search('stock').some((l) => l.startsWith('db.adjust(')), search('stock').join('\n'));
  assert.ok(search('outbox').some((l) => l.startsWith('http.send(')));
  assert.ok(search('letter').some((l) => l.startsWith('mail.send(')));
  assert.ok(search('each').some((l) => l.includes('[db.read]')));
  assert.equal(Object.keys(CATALOG).length, 14);
  for (const b of Object.values(CATALOG)) { assert.ok(Array.isArray(b.effects) && b.effects.length); assert.ok(Array.isArray(b.requires)); assert.ok(b.summary); }
});
