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
import { createInterpreter } from '../runtime/interp.mjs';
import { DEFAULT } from '../runtime/registry.mjs';
import { Snapshot } from '../runtime/store/snapshot.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { bootstrapIdentity, bootstrapSeed } from '../runtime/boot.mjs';
import { boot, tmpGraph, freezeClock, populate } from './helpers.mjs';

const NOW = '2026-09-29T12:00:00.000Z';

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

// --- S3b: rules and step values evaluate over a snapshot too ---------------------------------------------------------
// While a rule check or a step value is evaluated the driver is never called. `evaluating` counts the depth of the
// snapshot context's entry points (get/rows/agg: everything evaluate() calls, and everything they call in turn), so a
// query inside it is a query made while evaluate runs; loads happen before, outside.
const SnapCtx = Object.getPrototypeOf(new Snapshot(new Store(GRAPH, ':memory:'), new Date()).ctx('Order', {}, []));

function watch(t, store) {
  const seen = { depth: 0, inside: [], outside: [], evaluations: 0, log: [] };
  const originals = {};
  for (const m of ['get', 'rows', 'agg']) {
    originals[m] = SnapCtx[m];
    SnapCtx[m] = function counted(...a) { seen.depth++; seen.evaluations++; try { return originals[m].apply(this, a); } finally { seen.depth--; } };
  }
  store.drv.onQuery = (sql) => { seen.log.push(sql); (seen.depth ? seen.inside : seen.outside).push(sql); };
  t.after(() => { for (const m of Object.keys(originals)) SnapCtx[m] = originals[m]; store.drv.onQuery = null; });
  return seen;
}

const RULES_GRAPH = {
  app: 'rulepure',
  data: {
    Customer: { name: 'text!', credit: 'money=100', vip: 'bool=false', open: 'money := sum(Order: total)', n: 'int := count(Order)' },
    Order: {
      customer: 'ref:Customer!', qty: 'int=1', rebate: 'money=0', due: 'date', note: 'text',
      total: 'money := sum(Item: qty * price)', late: 'bool := due < today',
    },
    Item: { order: 'ref:Order!', qty: 'int=1', price: 'money=1' },
  },
  rules: {
    Order: [
      { check: 'customer.name != "banned"', message: 'customer is banned' },
      { check: 'customer.open + total <= customer.credit', message: 'over the credit limit' },
      { check: 'count(Item) < 4', message: 'too many items' },
      { check: 'sum(Item: (qty * price) / 2 - row.rebate) < 500', message: 'too big after the rebate' },
      { check: 'due >= today or qty > 0', message: 'due date is past' },
      { check: 'customer.vip or qty < 50', message: 'only vips order fifty' },
      { check: 'now != ""', message: 'the clock is broken' },
      { unique: ['customer', 'due'], message: 'one order per customer per day' },
    ],
  },
  views: 'auto',
};

test('no driver call while a rule is evaluated: hops, aggregates, derived fields, row.*, today and now', (t) => {
  t.after(freezeClock(NOW));
  const store = new Store(RULES_GRAPH, ':memory:');
  const a = store.insert('Customer', { name: 'Ann', credit: 100 });
  const b = store.insert('Customer', { name: 'banned', credit: 100, vip: true });
  const seen = watch(t, store);
  const outcome = (fn) => { try { return { id: fn() }; } catch (e) { return { error: e.message }; } };
  const first = outcome(() => store.insert('Order', { customer: a, qty: 2, due: '2026-10-01' }));
  assert.ok(first.id, 'a plain order is accepted');
  for (let i = 0; i < 3; i++) store.insert('Item', { order: first.id, qty: 1, price: 10 });
  assert.deepEqual(outcome(() => store.insert('Order', { customer: b, qty: 1, due: '2026-10-02' })), { error: 'customer is banned' });
  assert.deepEqual(outcome(() => store.insert('Order', { customer: a, qty: 99, due: '2026-10-03' })), { error: 'only vips order fifty' });
  assert.deepEqual(outcome(() => store.insert('Order', { customer: a, qty: 2, due: '2026-10-01' })), { error: 'one order per customer per day' });
  // The probe of an update is the stored row with the new values over it: the aggregates read the row's own items.
  assert.deepEqual(outcome(() => store.update('Order', first.id, { rebate: 1 })), { id: undefined });
  assert.deepEqual(outcome(() => store.update('Order', first.id, { customer: b })), { error: 'customer is banned' });
  assert.deepEqual(outcome(() => store.update('Order', first.id, { rebate: -1000 })), { error: 'too big after the rebate' });
  assert.equal(store.checkRules('Order', { customer: a, qty: 1 }, null).length, 0);
  assert.equal(store.checkRules('Order', { customer: a, qty: 1, due: '2020-01-01' }, null).length, 0, 'qty > 0 lets a past date pass');
  assert.deepEqual(store.checkRules('Order', { customer: a, qty: 0, due: '2020-01-01' }, null), ['due date is past']);
  assert.deepEqual(seen.inside, [], 'the driver was called while a rule was evaluated');
  assert.ok(seen.outside.length > 10 && seen.evaluations > 30, `the gate must not be vacuous: ${seen.outside.length} queries, ${seen.evaluations} evaluations`);
});

