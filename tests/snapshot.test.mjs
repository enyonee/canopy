// S3a: derived fields evaluate over a prefetched snapshot (runtime/store/{plan,snapshot,hydrate}.mjs).
// Three gates. (1) The differential: every row of EVERY app under apps/ is hydrated through the
// snapshot path and through the old lazy path (`store.lazyEval`), and the JSON must be byte-identical
// — the safety net against silent semantic drift. (2) Purity: while a derived field is being
// evaluated the driver is never called (`onQuery`), over a list page, a detail page, a CSV export
// and a dashboard. (3) A read that was not loaded throws `not loaded: …`, never queries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { Snapshot } from '../runtime/store/snapshot.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { bootstrapIdentity, bootstrapSeed } from '../runtime/boot.mjs';
import { boot, tmpGraph, freezeClock } from './helpers.mjs';

const NOW = '2026-09-29T12:00:00.000Z';

// Rows for every entity the app's own seed left empty (and a few extra for the seeded ones), in reference
// order, each ref pointing at a row that exists: enough for every hop and aggregate to have something to read.
function populate(store, graph) {
  const refs = (e) => store.fields[e].filter((f) => f.kind === 'ref').map((f) => f.target).filter((t) => t !== e);
  const order = [], seen = new Set();
  const visit = (e) => { if (seen.has(e)) return; seen.add(e); refs(e).forEach(visit); order.push(e); };
  Object.keys(graph.data).forEach(visit);
  const value = (f, i, ids) => {
    switch (f.kind) {
      case 'ref': return ids[f.target]?.length && i % 5 !== 4 ? ids[f.target][i % ids[f.target].length] : undefined;
      case 'enum': return f.options[i % f.options.length];
      case 'int': return (i % 7) - 1;
      case 'money': return ((i % 9) + 1) * 1.25;
      case 'bool': return i % 2 === 0;
      case 'date': return `2026-0${1 + (i % 9)}-1${i % 10}`;
      case 'time': return `2026-0${1 + (i % 9)}-1${i % 10}T0${i % 10}:30:00.000Z`;
      case 'file': case 'image': return undefined;
      default: return `${f.name} ${i}`;
    }
  };
  const ids = {};
  for (const e of order) {
    ids[e] = store.list(e, {}).map((r) => r.id);
    for (let i = 0; i < 8; i++) {
      const row = {};
      for (const f of store.fields[e]) if (!f.derive) row[f.name] = value(f, i, ids);
      try { ids[e].push(store.insert(e, row)); } catch { /* a rule or a required column refused this generated row: fewer rows, same test */ }
    }
  }
}

const errors = [];
const answer = (fn) => { try { return JSON.stringify(fn()); } catch (e) { errors.push(e.message); return `ERROR ${e.message}`; } };

const apps = fs.readdirSync('apps').filter((d) => fs.existsSync(path.join('apps', d, 'app.json'))).sort();

test('every app hydrates byte-identically through the snapshot and through the lazy path', async (t) => {
  t.after(freezeClock(NOW));
  const log = console.log; console.log = () => {};
  let rows = 0, derived = 0;
  try {
    for (const app of apps) {
      const dir = path.join('apps', app), graph = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      const { registry } = await loadPlugins(graph, path.resolve(dir));
      const store = new Store(graph, ':memory:', registry);
      bootstrapIdentity(graph, store);
      bootstrapSeed(graph, store, dir, null);
      populate(store, graph);
      for (const entity of Object.keys(graph.data)) {
        const both = (fn) => { const snap = answer(fn); store.lazyEval = true; try { return [snap, answer(fn)]; } finally { store.lazyEval = false; } };
        const ids = store.listRaw(entity).map((r) => r.id);
        const checks = { list: () => store.list(entity, {}), page: () => store.listPage(entity, {}, { page: 1, pageSize: 3 }),
          count: () => store.count(entity, {}) };
        for (const [name, fn] of Object.entries(checks)) { const [a, b] = both(fn); assert.equal(a, b, `${app}/${entity}: ${name} differs`); }
        for (const id of ids) {
          const [g1, g2] = both(() => store.get(entity, id)); assert.equal(g1, g2, `${app}/${entity}#${id}: get differs`);
          const [l1, l2] = both(() => store.labelOf(entity, id)); assert.equal(l1, l2, `${app}/${entity}#${id}: labelOf differs`);
        }
        rows += ids.length;
        derived += store.fields[entity].filter((f) => f.derive).length * ids.length;
      }
    }
  } finally { console.log = log; }
  assert.ok(apps.length >= 100, `expected the whole apps/ directory, found ${apps.length}`);
  assert.ok(rows > 500 && derived > 500, `the differential must have something to compare: ${rows} rows, ${derived} derived values`);
});

