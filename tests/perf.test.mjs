// The performance gate (round 7): asserts on *query counts*, never wall time —
// a list page issues the same number of queries whether the table holds 100
// rows or 2000 (item 2's page-before-hydrate and item 3's batched aggregates),
// a detail page's query count does not grow with how many children a row has,
// and a child lookup by a `ref` column actually uses the index item 1 adds.
// `bench/run.mjs` (`npm run bench`) is the wall-clock, informational sibling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';

const BENCH_GRAPH = {
  app: 'bench',
  data: {
    Customer: { name: 'text!', orders: 'int := count(Order)', spent: 'money := sum(Order: total)' },
    Order: { customer: 'ref:Customer!', status: 'enum[new,paid]=new', total: 'money := sum(Item: qty * price)' },
    Item: { order: 'ref:Order!', title: 'text!', qty: 'int=1', price: 'money=1' },
  },
  views: 'auto',
};

// Fills the bench graph with `n` customers, ~4 orders each, ~2 items each.
function seed(store, customers) {
  for (let c = 1; c <= customers; c++) {
    const cid = store.insert('Customer', { name: `Customer ${c}` });
    for (let o = 0; o < 4; o++) {
      const oid = store.insert('Order', { customer: cid, status: o % 2 ? 'paid' : 'new' });
      for (let i = 0; i < 2; i++) store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + i, price: 10 + i });
    }
  }
}

// Counts every query the store issues (Store#prepare — every read/write call
// site prepares immediately before executing, so this is exactly "how many
// round trips to SQLite this operation made", cache hit or not).
function withQueryCount(store, fn) {
  let n = 0;
  const orig = store.prepare;
  store.prepare = function counted(sql) { n++; return orig.call(this, sql); };
  try { fn(); } finally { store.prepare = orig; }
  return n;
}

test('a list page issues the same number of queries at 100 rows and at 2000', () => {
  const small = new Store(BENCH_GRAPH, ':memory:');
  seed(small, 25); // 25 customers * 4 orders = 100 orders
  const big = new Store(BENCH_GRAPH, ':memory:');
  seed(big, 500); // 500 * 4 = 2000 orders

  const pageOf = (store) => withQueryCount(store, () => store.listPage('Order', {}, { page: 1, pageSize: 50 }));
  const n100 = pageOf(small), n2000 = pageOf(big);
  assert.equal(n100, n2000, `Order list issued ${n100} queries at 100 rows but ${n2000} at 2000 — not O(1)`);
  assert.ok(n100 <= 5, `Order list issued ${n100} queries for one page — expected a small constant`);

  const customerPage = (store) => withQueryCount(store, () => store.listPage('Customer', {}, { page: 1, pageSize: 50 }));
  const c100 = customerPage(small), c2000 = customerPage(big);
  assert.equal(c100, c2000, `Customer list issued ${c100} queries at 100 rows but ${c2000} at 2000 — not O(1)`);
  // Customer.spent is a *nested* aggregate (sum(Order: total), and total is
  // itself sum(Item: qty*price)) — a small constant here means the second hop
  // (Order → Item) was prefetched too, not just the first (Customer → Order).
  assert.ok(c100 <= 6, `Customer list issued ${c100} queries for one page — expected a small constant even through a nested aggregate`);
});

// Customer.spent compiles to SQL now (runtime/store/aggsql.mjs), so it no longer needs the prefetch
// below. `half` divides — never compiled — and still batches raw Orders, then must recurse into
// Order so that Order.total (a compiled aggregate of its own) is answered per page, not per order.
test('a non-compilable aggregate over a derived aggregate still batches every level, in O(1) queries', () => {
  const graph = { ...BENCH_GRAPH, data: { ...BENCH_GRAPH.data, Customer: { name: 'text!', half: 'money := sum(Order: total / 2)' } } };
  const small = new Store(graph, ':memory:');
  seed(small, 25);
  const big = new Store(graph, ':memory:');
  seed(big, 500);
  const page = (store) => withQueryCount(store, () => store.listPage('Customer', {}, { page: 1, pageSize: 50 }));
  const c100 = page(small), c2000 = page(big);
  assert.equal(c100, c2000, `Customer list issued ${c100} queries at 100 rows but ${c2000} at 2000 — not O(1)`);
  assert.ok(c100 <= 6, `expected a small constant through the nested aggregate, got ${c100}`);
});