test('a rule reads an item this very transaction wrote (the load happens where the rule runs)', (t) => {
  const store = new Store(RULES_GRAPH, ':memory:');
  const c = store.insert('Customer', { name: 'Ann', credit: 100 });
  const o = store.insert('Order', { customer: c, qty: 1, due: '2026-10-01' });
  const seen = watch(t, store);
  assert.throws(() => store.transaction(() => {
    for (let i = 0; i < 4; i++) store.insert('Item', { order: o, qty: 1, price: 1 });
    store.update('Order', o, { rebate: 0 });
  }), /too many items/);
  assert.equal(seen.log[0], 'BEGIN');
  assert.ok(seen.log.length > 4 && seen.log.at(-1) === 'ROLLBACK', 'the loads of the rule sit inside the transaction');
});

// A rule's parse failure is a crash, not a failed rule — before and after S3b.
test('a rule that does not parse still throws out of the write', () => {
  const g = { app: 'bad', data: { T: { n: 'int' } }, rules: { T: [{ check: 'n >', message: 'x' }] }, views: 'auto' };
  const store = new Store(g, ':memory:');
  assert.throws(() => store.insert('T', { n: 1 }), (e) => e.message !== 'x', 'the parse error, not the rule\'s message');
});

const STEPS_GRAPH = {
  app: 'steppure',
  connectors: { mail: { kind: 'mail', from: 'shop@example.test' }, hook: { kind: 'http', url: 'http://127.0.0.1:1/hook' } },
  data: {
    Customer: { name: 'text!', discount: 'money=0', spent: 'money := sum(Order: total)' },
    Order: { customer: 'ref:Customer!', note: 'text', rebate: 'money=0', total: 'money := sum(Item: qty * price)', net: 'money := total - customer.discount' },
    Item: { order: 'ref:Order!', qty: 'int=1', price: 'money=1' },
  },
  actions: [{ name: 'price', in: 'Order', do: [
    { block: 'db.createRow', entity: 'Item', values: { order: '@row.id', qty: 2, price: 5 } },
    { block: 'db.update', set: { note: '= concat(customer.name, ":", total, ":", net, ":", today)', rebate: '= if(total > 5, sum(Item: qty * price - row.rebate) / 2, 0)' } },
    { block: 'mail.send', connector: 'mail', to: 'a@b.test', subject: 'Order {row.id} for {row.customer.name}', text: 'Total {row.total}, net {row.net}, spent {row.customer.spent}, {created} {values.x}' },
    { block: 'http.send', connector: 'hook', body: { total: '@row.total', who: '@row.customer.name', twice: '= total * 2', me: '@me' } },
  ] }],
  events: [{ on: 'Item.created', do: [{ block: 'db.set', entity: 'Order', id: '@row.order', set: { note: '= concat("item ", qty, " of ", order.customer.name)' } }] }],
  views: 'auto',
};

async function runPrice(store, id) {
  const interp = createInterpreter({ graph: STEPS_GRAPH, store, registry: DEFAULT, perms: {}, meId: 7, fetchImpl: async () => ({ ok: true, status: 200 }) });
  await interp.attempt(() => interp.runSteps(STEPS_GRAPH.actions[0].do, { rowEntity: 'Order', id, values: { x: 'v' }, user: null }));
  return interp;
}

function seedSteps(store) {
  const c = store.insert('Customer', { name: 'Ann', discount: 3 });
  const o = store.insert('Order', { customer: c });
  store.insert('Item', { order: o, qty: 1, price: 4 });
  return o;
}

