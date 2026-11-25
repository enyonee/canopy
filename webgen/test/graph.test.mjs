import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpec, title, plural, ruleBounds, uniqueFields, labelField } from '../lib/graph.mjs';

test('field specs read as the runtime reads them', () => {
  assert.deepEqual(parseSpec('email', 'text!'), { name: 'email', kind: 'text', required: true, default: null, derived: null, options: null, target: null });
  assert.equal(parseSpec('stock', 'int=0').default, '0');
  assert.deepEqual(parseSpec('status', 'enum[cart,placed,paid]=cart').options, ['cart', 'placed', 'paid']);
  assert.equal(parseSpec('status', 'enum[cart,placed,paid]=cart').default, 'cart');
  assert.deepEqual([parseSpec('customer', 'ref:User!').kind, parseSpec('customer', 'ref:User!').target, parseSpec('customer', 'ref:User!').required], ['ref', 'User', true]);
  assert.equal(parseSpec('total', 'money := sum(OrderItem: qty * price)').derived, 'sum(OrderItem: qty * price)');
  assert.equal(parseSpec('discount', 'percent=0').kind, 'percent');
  assert.throws(() => parseSpec('x', 'enum[a'), /cannot read the spec of x/);
});

test('captions, plurals and the label field', () => {
  assert.equal(title('createdAt'), 'Created at');
  assert.equal(title('paymentMethod'), 'Payment method');
  assert.equal(title('OrderItem'), 'Order item');
  assert.equal(plural('Category'), 'Categories');
  assert.equal(plural('Box'), 'Boxes');
  assert.equal(plural('Order'), 'Orders');
  assert.equal(labelField([parseSpec('qty', 'int'), parseSpec('name', 'text!')]), 'name');
  assert.equal(labelField([parseSpec('qty', 'int')]), null);
});

test('simple rule checks become bounds the browser checks; the rest stay the server\'s', () => {
  const b = ruleBounds([{ check: 'price >= 0', message: 'Price cannot be negative' }, { check: 'qty > 0' }, { check: 'end >= start', message: 'x' }]);
  assert.deepEqual(b.price, [{ op: '>=', value: 0, message: 'Price cannot be negative' }]);
  assert.deepEqual(b.qty, [{ op: '>', value: 0, message: 'Qty must be > 0' }]);
  assert.equal(b.end, undefined);
  assert.deepEqual(uniqueFields([{ unique: 'email' }, { unique: ['a', 'b'] }]), ['email']);
});
