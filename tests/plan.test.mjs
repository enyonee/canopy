// S3a: the read-set planner (runtime/store/plan.mjs) is pure — graph in, tree of hops and aggregates
// out, no driver call and no row. These are its unit tests; the differential and the purity gate
// (tests/snapshot.test.mjs) prove the plan is enough.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { planFor } from '../runtime/store/plan.mjs';

const GRAPH = {
  app: 'plan',
  data: {
    Region: { name: 'text!', boss: 'ref:Region', bossName: 'text := boss.name' },
    Customer: { name: 'text!', region: 'ref:Region', discount: 'money=0', orders: 'int := count(Order)', halves: 'money := sum(Order: total / 2)' },
    Order: { customer: 'ref:Customer!', rebate: 'money=0',
      total: 'money := sum(Item: qty * price)',
      net: 'money := total - customer.discount',
      where: 'text := customer.region.name',
      mine: 'money := sum(Item: qty * price - row.rebate)',
      nested: 'int := count(Item: count(Item) > 0)',
      cheap: 'bool := total < customer.discount and customer.orders > 1' },
    Item: { order: 'ref:Order!', qty: 'int=1', price: 'money=1', cust: 'text := order.customer.name' },
    Loose: { n: 'int := count(Item)' },
  },
  views: 'auto',
};
const store = () => new Store(GRAPH, ':memory:');
const hops = (node) => [...node.hops.keys()];

test('a plan follows each reference hop one level at a time, through derived fields', () => {
  const s = store();
  const item = planFor(s, 'Item', ['cust']);
  assert.deepEqual(hops(item), ['order']);
  const order = item.hops.get('order');
  assert.equal(order.entity, 'Order');
  assert.deepEqual(hops(order), ['customer']);
  assert.equal(order.hops.get('customer').entity, 'Customer');
  // Order.where reads customer.region.name: two levels below Order.
  const w = planFor(s, 'Order', ['where']);
  assert.deepEqual(hops(w.hops.get('customer')), ['region']);
});

test('a plan is the closure of the derived fields: Order.net needs Order.total\'s aggregate and the customer hop', () => {
  const s = store();
  const net = planFor(s, 'Order', ['net']);
  assert.deepEqual(hops(net), ['customer']);
  const aggs = [...net.aggs.values()];
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0].child, 'Item');
  assert.ok(aggs[0].compiled, 'sum(Item: qty * price) compiles: nothing else to load');
  assert.equal(aggs[0].sub, null);
  assert.deepEqual([...planFor(s, 'Order', ['total']).hops.keys()], [], 'a field with no hop plans none');
});

test('an aggregate that does not compile plans the child rows and its body inside them', () => {
  const s = store();
  const halves = [...planFor(s, 'Customer', ['halves']).aggs.values()][0];
  assert.equal(halves.compiled, null);
  assert.equal(halves.via, 'customer');
  assert.equal(halves.sub.entity, 'Order');
  // total is derived on Order: its aggregate is planned in the child node, not in the customer's.
  assert.equal([...halves.sub.aggs.values()][0].child, 'Item');
});

test('row.* inside a body reads the enclosing row: its fields are planned on the outer node', () => {
  const s = store();
  const mine = planFor(s, 'Order', ['mine']);
  const entry = [...mine.aggs.values()][0];
  assert.equal(entry.compiled, null, 'row.* is never compiled');
  assert.equal(entry.sub.entity, 'Item');
  assert.deepEqual(hops(entry.sub), [], 'the body reads Item fields and row.rebate, no hop');
});

test('an aggregate inside another aggregate\'s body is planned over rows, never compiled (evaluate gives a body no agg hook)', () => {
  const s = store();
  const nested = [...planFor(s, 'Order', ['nested']).aggs.values()][0];
  const inner = [...nested.sub.aggs.values()][0];
  assert.equal(inner.compiled, null);
  assert.equal(inner.sub.entity, 'Item');
});

test('an aggregate with no link back plans every row of its child', () => {
  const s = store();
  const loose = [...planFor(s, 'Loose', ['n']).aggs.values()][0];
  assert.equal(loose.via, null);
  assert.equal(loose.compiled, null);
  assert.equal(loose.sub.entity, 'Item');
});

test('plans are cached per store, by entity and field list', () => {
  const s = store();
  assert.equal(planFor(s, 'Order', ['net']), planFor(s, 'Order', ['net']));
  assert.notEqual(planFor(s, 'Order', ['net']), planFor(s, 'Order', null));
  assert.notEqual(planFor(s, 'Order', ['net']), planFor(store(), 'Order', ['net']));
  const all = planFor(s, 'Order', null);
  assert.deepEqual(hops(all), ['customer']);
  assert.equal(all.aggs.size, 3, "total, mine and nested: a derived field is expanded once per node");
});

test('a cycle is cut where evaluation cuts it; the plan terminates and the error text is unchanged', () => {
  const g = { app: 'c', data: {
    Node: { parent: 'ref:Node', x: 'int := y + 1', y: 'int := x + 1', up: 'int := parent.up + 1' }, }, views: 'auto' };
  const s = new Store(g, ':memory:');
  const root = planFor(s, 'Node', null);
  assert.ok(root.hops.has('parent'));
  const a = s.insert('Node', {});
  assert.throws(() => s.get('Node', a), /derived field Node\.x depends on itself \(Node\.x → Node\.y → Node\.x\)/);
  const only = new Store({ app: 'c', data: { Node: { parent: 'ref:Node', up: 'int := parent.up + 1' } }, views: 'auto' }, ':memory:');
  const r = only.insert('Node', {});
  assert.equal(only.get('Node', r).up, null, 'no parent: the hop reads null before any cycle is met');
  const child = only.insert('Node', { parent: r });
  assert.throws(() => only.get('Node', child), /derived field Node\.up depends on itself \(Node\.up → Node\.up\)/);
});

test('a lookup that fails (an ambiguous link) is left to evaluation: the plan neither throws nor loads it', () => {
  const g = { app: 'amb', data: {
    A: { n: 'int=0', maybe: 'bool := n > 0 and count(C) > 0' },
    C: { first: 'ref:A', second: 'ref:A' } }, views: 'auto' };
  const s = new Store(g, ':memory:');
  const a = s.insert('A', {});
  assert.doesNotThrow(() => planFor(s, 'A', null));
  assert.equal(s.get('A', a).maybe, 0, 'the ambiguous branch is never reached');
  const b = s.insert('A', { n: 1 });
  assert.throws(() => s.get('A', b), /C references A through first and second; name one: C\.first/);
  s.lazyEval = true;
  assert.throws(() => s.get('A', b), /C references A through first and second; name one: C\.first/);
});
