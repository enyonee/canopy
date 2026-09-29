// R8 item 1: SQL-compiled aggregates (runtime/store/aggsql.mjs, wired through
// runtime/store/hydrate.mjs and Store#ctx's `agg` hook). The gate here is not
// "the SQL path runs" but "the SQL path and the JS path agree, always" — a
// differential property test drives both paths over the same random data and
// diffs the results, plus targeted tests for every documented fallback case
// (division, fractional literals, dates, text comparisons, correlated `row.`,
// derived bodies) and for query counts (the actual point of item 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { parse } from '../runtime/expr.mjs';
import { compileAgg, runAggOne, runAggBatch } from '../runtime/store/aggsql.mjs';
import { compilerOff } from './helpers.mjs';

const GRAPH = {
  app: 'aggsql',
  data: {
    Parent: {
      name: 'text!', flag: 'bool=false',
      total: 'money := sum(Child: qty * price)',
      totalIf: 'money := sum(Child: if(active, qty * price, 0))',
      avgPrice: 'money := avg(Child: price)',
      maxPrice: 'money := max(Child: price)',
      minPrice: 'money := min(Child: price)',
      n: 'int := count(Child)',
      activeCount: 'int := count(Child: active)',
      bigCount: 'int := count(Child: qty > 2)',
      discCmp: 'int := count(Child: price > discount)',
      sumPlus: 'money := sum(Child: price + 1)',
      sumMinus: 'money := sum(Child: price - qty)',
      andCount: 'int := count(Child: active and qty > 2)',
      orCount: 'int := count(Child: active or qty > 2)',
      notCmp: 'int := count(Child: not(price > discount))',
      divBody: 'money := sum(Child: price / 2)',
      fracLit: 'money := sum(Child: price * 1.5)',
      dateBody: 'date := max(Child: when)',
      dateCount: "int := count(Child: when > '2026-01-01')",
      correlated: 'money := sum(Child: if(row.flag, price, 0))',
      textCmp: 'int := count(Child: label = "x")',
      hopBody: 'money := sum(Child: parent.flag)',
    },
    Child: {
      parent: 'ref:Parent!', qty: 'int=1', price: 'money=1', discount: 'money',
      active: 'bool=false', when: 'date=today', label: 'text=""',
    },
  },
  views: 'auto',
};

// Every field the SQL path is expected to reach parity on ("compilable" per
// runtime/store/aggsql.mjs's documented scope) versus every field that must
// fall back (documented right there too: division, fractional literals,
// text comparisons, correlated row., a hop through a ref). Dates compile since R9.
const COMPILABLE = ['total', 'totalIf', 'avgPrice', 'maxPrice', 'minPrice', 'n', 'activeCount', 'bigCount', 'discCmp', 'sumPlus', 'sumMinus', 'andCount', 'orCount', 'notCmp', 'dateBody', 'dateCount'];
const FALLBACK = ['divBody', 'fracLit', 'correlated', 'textCmp', 'hopBody'];

function withQueryCount(store, fn) {
  let n = 0;
  store.drv.onQuery = () => { n++; };
  try { return { result: fn(), n }; } finally { store.drv.onQuery = null; }
}

// Forces every field to go through the pre-item-1 path (ctx.rows()-based),
// for a byte-for-byte comparison against the SQL path.
const withSQLDisabled = compilerOff;