// A graph with everything a derived field can read: hops (one and two), nested derived fields,
// compiled aggregates, one that is not (a division), row.* correlation, an aggregate with no link
// back, today and now, a derived label.
const GRAPH = {
  app: 'purity',
  data: {
    Customer: { name: 'text!', discount: 'money=0', spent: 'money := sum(Order: total)', halves: 'money := sum(Order: total / 2)', orders: 'int := count(Order)' },
    Tag: { name: 'text!' },
    Person: { full: 'text := concat(first, " ", last)', first: 'text!', last: 'text!' },
    Order: {
      customer: 'ref:Customer!', status: 'enum[new,paid]=new', rebate: 'money=0', due: 'date',
      total: 'money := sum(Item: qty * price)',
      net: 'money := total - customer.discount',
      who: 'text := customer.name',
      halves: 'money := sum(Item: (qty * price) / 2)',
      lessRebate: 'money := sum(Item: qty * price - row.rebate)',
      viaRow: 'money := sum(Item: qty * price - row.customer.discount)',
      tags: 'int := count(Tag)',
      late: 'bool := due < today',
      stamp: 'time := now',
      itemNames: 'int := count(Item: len(order.customer.name) > 3)',
    },
    Item: { order: 'ref:Order!', title: 'text!', qty: 'int=1', price: 'money=1',
      cust: 'text := order.customer.name', net: 'money := qty * price - order.customer.discount' },
  },
  dashboards: [{ id: 'main', title: 'Main', cards: [{ title: 'Revenue', entity: 'Order', fn: 'sum', field: 'total' }],
    tables: [{ title: 'By customer', entity: 'Order', groupBy: 'customer', metrics: [{ fn: 'sum', field: 'net', as: 'n', title: 'Net' }] }] }],
  views: 'auto',
};

function seedPurity(store) {
  for (const n of ['a', 'b', 'c']) store.insert('Tag', { name: n });
  store.insert('Person', { first: 'Ann', last: 'Lee' });
  for (let c = 1; c <= 4; c++) {
    const cid = store.insert('Customer', { name: `Customer ${c}`, discount: c });
    for (let o = 0; o < 3; o++) {
      const oid = store.insert('Order', { customer: cid, status: o % 2 ? 'paid' : 'new', rebate: o, due: `2026-0${1 + o * 4}-01` });
      for (let i = 0; i < 2; i++) store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + i, price: 10 + c });
    }
  }
}

test('no driver call while a derived field is evaluated: list page, detail page, CSV and dashboard', async (t) => {
  const s = await boot(tmpGraph(GRAPH));
  t.after(() => s.close());
  const store = s.app.store;
  seedPurity(store);
  let depth = 0, evaluations = 0;
  const derived = Snapshot.prototype.derived;
  Snapshot.prototype.derived = function counted(...a) { depth++; evaluations++; try { return derived.apply(this, a); } finally { depth--; } };
  t.after(() => { Snapshot.prototype.derived = derived; store.drv.onQuery = null; });
  const inside = [], outside = [];
  store.drv.onQuery = (sql) => (depth ? inside : outside).push(sql);
  for (const url of ['/Order', '/Order/1', '/Order.csv', '/Item', '/Item.csv', '/Customer', '/Customer/2', '/dashboard/main', '/Person', '/Person.csv']) {
    const r = await s.get(url);
    assert.equal(r.status, 200, `${url} answers`);
  }
  assert.deepEqual(inside, [], 'the driver was called while evaluate ran');
  assert.ok(outside.length > 10 && evaluations > 100, `the gate must not be vacuous: ${outside.length} queries, ${evaluations} evaluations`);
});

test('a read that was not loaded throws "not loaded", it never queries', () => {
  const store = new Store(GRAPH, ':memory:');
  seedPurity(store);
  const order = store.raw('Order', 1);
  // A snapshot planned for Order.total only: the hop of Order.net, the child rows of Order.halves and the
  // batch of Order.tags were never loaded.
  const snap = store.loadSnapshot('Order', [order], ['total']);
  let queries = 0;
  store.drv.onQuery = () => { queries++; };
  assert.equal(snap.derived('Order', order, store.field('Order', 'total')), 3300);
  assert.throws(() => snap.derived('Order', order, store.field('Order', 'net')), /not loaded: Order\.customer/);
  assert.throws(() => snap.derived('Order', order, store.field('Order', 'halves')), /not loaded: Item\.order/);
  assert.throws(() => snap.derived('Order', order, store.field('Order', 'tags')), /not loaded: Tag\.\*/);
  const bare = new Snapshot(store, new Date());
  assert.throws(() => bare.derived('Order', order, store.field('Order', 'total')), /not loaded: Order\.sum\(Item\)/);
  store.drv.onQuery = null;
  assert.equal(queries, 0, 'a miss must not reach the driver');
});