test('no driver call while a step value is evaluated: set, if, interpolated text, http body, event steps', async (t) => {
  t.after(freezeClock(NOW));
  const store = new Store(STEPS_GRAPH, ':memory:');
  const o = seedSteps(store);
  const seen = watch(t, store);
  const interp = await runPrice(store, o);
  store.transaction(() => interp.fireEvents('created', 'Item', 2, {}, null, null));
  assert.equal(store.get('Order', o).note, 'item 2 of Ann', 'an event step reads the row it fired on');
  assert.deepEqual(seen.inside, [], 'the driver was called while a step value was evaluated');
  assert.ok(seen.outside.length > 10 && seen.evaluations > 10, `the gate must not be vacuous: ${seen.outside.length} queries, ${seen.evaluations} evaluations`);
  assert.equal(seen.log[0], 'BEGIN', 'the steps run in a transaction…');
  const commit = seen.log.indexOf('COMMIT');
  assert.ok(commit > 10, '…and every load of a step value sits inside it');
  // The values are the same as over the lazy context, and a later step sees an earlier step's write.
  const mail = store.outbox().find((r) => r.kind === 'mail').payload;
  const hook = store.outbox().find((r) => r.kind === 'http').payload;
  const lazy = new Store(STEPS_GRAPH, ':memory:');
  lazy.lazyEval = true;
  await runPrice(lazy, seedSteps(lazy));
  assert.deepEqual(store.outbox().map((r) => r.payload), lazy.outbox().map((r) => r.payload));
  assert.equal(lazy.get('Order', o).note, 'Ann:14:11:2026-09-29', 'the update after the item sees it in total and net');
  assert.equal(mail.subject, `Order ${o} for Ann`);
  assert.equal(mail.text, 'Total 14.00, net 11.00, spent 14.00, 2 v', 'the item the first step created is in the sum the mail reads');
  assert.deepEqual(hook, { total: 14, who: 'Ann', twice: 28, me: 7 });
});

test('interpolate loads before it formats: no driver call inside String#replace', (t) => {
  const store = new Store(STEPS_GRAPH, ':memory:');
  const o = seedSteps(store);
  const interp = createInterpreter({ graph: STEPS_GRAPH, store, registry: DEFAULT, perms: {}, meId: 7 });
  const replace = String.prototype.replace;
  let inReplace = 0;
  String.prototype.replace = function wrapped(pattern, how) { // eslint-disable-line no-extend-native
    if (typeof how !== 'function') return replace.call(this, pattern, how);
    return replace.call(this, pattern, (...a) => { inReplace++; try { return how(...a); } finally { inReplace--; } });
  };
  t.after(() => { String.prototype.replace = replace; store.drv.onQuery = null; }); // eslint-disable-line no-extend-native
  const ctx = { rowEntity: 'Order', id: o, row: store.get('Order', o), values: {} };
  const inside = [], outside = [];
  store.drv.onQuery = (sql) => (inReplace ? inside : outside).push(sql);
  assert.equal(interp.interpolate('{row.customer.name} owes {row.net} ({row.total}) {nobody}', ctx), 'Ann owes 1.00 (4.00) ');
  assert.deepEqual(inside, [], 'a query ran inside String#replace');
  assert.ok(outside.length >= 3, `the values were loaded, before the replace: ${outside.length} queries`);
});

// A step reads what the steps before it wrote: nothing is loaded once per action and kept.
test('a step value is loaded when it is resolved: a later step sees an earlier step\'s write', async () => {
  const g = { ...STEPS_GRAPH, actions: [{ name: 'twice', in: 'Order', do: [
    { block: 'http.send', connector: 'hook', body: { at: 'before', total: '@row.total', again: '= total', spent: '@row.customer.spent' } },
    { block: 'db.createRow', entity: 'Item', values: { order: '@row.id', qty: 1, price: 6 } },
    { block: 'http.send', connector: 'hook', body: { at: 'after', total: '@row.total', again: '= total', spent: '@row.customer.spent' } },
  ] }] };
  const store = new Store(g, ':memory:');
  const o = seedSteps(store);
  const interp = createInterpreter({ graph: g, store, registry: DEFAULT, perms: {}, meId: 7, fetchImpl: async () => ({ ok: true, status: 200 }) });
  await interp.attempt(() => interp.runSteps(g.actions[0].do, { rowEntity: 'Order', id: o, values: {}, user: null }));
  assert.deepEqual(store.outbox().map((r) => r.payload).reverse(), [
    { at: 'before', total: 4, again: 4, spent: 4 },
    { at: 'after', total: 10, again: 10, spent: 10 },
  ]);
});