let seed32 = 0xC0FFEE;
const rand = () => { seed32 |= 0; seed32 = (seed32 + 0x6D2B79F5) | 0; let t = Math.imul(seed32 ^ (seed32 >>> 15), 1 | seed32); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const TRICKY = [0.1, 0.2, 0.7, 1.1, 2.2, 0.3, 0.01, 99.99, 0, -0.5, -12.34];
const price = () => (rand() < 0.35 ? TRICKY[Math.floor(rand() * TRICKY.length)] : Number(((rand() < 0.5 ? -1 : 1) * rand() * 500).toFixed(2)));

const DATES = ['2025-12-31', '2026-01-01', '2026-01-02', '2026-09-29', '2099-01-01'];
function seedRandom(store, parents, maxChildren) {
  const ids = [];
  for (let p = 0; p < parents; p++) {
    const pid = store.insert('Parent', { name: `P${p}`, flag: rand() < 0.5 });
    ids.push(pid);
    const nChildren = Math.floor(rand() * maxChildren);
    for (let c = 0; c < nChildren; c++) {
      store.insert('Child', {
        parent: pid, qty: Math.floor(rand() * 7) - 2, price: price(),
        discount: rand() < 0.3 ? '' : price(), // '' -> stored null (money.coerce)
        active: rand() < 0.5, label: rand() < 0.5 ? 'x' : 'y', when: DATES[Math.floor(rand() * DATES.length)],
      });
    }
  }
  return ids;
}

test('SQL path matches the JS path exactly: random parents, random children, every compiled field (property test)', () => {
  const store = new Store(GRAPH, ':memory:');
  const ids = seedRandom(store, 60, 40);
  // A page-batched pass (hydratePage, via store.list) and a per-row pass
  // (store.get, no page cache) must both agree with the forced-JS path.
  const sqlList = store.list('Parent', {});
  const jsList = withSQLDisabled(store, () => store.list('Parent', {}));
  assert.deepEqual(sqlList, jsList, 'batched SQL path differs from the JS path over random data');
  for (const id of ids) {
    const sqlRow = store.get('Parent', id);
    const jsRow = withSQLDisabled(store, () => store.get('Parent', id));
    assert.deepEqual(sqlRow, jsRow, `Parent #${id}: SQL and JS disagree`);
  }
});

test('empty children: sum/count are 0, avg/min/max are null — both paths, both single-row and batched', () => {
  const store = new Store(GRAPH, ':memory:');
  const id = store.insert('Parent', { name: 'Lonely' });
  const sqlRow = store.get('Parent', id);
  const jsRow = withSQLDisabled(store, () => store.get('Parent', id));
  assert.deepEqual(sqlRow, jsRow);
  for (const f of COMPILABLE) if (!['avgPrice', 'maxPrice', 'minPrice', 'dateBody'].includes(f)) assert.equal(sqlRow[f], 0, `${f} should default to 0 on an empty child set`);
  assert.equal(sqlRow.avgPrice, null); assert.equal(sqlRow.maxPrice, null); assert.equal(sqlRow.minPrice, null); assert.equal(sqlRow.dateBody, null);
  const [listed] = store.list('Parent', {});
  assert.deepEqual(listed, sqlRow, 'a batched empty-children group must default the same way as a single-row query');
});

test('a null field in the body propagates like JS: excluded from sum/avg, false in a comparison, never SQL NULL leaking through', () => {
  const store = new Store(GRAPH, ':memory:');
  const id = store.insert('Parent', { name: 'P' });
  store.insert('Child', { parent: id, qty: 1, price: 10, discount: '' }); // discount null -> price > discount is false (JS), not "unknown"
  store.insert('Child', { parent: id, qty: 1, price: 5, discount: 2 }); // 5 > 2 -> true
  const sqlRow = store.get('Parent', id);
  const jsRow = withSQLDisabled(store, () => store.get('Parent', id));
  assert.deepEqual(sqlRow, jsRow);
  assert.equal(sqlRow.discCmp, 1, 'only the row with a real, smaller discount should count');
});

test('every documented fallback case still computes correctly (just not compiled) — division, fractional literal, text compare, correlated row., a ref hop', () => {
  const store = new Store(GRAPH, ':memory:');
  const id = store.insert('Parent', { name: 'P', flag: true });
  for (let i = 0; i < 5; i++) store.insert('Child', { parent: id, qty: 1 + i, price: 3 + i, active: i % 2 === 0, label: i === 0 ? 'x' : 'y' });
  const sqlRow = store.get('Parent', id);
  const jsRow = withSQLDisabled(store, () => store.get('Parent', id));
  for (const f of FALLBACK) assert.equal(sqlRow[f], jsRow[f], `${f}: fallback path itself disagrees with itself — should be identical since neither is SQL-compiled`);
  assert.equal(sqlRow.textCmp, 1);
  // price sums 3+4+5+6+7 = 25 major units; row.flag is true for this parent,
  // so the correlated if() keeps every child's price (not qty * price).
  assert.equal(sqlRow.correlated, 2500);
});

// The task's own headline case, isolated from GRAPH's other (deliberately
// non-compilable) fields — those still batch-fetch raw child rows (chunked),
// so mixing them in here would measure that chunking, not this item.
const WIDE_GRAPH = {
  app: 'wide',
  data: {
    Order: { total: 'money := sum(Item: qty * price)', n: 'int := count(Item)' },
    Item: { order: 'ref:Order!', qty: 'int=1', price: 'money=1' },
  },
  views: 'auto',
};

test('a compilable field answers in O(1) queries whether the row has 2 children or 20000 (the task\'s own case)', () => {
  const store = new Store(WIDE_GRAPH, ':memory:');
  const few = store.insert('Order', {});
  store.insert('Item', { order: few, qty: 1, price: 1 });
  store.insert('Item', { order: few, qty: 2, price: 2 });
  const many = store.insert('Order', {});
  for (let i = 0; i < 20000; i++) store.insert('Item', { order: many, qty: 1 + (i % 3), price: (i % 500) / 10 });

  const { result: rFew, n: nFew } = withQueryCount(store, () => store.get('Order', few));
  const { result: rMany, n: nMany } = withQueryCount(store, () => store.get('Order', many));
  assert.equal(nFew, nMany, `compilable aggregates issued ${nFew} queries for 2 children but ${nMany} for 20000 — not O(1)`);
  assert.ok(nMany <= 3, `expected a small constant, got ${nMany}`);
  const jsMany = withSQLDisabled(store, () => store.get('Order', many));
  assert.deepEqual(rMany, jsMany);
  assert.equal(rFew.n, 2);
  assert.equal(rMany.n, 20000);
});

// A stronger claim than "few queries": item 2's memory fix depends on a
// compilable aggregate never pulling a single child row into JS at all,
// batched or not — only listRaw/listRawIn ever do that (query.mjs), so
// wrapping both and asserting zero calls proves it directly, rather than
// inferring it from a query count that an unbatched-but-still-one-query
// fallback could also satisfy.
test('a compilable aggregate never fetches a single child row into JS, however many children there are', () => {
  const store = new Store(WIDE_GRAPH, ':memory:');
  const many = store.insert('Order', {});
  for (let i = 0; i < 5000; i++) store.insert('Item', { order: many, qty: 1, price: 1 });
  let rawCalls = 0;
  const origRaw = store.listRaw, origIn = store.listRawIn;
  store.listRaw = function counted(...a) { rawCalls++; return origRaw.apply(this, a); };
  store.listRawIn = function counted(...a) { rawCalls++; return origIn.apply(this, a); };
  let row;
  try { row = store.get('Order', many); } finally { store.listRaw = origRaw; store.listRawIn = origIn; }
  assert.equal(rawCalls, 0, 'a compilable aggregate must never fetch child rows — it asks SQL for the number directly');
  assert.equal(row.total, 500000); // 5000 items * 1.00 major unit each = 5000.00 -> 500000 minor units
  // Same claim again, this time batched (a page of several orders at once).
  const many2 = store.insert('Order', {});
  for (let i = 0; i < 3000; i++) store.insert('Item', { order: many2, qty: 1, price: 1 });
  let batchedCalls = 0; // store.list('Order', …) itself calls listRaw('Order', …) to fetch the parents — only an 'Item' call would mean a child row was fetched
  store.listRaw = function counted(...a) { if (a[0] === 'Item') batchedCalls++; return origRaw.apply(this, a); };
  store.listRawIn = function counted(...a) { if (a[0] === 'Item') batchedCalls++; return origIn.apply(this, a); };
  try { store.list('Order', {}); } finally { store.listRaw = origRaw; store.listRawIn = origIn; }
  assert.equal(batchedCalls, 0);
});

test('two different aggregates over the same (child, via) pair get independent cached values (aggKey)', () => {
  const store = new Store(GRAPH, ':memory:');
  const id = store.insert('Parent', { name: 'P' });
  for (let i = 0; i < 10; i++) store.insert('Child', { parent: id, qty: 1, price: 1, active: i < 3 });
  const row = store.get('Parent', id);
  assert.equal(row.n, 10);
  assert.equal(row.activeCount, 3);
  assert.equal(row.total, 1000); // money is minor units: 10 * (1 * 1) major units = 1000 cents
});

test('batched hydration across more than one chunk (HYDRATE_CHUNK) still matches the per-row path exactly', () => {
  const store = new Store(GRAPH, ':memory:');
  const ids = seedRandom(store, 650, 5); // > 500 parents: crosses store/hydrate.mjs's chunk boundary
  const batched = store.list('Parent', {}); // store.list orders id DESC (query.mjs's orderBy default)
  const perRow = [...ids].reverse().map((id) => store.get('Parent', id));
  assert.deepEqual(batched, perRow);
});

// Item 2's memory fix is a structural claim (each aggregate cache — and the
// raw child rows it may hold — covers one chunk of parents, not the whole
// page), which no value comparison above can see: correctness is identical
// either way, by design. Proved directly instead, by recording how many
// parent ids buildAggCache is ever asked to cover in one call.
test('a big page is hydrated in bounded chunks, not loaded as one snapshot covering every row', () => {
  const store = new Store(GRAPH, ':memory:');
  seedRandom(store, 1200, 2); // well past HYDRATE_CHUNK (500), so at least 3 chunks
  const sizes = [];
  const orig = store.loadSnapshot;
  store.loadSnapshot = function counted(entity, rows, ...rest) { if (entity === 'Parent') sizes.push(rows.length); return orig.call(this, entity, rows, ...rest); };
  try { store.list('Parent', {}); } finally { delete store.loadSnapshot; }
  assert.ok(sizes.length >= 3, `expected at least 3 chunks for 1200 rows, got ${sizes.length}: ${sizes}`);
  assert.ok(sizes.every((n) => n <= 500), `a chunk exceeded 500 parents: ${sizes}`);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 1200);
});