test('CSV export (hydrates every matching row) still issues O(1) queries, not one per row', () => {
  const small = new Store(BENCH_GRAPH, ':memory:');
  seed(small, 25);
  const big = new Store(BENCH_GRAPH, ':memory:');
  seed(big, 500);
  const all = (store) => withQueryCount(store, () => store.list('Order', {}));
  const n100 = all(small), n2000 = all(big);
  assert.equal(n100, n2000, `store.list issued ${n100} queries at 100 rows but ${n2000} at 2000 — not O(1)`);
});

test('a dashboard aggregate over a derived field batches instead of hydrating row by row', () => {
  const small = new Store(BENCH_GRAPH, ':memory:');
  seed(small, 25);
  const big = new Store(BENCH_GRAPH, ':memory:');
  seed(big, 500);
  // Order.total is derived, so this forces store.aggregateInMemory — the exact
  // path the orchestrator's /dashboard measurement found hydrating every row.
  const grouped = (store) => withQueryCount(store, () => store.aggregate('Order', { groupBy: 'status', metrics: [{ fn: 'sum', field: 'total', as: 'v' }] }));
  const n100 = grouped(small), n2000 = grouped(big);
  assert.equal(n100, n2000, `dashboard aggregate issued ${n100} queries at 100 rows but ${n2000} at 2000 — not O(1)`);
});

test('a detail page issues the same number of queries whether the row has 2 children or 2000', () => {
  const store = new Store(BENCH_GRAPH, ':memory:');
  const c = store.insert('Customer', { name: 'Solo' });
  const few = store.insert('Order', { customer: c, status: 'new' });
  store.insert('Item', { order: few, title: 'a', qty: 1, price: 1 });
  store.insert('Item', { order: few, title: 'b', qty: 1, price: 1 });
  const many = store.insert('Order', { customer: c, status: 'new' });
  for (let i = 0; i < 2000; i++) store.insert('Item', { order: many, title: `i${i}`, qty: 1, price: 1 });

  const nFew = withQueryCount(store, () => store.get('Order', few));
  const nMany = withQueryCount(store, () => store.get('Order', many));
  assert.equal(nFew, nMany, `detail read issued ${nFew} queries for 2 children but ${nMany} for 2000`);
});

test('a child lookup by its ref column uses the index item 1 adds', () => {
  const store = new Store(BENCH_GRAPH, ':memory:');
  const c = store.insert('Customer', { name: 'Ann' });
  const o = store.insert('Order', { customer: c, status: 'new' });
  store.insert('Item', { order: o, title: 'x', qty: 1, price: 1 });
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM "item" WHERE "order" IN (?)`).all(String(o));
  assert.ok(plan.some((r) => /USING INDEX idx_item_order/.test(r.detail)), `expected idx_item_order in the plan, got: ${JSON.stringify(plan)}`);
  const planOrder = store.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM "order" WHERE "customer" IN (?)`).all(String(c));
  assert.ok(planOrder.some((r) => /USING INDEX idx_order_customer/.test(r.detail)), `expected idx_order_customer in the plan, got: ${JSON.stringify(planOrder)}`);
});