// The plan of a path is cached per entity: the same path on two entities is two plans.
test('one path read on two entities plans each of them', () => {
  const g = { app: 'two', data: { A: { c: 'ref:C!', x: 'int := count(C)' }, B: { c: 'ref:C!', x: 'int := customer.y', customer: 'ref:C' }, C: { y: 'int=3' } }, views: 'auto' };
  const store = new Store(g, ':memory:');
  store.insert('C', {});
  const a = store.insert('A', { c: 1 }), b = store.insert('B', { c: 1, customer: 1 });
  const interp = createInterpreter({ graph: g, store, registry: DEFAULT, perms: {}, meId: 1 });
  const ctx = (entity, id) => ({ rowEntity: entity, id, row: store.get(entity, id), values: {} });
  assert.equal(interp.resolve(ctx('A', a))('@row.x'), 1);
  assert.equal(interp.resolve(ctx('B', b))('@row.x'), 3);
  assert.equal(interp.resolve(ctx('A', a))('= x'), 1);
  assert.equal(interp.resolve(ctx('B', b))('= x'), 3);
});

// The store loads once per check, however many rules it has, and not at all when no rule is a check.
test('checkRules builds one context per write — and none for a write that only meets unique rules', () => {
  const store = new Store({ ...RULES_GRAPH, rules: { ...RULES_GRAPH.rules, Tag: [{ unique: 'name', message: 'taken' }] }, data: { ...RULES_GRAPH.data, Tag: { name: 'text!' } } }, ':memory:');
  const c = store.insert('Customer', { name: 'Ann' });
  let built = 0;
  const evalCtx = store.evalCtx;
  store.evalCtx = function counted(...a) { built++; return evalCtx.apply(this, a); };
  store.insert('Order', { customer: c, qty: 1, due: '2026-10-01' });
  assert.equal(built, 1, 'seven check rules, one context');
  store.insert('Tag', { name: 'x' });
  assert.equal(built, 1, 'a unique rule reads the driver itself, it needs no context');
});

// `store.lazyEval` is the old path: rules and steps evaluate over the lazy RowCtx there (and its expressions
// have no compiled aggregates), so the differential of tests/evaldiff.test.mjs compares two different things.
test('on the lazy switch rules and step values evaluate over the lazy context', async () => {
  const store = new Store(STEPS_GRAPH, ':memory:');
  const o = seedSteps(store);
  const interp = createInterpreter({ graph: STEPS_GRAPH, store, registry: DEFAULT, perms: {}, meId: 7 });
  const ctx = { rowEntity: 'Order', id: o, row: store.get('Order', o), values: {} };
  const aggs = [];
  const aggValue = store.aggValue;
  store.aggValue = function spied(...a) { aggs.push(a[2].fn); return aggValue.apply(this, a); };
  assert.equal(interp.resolve(ctx)('= sum(Item: qty * price)'), 4);
  assert.deepEqual(aggs, [], 'the snapshot path answers a compiled aggregate from its batch');
  store.lazyEval = true;
  assert.ok(store.evalCtx('Order', ctx.row, 'k', [], false).constructor.name === 'RowCtx', 'the lazy switch hands out the lazy context');
  assert.equal(interp.resolve(ctx)('= sum(Item: qty * price)'), 4);
  assert.deepEqual(aggs, [], 'an expression of the old context walks the child rows, it never asks for a compiled aggregate');
  assert.equal(interp.resolve(ctx)('@row.customer.spent'), 4);
});

// today/now of an expression and of the aggregates it binds are one clock: the one its snapshot was loaded with.
test('a step expression reads the clock its snapshot was loaded with', (t) => {
  const store = new Store(STEPS_GRAPH, ':memory:');
  const o = seedSteps(store);
  const interp = createInterpreter({ graph: STEPS_GRAPH, store, registry: DEFAULT, perms: {}, meId: 7 });
  const ctx = { rowEntity: 'Order', id: o, row: store.get('Order', o), values: {} };
  const loaded = [], evalCtx = store.evalCtx;
  store.evalCtx = function spied(...a) { const c = evalCtx.apply(this, a); loaded.push(c.clock); return c; };
  const Real = globalThis.Date;
  let day = 0; // every reading of the clock is a day later than the one before
  globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [Real.UTC(2026, 8, 29 + day++)])); } };
  t.after(() => { globalThis.Date = Real; });
  const today = interp.resolve(ctx)('= today');
  assert.equal(loaded.length, 1);
  assert.equal(today, loaded[0].toISOString().slice(0, 10), 'evaluate() read a clock of its own');
});