// Direct unit tests of the compiler's accept/reject boundary (runtime/store/aggsql.mjs's
// compileAgg) — precise, not statistical: every documented "falls back" case
// (division, a fractional literal, date/time, a text comparison, a correlated
// `row.` reference, a hop through a ref) must decline, and every documented
// "compiles" shape must not.
test('compileAgg compiles exactly the documented shape — nothing more, nothing less', () => {
  const store = new Store(GRAPH, ':memory:');
  const yes = [
    'sum(Child: qty * price)', 'sum(Child: price + 1)', 'sum(Child: price - qty)',
    'avg(Child: price)', 'min(Child: price)', 'max(Child: price)',
    'count(Child)', 'count(Child: qty > 2)', 'count(Child: active and qty > 2)',
    'count(Child: active or qty > 2)', 'count(Child: not(active))',
    'sum(Child: if(active, qty * price, 0))', 'count(Child: price > discount)',
    'max(Child: when)', 'min(Child: when)', "count(Child: when > '2026-01-01')",
  ];
  for (const src of yes) assert.ok(compileAgg(store, 'Parent', parse(src)), `expected "${src}" to compile`);

  const no = [
    'sum(Child: price / 2)', 'sum(Child: price * 1.5)', 'sum(Child: when)', 'avg(Child: when)',
    'count(Child: label = "x")', 'sum(Child: if(row.flag, price, 0))',
    'sum(Child: parent.flag)', 'sum(Child: qty * price + when)',
  ];
  for (const src of no) assert.equal(compileAgg(store, 'Parent', parse(src)), null, `expected "${src}" NOT to compile`);
});