test('batched hydration matches per-row hydration exactly, on random data (property test)', () => {
  // A tiny seeded PRNG (mulberry32) — deterministic, so a failure is reproducible.
  let seed32 = 0x2026_0928;
  const rand = () => { seed32 |= 0; seed32 = (seed32 + 0x6D2B79F5) | 0; let t = Math.imul(seed32 ^ (seed32 >>> 15), 1 | seed32); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  // Item C: 0.1/0.2/0.7-shaped money values are exactly where float summation
  // order shows up in the last digit — mixed in among ordinary random prices,
  // over enough rows per order that a wrong accumulation order has a real
  // chance to round differently.
  const TRICKY = [0.1, 0.2, 0.7, 1.1, 2.2, 0.3, 0.01, 99.99];
  const price = () => (rand() < 0.4 ? TRICKY[Math.floor(rand() * TRICKY.length)] : Number((1 + rand() * 99).toFixed(2)));
  const store = new Store(BENCH_GRAPH, ':memory:');
  const customers = [];
  for (let c = 0; c < 40; c++) customers.push(store.insert('Customer', { name: `C${c}` }));
  const orders = [];
  for (let o = 0; o < 150; o++) {
    const oid = store.insert('Order', { customer: customers[Math.floor(rand() * customers.length)], status: rand() < 0.5 ? 'new' : 'paid' });
    orders.push(oid);
  }
  for (let i = 0; i < 4000; i++) {
    store.insert('Item', { order: orders[Math.floor(rand() * orders.length)], title: `I${i}`, qty: 1 + Math.floor(rand() * 5), price: price() });
  }

  for (const entity of ['Order', 'Customer']) {
    const raw = store.listRaw(entity, {});
    const perRow = raw.map((r) => store.hydrate(entity, r));
    const batched = store.hydratePage(entity, raw);
    assert.deepEqual(batched, perRow, `${entity}: batched hydration differs from per-row hydration`);
  }
});

// --- item A: a ref label must never hydrate the whole target row -----------
test('a ref label reads only the label field, never the target row\'s other derived fields (item A)', () => {
  const store = new Store(BENCH_GRAPH, ':memory:');
  const c = store.insert('Customer', { name: 'Solo' });
  for (let i = 0; i < 50; i++) {
    const o = store.insert('Order', { customer: c, status: 'new' });
    store.insert('Item', { order: o, title: 'x', qty: 1, price: 1 });
  }
  let derivedCalls = 0;
  const orig = store.derived;
  store.derived = function counted(...args) { derivedCalls++; return orig.apply(this, args); };
  let label;
  try { label = store.labelOf('Customer', c); } finally { store.derived = orig; }
  assert.equal(label, 'Solo');
  // Customer.orders/spent are both derived and both expensive (they aggregate
  // every one of this customer's orders) — labelOf must touch neither, only
  // "name", which is a plain stored field here.
  assert.equal(derivedCalls, 0, `labelOf ran ${derivedCalls} derived-field computations to read a plain stored label`);
});

// --- item B: an IN-list past SQLite's bound-parameter limit must not fail --
test('listRawIn chunks the IN-list instead of binding every id in one query (item B)', () => {
  const store = new Store(BENCH_GRAPH, ':memory:');
  let prepares = 0;
  const orig = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => { prepares++; return orig(sql); };
  const ids = Array.from({ length: 12000 }, (_, i) => i + 1); // synthetic — no matching rows needed
  let rows;
  try { rows = store.listRawIn('Item', 'order', ids); } finally { store.db.prepare = orig; }
  assert.deepEqual(rows, []);
  assert.equal(prepares, 3, `expected ceil(12000/5000)=3 chunked queries, got ${prepares}`);
});

test('a page of more than 32766 parent ids does not fail (item B, bulk insert)', () => {
  const store = new Store({ app: 'big', data: {
    Parent: { name: 'text!', n: 'int := count(Child)' }, Child: { parent: 'ref:Parent!' },
  }, views: 'auto' }, ':memory:');
  const N = 35000;
  store.transaction(() => { for (let i = 0; i < N; i++) store.insert('Parent', { name: `p${i}` }); });
  const rows = store.list('Parent', {}); // one hydratePage() call, ids.length === N
  assert.equal(rows.length, N);
  assert.ok(rows.every((r) => r.n === 0), 'no Child rows exist — every count must still come back 0, not throw');
});

// --- item C: batched children must follow the unbatched path's own order ---
test('batched children are grouped in the same order the unbatched path reads them (item C)', () => {
  // `half` divides, so it is never compiled to SQL (runtime/store/aggsql.mjs) and still batches raw children.
  const store = new Store({ ...BENCH_GRAPH, data: { ...BENCH_GRAPH.data, Customer: { ...BENCH_GRAPH.data.Customer, half: 'money := sum(Order: total / 2)' } } }, ':memory:');
  const c = store.insert('Customer', { name: 'Ann' });
  for (let i = 0; i < 30; i++) store.insert('Order', { customer: c, status: 'new' });
  const cache = store.buildAggCache('Customer', [c]);
  const grouped = cache.groups.get('Order|customer').get(String(c)).map((r) => r.id);
  const unbatched = store.listRaw('Order', { where: { customer: c } }).map((r) => r.id);
  assert.ok(grouped.length === 30 && unbatched.length === 30);
  assert.deepEqual(grouped, unbatched, 'batched grouping must preserve the unbatched (ORDER BY id DESC) order');
});