test('a dangling or empty reference reads as null, like the lazy path', (t) => {
  t.after(freezeClock(NOW));
  const store = new Store(GRAPH, ':memory:');
  seedPurity(store);
  store.drv.run('UPDATE "order" SET "customer"=? WHERE id=1', ['999']);
  store.drv.run('UPDATE "order" SET "customer"=NULL WHERE id=2');
  store.drv.run('UPDATE "order" SET "customer"=? WHERE id=3', ['abc']);
  store.drv.run('UPDATE "order" SET "customer"=? WHERE id=4', ['02']); // the same row as 2, spelled differently
  const snap = JSON.stringify(store.list('Order', {}));
  store.lazyEval = true;
  assert.equal(snap, JSON.stringify(store.list('Order', {})));
  assert.equal(store.get('Order', 1).who, null);
  assert.equal(store.get('Order', 4).who, 'Customer 2', 'a reference is looked up by its number, however it is spelled');
});

// A float sum depends on the order it adds in: the children of a parent arrive ORDER BY id DESC, as the lazy
// path always read them. These integers are chosen so that adding them ascending gives a different double.
test('the children of a non-compilable aggregate are summed in id-descending order, like the lazy path', () => {
  const g = { app: 'order', data: { P: { total: 'int := sum(C: n / 1)' }, C: { p: 'ref:P!', n: 'int' } }, views: 'auto' };
  const store = new Store(g, ':memory:');
  const p = store.insert('P', {});
  for (const n of [1, 1, 1, 9007199254740991]) store.insert('C', { p, n });
  assert.equal(store.get('P', p).total, 9007199254740992);
  assert.equal(store.list('P', {})[0].total, 9007199254740992);
  store.lazyEval = true;
  assert.equal(store.get('P', p).total, 9007199254740992);
});

test('no row is fetched twice while one page loads, however many plan nodes reach it', () => {
  const g = { app: 'dup', data: {
    Customer: { name: 'text!', ohalves: 'money := sum(Order: halves)' },
    Order: { customer: 'ref:Customer!', halves: 'money := sum(Item: (qty * price) / 2)' },
    Item: { order: 'ref:Order!', qty: 'int=1', price: 'money=1', x: 'money := order.halves + order.customer.ohalves' } }, views: 'auto' };
  const store = new Store(g, ':memory:');
  for (let c = 0; c < 3; c++) {
    const cid = store.insert('Customer', { name: `C${c}` });
    for (let o = 0; o < 3; o++) {
      const oid = store.insert('Order', { customer: cid });
      for (let i = 0; i < 2; i++) store.insert('Item', { order: oid, qty: 2, price: 3 });
    }
  }
  const seen = new Map(), repeated = [];
  const note = (sql, params) => {
    const shape = sql.replace(/IN \([^)]*\)/, 'IN (…)');
    if (!seen.has(shape)) seen.set(shape, new Set());
    for (const v of params) { if (seen.get(shape).has(String(v))) repeated.push(`${shape} ${v}`); seen.get(shape).add(String(v)); }
  };
  for (const m of ['all', 'get']) { const orig = store.drv[m]; store.drv[m] = (sql, params = [], opts) => { if (/ IN \(/.test(sql)) note(sql, params); return orig(sql, params, opts); }; }
  const rows = store.list('Item', {});
  assert.equal(rows.length, 18);
  assert.deepEqual(repeated, [], 'a plan node asked again for rows another node had already loaded');
  assert.ok(seen.size >= 4, `the gate must have seen the hop and the group queries: ${[...seen.keys()]}`);
});

test('labelOf on the lazy switch never builds a snapshot, and on the default path it does', () => {
  const store = new Store(GRAPH, ':memory:');
  seedPurity(store);
  const built = [];
  const orig = store.loadSnapshot;
  store.loadSnapshot = function counted(...a) { built.push(a[0]); return orig.apply(this, a); };
  assert.equal(store.labelOf('Person', 1), 'Ann Lee');
  assert.equal(built.length, 1);
  store.lazyEval = true;
  assert.equal(store.labelOf('Person', 1), 'Ann Lee');
  assert.equal(built.length, 1, 'the lazy path derives the label over its own context');
  delete store.loadSnapshot;
});