test('runAggOne and runAggBatch agree, including on an empty group, for a hand-built compiled shape', () => {
  const store = new Store(GRAPH, ':memory:');
  const withChildren = store.insert('Parent', { name: 'A' });
  store.insert('Child', { parent: withChildren, qty: 2, price: 3 });
  store.insert('Child', { parent: withChildren, qty: -1, price: 5 });
  const empty = store.insert('Parent', { name: 'B' });

  // runAggOne/runAggBatch answer in the algebra's own units (major, like
  // ctx.get() — see runtime/store/aggsql.mjs's finalizeOne), the same as
  // evaluate()'s own agg case would; fromExpr (money -> minor) is applied
  // once, by Store#derived, above this layer.
  const sum = compileAgg(store, 'Parent', parse('sum(Child: qty * price)'));
  assert.equal(runAggOne(store, sum, withChildren), 1); // 2*3.00 + -1*5.00 = 1.00 (major units)
  assert.equal(runAggOne(store, sum, empty), 0);
  const batch = runAggBatch(store, sum, [withChildren, empty]);
  assert.equal(batch.get(String(withChildren)), 1);
  assert.equal(batch.get(String(empty)), 0);

  const mn = compileAgg(store, 'Parent', parse('min(Child: price)'));
  assert.equal(runAggOne(store, mn, withChildren), 3);
  assert.equal(runAggOne(store, mn, empty), null);
  assert.equal(runAggBatch(store, mn, [empty]).get(String(empty)), null);
});
