// R9 items 1-3: derived fields, derived aggregates and dates inside an aggregate body
// (runtime/store/aggsql.mjs + aggexpr.mjs). Precise, not statistical: the accept/reject
// boundary of every new shape, parity with the JS path on data built to hit each one,
// the queries actually issued, the clock, and the run-time guards. The random-tree
// property test is tests/aggfuzz.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { parse } from '../runtime/expr.mjs';
import { compileAgg, runAggOne, runAggBatch } from '../runtime/store/aggsql.mjs';
import { freezeClock } from './helpers.mjs';

const yes = (store, entity, src) => assert.ok(compileAgg(store, entity, parse(src)), `expected "${src}" to compile`);
const no = (store, entity, src) => assert.equal(compileAgg(store, entity, parse(src)), null, `expected "${src}" NOT to compile`);
const jsOnly = (store, fn) => {
  const { aggValue, buildAggCache } = store;
  store.aggValue = () => undefined;
  store.buildAggCache = () => ({ groups: new Map(), scalars: new Map(), clock: new Date() });
  try { return fn(); } finally { store.aggValue = aggValue; store.buildAggCache = buildAggCache; }
};
const same = (store, entity) => {
  const sql = JSON.stringify(store.list(entity, {})), js = JSON.stringify(jsOnly(store, () => store.list(entity, {})));
  assert.equal(sql, js);
  for (const r of store.listRaw(entity, {})) assert.equal(JSON.stringify(store.get(entity, r.id)), JSON.stringify(jsOnly(store, () => store.get(entity, r.id))));
};

// Customer → Order → Item, the shape of bench/app.json plus a derived scalar, a derived
// bool, a derived aggregate of each kind, and dates.
const ITEM = {
  order: 'ref:Order!', qty: 'int=1', price: 'money=1', disc: 'money', shipped: 'date', at: 'time',
  line: 'money := qty * price', bulk: 'bool := qty > 2', both: 'bool := bulk and line > 10', qi: 'int := price', sq: 'money := price * price', half: 'money := line / 2',
};
const ORDER = {
  customer: 'ref:Customer!', placed: 'date',
  total: 'money := sum(Item: qty * price)', gross: 'money := sum(Item: line)', items: 'int := count(Item)', bulkN: 'int := count(Item: bulk)',
  lastShip: 'date := max(Item: shipped)', firstAt: 'time := min(Item: at)', cheapest: 'money := min(Item: price)', mean: 'money := avg(Item: price)',
  hi: 'money := max(Item: line)', vsum: 'money := sum(Item: sq)', hsum: 'money := sum(Item: half)',
};
const GRAPH = { app: 'agg2', data: { Customer: { name: 'text!' }, Order: ORDER, Item: ITEM }, views: 'auto' };

// Every shape below is a field of Customer, so one comparison covers them all.
const ACCEPT = {
  spent: 'money := sum(Order: total)', lines: 'money := sum(Order: gross)', n: 'int := count(Order: items > 0)', big: 'int := count(Order: total > 3)',
  zero: 'int := count(Order: total = 0)', noCheap: 'int := count(Order: cheapest = null)',
  someBulk: 'int := count(Order: bulkN > 0)', latest: 'date := max(Order: placed)', shipMax: 'date := max(Order: lastShip)', earliest: 'time := min(Order: firstAt)',
  cheap: 'money := sum(Order: cheapest)', cheapMax: 'money := max(Order: cheapest)', hiSum: 'money := sum(Order: hi)',
  written: 'int := sum(Order: count(Item))', writtenSum: 'money := sum(Order: sum(Item: qty * price) + 1)', writtenCond: 'money := sum(Order: if(count(Item: bulk) > 0, total, 0))',
  bothN: 'int := count(Order: total > 5 and items > 1)', avgTotal: 'money := avg(Order: total)', minTotal: 'money := min(Order: total)',
  recent: "int := count(Order: placed > '2026-01-01')", eqDate: "int := count(Order: placed = '2026-01-05')", nullDate: 'int := count(Order: placed = null)',
  late: 'int := count(Order: placed < today)', notLate: 'int := count(Order: not(placed >= today))', stamped: 'int := count(Order: lastShip <= now)',
  pick: 'date := max(Order: if(items > 1, placed, lastShip))', shipAt: "int := count(Order: firstAt > '2026-01-05T10:00:00Z')", dt: "int := count(Order: placed < firstAt)",
};
const REJECT = {
  meanSum: 'money := sum(Order: mean)', writtenAvg: 'money := sum(Order: avg(Item: price))', halfSum: 'money := sum(Order: hsum)',
  sqSum: 'money := sum(Order: vsum)', dateSum: 'money := sum(Order: placed)', dateAvg: 'money := avg(Order: placed)', dateVsNumber: 'int := count(Order: placed > 5)',
  dateTruthy: 'int := count(Order: placed)', badLiteral: "int := count(Order: placed > 'later')", textLiteralEq: "int := count(Order: placed = 'x')", hop: 'int := count(Order: customer.name = 1)',
  correlated: 'money := sum(Order: if(row.name = 1, total, 0))', quadruple: 'money := sum(Order: sum(Item: price * price * price * price))',
  scaleOverflowPlus: 'money := sum(Order: sum(Item: price * price * price * price + 1))', division: 'money := sum(Order: total / 2)',
};

function seed(store) {
  const days = ['2025-12-31', '2026-01-05', '2026-09-29', '2026-10-01', '2099-01-01'];
  const stamps = ['2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00Z', '2026-01-05 10:00:00', '2026-09-29T12:00:00.000Z', '2030-01-01T00:00:00.000Z'];
  store.insert('Customer', { name: 'Empty' });
  const c = store.insert('Customer', { name: 'Full' });
  store.insert('Order', { customer: c, placed: days[0] }); // no items
  for (let o = 0; o < 7; o++) {
    const oid = store.insert('Order', { customer: c, placed: o === 6 ? '' : days[o % days.length] });
    for (let i = 0; i < o % 4; i++) store.insert('Item', { order: oid, qty: i + o - 2, price: [0.1, 2.5, 7, 0.07][i % 4], disc: i === 1 ? '' : 1, shipped: i === 2 ? '' : days[(o + i) % days.length], at: stamps[(o * 3 + i) % stamps.length] });
  }
  const d = store.insert('Customer', { name: 'Two' });
  const oid = store.insert('Order', { customer: d, placed: days[1] });
  store.insert('Item', { order: oid, qty: 3, price: 4, shipped: days[1], at: stamps[0] });
}

test('every new shape compiles, and answers exactly what the JS path answers (page and single row)', (t) => {
  t.after(freezeClock());
  const store = new Store({ ...GRAPH, data: { ...GRAPH.data, Customer: { name: 'text!', ...ACCEPT } } }, ':memory:');
  seed(store);
  for (const [name, spec] of Object.entries(ACCEPT)) {
    const node = store.field('Customer', name).derive;
    assert.ok(compileAgg(store, 'Customer', node), `${name} [${spec}] should compile`);
  }
  same(store, 'Customer');
  const full = store.list('Customer', {}).find((r) => r.name === 'Full');
  assert.equal(full.n, 5); // a value that is not 0/null, so the comparison above means something
  assert.ok(full.big > 0 && full.late > 0 && full.recent > 0, JSON.stringify(full));
});

test('an aggregate over a derived aggregate of the derived field is still one query, no child row in JS', (t) => {
  t.after(freezeClock());
  const store = new Store({ ...GRAPH, data: { ...GRAPH.data, Customer: { name: 'text!', ...ACCEPT } } }, ':memory:');
  seed(store);
  const fetched = [];
  for (const m of ['listRaw', 'listRawIn']) { const orig = store[m]; store[m] = function spy(...a) { if (a[0] !== 'Customer') fetched.push(a[0]); return orig.apply(this, a); }; }
  store.list('Customer', {});
  store.get('Customer', 2);
  assert.deepEqual(fetched, [], 'nothing below Customer may be fetched into JS');
});

test('the subquery is joined through the ref index, not a scan per order', () => {
  const store = new Store({ ...GRAPH, data: { ...GRAPH.data, Customer: { name: 'text!', spent: ACCEPT.spent } } }, ':memory:');
  seed(store);
  const seen = [];
  store.drv.onQuery = (sql) => seen.push(sql);
  runAggBatch(store, compileAgg(store, 'Customer', store.field('Customer', 'spent').derive), [1, 2]);
  store.drv.onQuery = null;
  const plan = store.drv.all(`EXPLAIN QUERY PLAN ${seen.at(-1)}`, [{}, '1', '2']).map((r) => r.detail).join(' | ');
  assert.match(plan, /CORRELATED SCALAR SUBQUERY/);
  assert.doesNotMatch(plan, /SCAN item|SCAN t1/i, `the inner lookup scans: ${plan}`);
});

test('the accept/reject boundary of the new shapes', () => {
  const store = new Store({ ...GRAPH, data: { ...GRAPH.data, Customer: { name: 'text!', ...REJECT } } }, ':memory:');
  for (const [name, spec] of Object.entries(REJECT)) no(store, 'Customer', spec.split(':= ')[1]);
  for (const src of ['sum(Order: total)', 'sum(Order: gross)', 'max(Order: lastShip)', 'sum(Order: cheapest)', "count(Order: placed > '2026-01-01')", 'count(Order: placed < today)', 'sum(Order: min(Item: qty * price))', 'sum(Order: max(Item: qty * price))']) yes(store, 'Customer', src);
  // Item level: a scalar derived field inlines, unless rounding it to cents would need real work.
  for (const src of ['sum(Item: line)', 'sum(Item: line + 1)', 'count(Item: both)', 'count(Item: bulk and line > 10)', "max(Item: shipped)", 'min(Item: at)', 'sum(Item: if(bulk, line, 0))']) yes(store, 'Order', src);
  // exact() rounds each row's `+`/`-` to 6 decimals: four money factors have 8, so the integers would no longer match.
  for (const src of ['sum(Item: sq)', 'sum(Item: qi)', 'sum(Item: half)', 'sum(Item: price * price * price * price + 1)']) no(store, 'Order', src);
});

test('a derived cycle or an over-deep chain is not compiled, and never loops the compiler', () => {
  const chain = {};
  for (let i = 0; i < 12; i++) chain[`d${i}`] = `int := ${i === 11 ? 'qty' : `d${i + 1}`} + 1`;
  const store = new Store({ app: 'cyc', data: {
    Order: { total: 'int := sum(Item: a)', deep: 'int := sum(Item: d0)', blow: 'int := sum(Item: x6)' },
    Item: { order: 'ref:Order!', qty: 'int=1', a: 'int := b + 1', b: 'int := a + 1', ...chain, x0: 'int := qty', ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`x${i}`, `int := x${i - 1} + x${i - 1} + x${i - 1} + x${i - 1} + x${i - 1}`])) },
  }, views: 'auto' }, ':memory:');
  no(store, 'Order', 'sum(Item: a)'); // a cycle: the JS path raises its own error, as it always did
  no(store, 'Order', 'sum(Item: d0)'); // 12 derived fields inside one another: past MAX_STACK
  no(store, 'Order', 'sum(Item: x6)'); // 5^6 copies of one field: past MAX_EXPANSIONS
  yes(store, 'Order', 'sum(Item: x2)');
  const o = store.insert('Order', {});
  store.insert('Item', { order: o, qty: 1 });
  assert.throws(() => store.get('Order', o), /depends on itself/);
});

test('subqueries nest only so deep', () => {
  const data = {};
  for (let i = 0; i < 8; i++) data[`E${i}`] = { ...(i ? { up: `ref:E${i - 1}!` } : {}), ...(i < 7 ? { down: `int := count(E${i + 1})`, sub: `int := sum(E${i + 1}: down)` } : {}) };
  const store = new Store({ app: 'deep', data, views: 'auto' }, ':memory:');
  yes(store, 'E0', 'sum(E1: down)'); // one subquery
  const nest = (from, n) => (n === 0 ? 'count(E' + (from + 1) + ')' : `sum(E${from + 1}: ${nest(from + 1, n - 1)})`);
  yes(store, 'E0', nest(0, 3));
  no(store, 'E0', nest(0, 6));
});

test('a date/time column is compared exactly as JS compares the strings, whatever ISO shape it was stored in', () => {
  const store = new Store({ app: 'ts', data: { P: { early: "int := count(C: at < '2026-01-05T10:00:00Z')", same: "int := count(C: at = '2026-01-05T10:00:00Z')", after: "int := count(C: at > '2026-01-05')", last: 'time := max(C: at)', first: 'time := min(C: at)' }, C: { p: 'ref:P!', at: 'time' } }, views: 'auto' }, ':memory:');
  const p = store.insert('P', {});
  for (const at of ['2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00Z', '2026-01-05 10:00:00', '2026-01-05T09:00:00.000+00:00', '2025-01-01T00:00:00Z']) store.insert('C', { p, at });
  store.insert('C', { p });
  same(store, 'P');
  const row = store.get('P', p);
  // `.000Z` sorts before `Z` although they are the same instant: strings, as evaluate() has always compared them.
  assert.deepEqual([row.early, row.same, row.after, row.last, row.first], [4, 1, 4, '2026-01-05T10:00:00Z', '2025-01-01T00:00:00Z']);
});

test('today and now are the one clock of the evaluation, bound into the SQL — not SQLite\'s own', (t) => {
  const store = new Store({ app: 'clk', data: { P: { past: 'int := count(C: d < today)', todayN: 'int := count(C: d = today)', ahead: 'int := count(C: at > now)', firstDay: 'date := min(C: if(d < today, d, today))' }, C: { p: 'ref:P!', d: 'date', at: 'time' } }, views: 'auto' }, ':memory:');
  const p = store.insert('P', {});
  for (const [d, at] of [['2026-09-28', '2026-09-29T11:59:59.999Z'], ['2026-09-29', '2026-09-29T12:00:00.000Z'], ['2026-09-30', '2026-09-29T12:00:00.001Z']]) store.insert('C', { p, d, at });
  const at = (iso) => { const restore = freezeClock(iso); try { return { one: store.get('P', p), page: store.list('P', {})[0], js: jsOnly(store, () => store.get('P', p)) }; } finally { restore(); } };
  const a = at('2026-09-29T12:00:00.000Z');
  assert.deepEqual([a.one.past, a.one.todayN, a.one.ahead], [1, 1, 1]);
  assert.deepEqual(a.one, a.js); assert.deepEqual(a.page, a.js);
  const b = at('2027-03-01T00:00:00.000Z');
  assert.deepEqual([b.one.past, b.one.todayN, b.one.ahead], [3, 0, 0]);
  assert.deepEqual(b.one, b.js); assert.deepEqual(b.page, b.js);
  assert.equal(a.one.firstDay, '2026-09-28');
  // A page shares one clock; a lone evaluation reads its own — and a batch built for another clock is never reused.
  t.after(freezeClock('2026-09-29T12:00:00.000Z'));
  const clock = new Date();
  const compiled = compileAgg(store, 'P', store.field('P', 'ahead').derive);
  assert.equal(runAggOne(store, compiled, p, clock), 1);
  assert.equal(runAggOne(store, compiled, p, new Date('2030-01-01T00:00:00.000Z')), 0);
  assert.equal(runAggBatch(store, compiled, [p], new Date('2030-01-01T00:00:00.000Z')).get(String(p)), 0);
  const cache = store.buildAggCache('P', [p]);
  const row = store.raw('P', p);
  const node = store.field('P', 'ahead').derive;
  assert.equal(store.aggValue('P', row, node, cache, cache.clock), 1);
  assert.equal(store.aggValue('P', row, node, cache, new Date('2030-01-01T00:00:00.000Z')), 0, 'a different clock must not read the cached batch');
});

test('integers past 2^53 or SQLite\'s SUM range decline to the JS path at run time instead of throwing', () => {
  const store = new Store({ app: 'big', data: { P: { sq: 'int := sum(C: qty * qty)', top: 'int := max(C: qty * qty)' }, C: { p: 'ref:P!', qty: 'int' } }, views: 'auto' }, ':memory:');
  const small = store.insert('P', {}); store.insert('C', { p: small, qty: 3 });
  const huge = store.insert('P', {}); store.insert('C', { p: huge, qty: 100_000_000 }); // 1e16 > 2^53: node:sqlite refuses to read it
  const over = store.insert('P', {}); store.insert('C', { p: over, qty: 3_000_000_000 }); store.insert('C', { p: over, qty: 3_000_000_000 }); // SUM() -> integer overflow
  same(store, 'P');
  assert.equal(store.get('P', small).sq, 9);
  assert.equal(store.get('P', huge).sq, 1e16);
  assert.equal(store.get('P', over).sq, 1.8e19);
  const compiled = compileAgg(store, 'P', store.field('P', 'sq').derive);
  assert.equal(runAggOne(store, compiled, huge), undefined);
  assert.equal(runAggBatch(store, compiled, [small, huge]), undefined);
  assert.throws(() => runAggOne(store, { ...compiled, exprSQL: 'nonsense(' }, small), /syntax|no such|nonsense/i, 'any other SQL error is a bug and must surface');
});

// R12: what was the "known 0.1.2 divergence" is a parity now. evaluate() finalizes every `*`
// through exact() (like `+`, `-` and sums), so 3 * 0.1 is 0.3 in JS, as it is in the compiler's
// exact integers and in decimal arithmetic. JS == SQL == exact decimal, including the nested
// min/max over a raw money product, which compiles because it is proven equal.
test('a comparison of a raw money product against an exactly equal value: JS == SQL == exact decimal', () => {
  const store = new Store({ app: 'dust', data: { P: { gt: 'int := count(C: qty * price > disc)', ge: 'int := count(C: qty * price >= disc)', eq: 'int := count(C: qty * price = disc)', mn: 'money := sum(D: min(E: qty * price))', mx: 'money := sum(D: max(E: qty * price))' }, C: { p: 'ref:P!', qty: 'int', price: 'money', disc: 'money' }, D: { p: 'ref:P!' }, E: { d: 'ref:D!', qty: 'int', price: 'money' } }, views: 'auto' }, ':memory:');
  const p = store.insert('P', {});
  const cases = [[3, 0.1, 0.3], [100, 0.07, 7], [3, 0.7, 2.1], [7, 1.1, 7.7], [3, 0.2, 0.6], [1, 0.1, 0.3], [3, 0.11, 0.3]];
  const d = store.insert('D', { p });
  for (const [qty, price, disc] of cases) { store.insert('C', { p, qty, price, disc }); store.insert('E', { d, qty, price }); }
  const cents = (x) => BigInt(Math.round(x * 100));
  const truth = (fn) => cases.filter(([q, pr, di]) => fn(BigInt(q) * cents(pr), cents(di) * 1n)).length;
  const want = { gt: truth((x, y) => x > y), ge: truth((x, y) => x >= y), eq: truth((x, y) => x === y) };
  assert.deepEqual(want, { gt: 1, ge: 6, eq: 5 });
  const sql = store.get('P', p), js = jsOnly(store, () => store.get('P', p));
  for (const k of ['gt', 'ge', 'eq']) { assert.equal(sql[k], want[k], `SQL ${k}`); assert.equal(js[k], want[k], `JS ${k}`); }
  assert.equal(sql.mn, 10, 'min of the exact products, in minor units'); assert.equal(js.mn, 10);
  assert.equal(sql.mx, 770); assert.equal(js.mx, 770);
  yes(store, 'P', 'sum(D: min(E: qty * price))');
  same(store, 'P');
});

// A product with more decimals than exact() keeps (money * money * money * money) is not compiled:
// JS rounds it at 6 decimals, the compiler would stay exact at 8 — the two must not round apart.
test('a product beyond exact()\'s 6 decimals is left to the JS path', () => {
  const store = new Store({ app: 'wide', data: { P: { a: 'money := sum(C: price * price * price)', b: 'money := sum(C: price * price * price * price)' }, C: { p: 'ref:P!', price: 'money' } }, views: 'auto' }, ':memory:');
  const p = store.insert('P', {});
  store.insert('C', { p, price: 1.11 });
  yes(store, 'P', 'sum(C: price * price * price)');
  no(store, 'P', 'sum(C: price * price * price * price)');
  same(store, 'P');
});

// A clock that moves on every `new Date()`: an evaluation that read it once per derived field
// would see `late` and `at > now` on different instants. One evaluation, one clock — in the JS
// path (handed down through every derived field, hop and row) and in the compiled one.
test('a derived field inside an aggregate reads the same `now` as the aggregate around it', (t) => {
  const store = new Store({ app: 'tick', data: { O: { diff: 'int := count(I: late) - count(I: at > now)', dd: 'int := sum(I: if(late, 1, 0)) - sum(I: if(at > now, 1, 0))' }, I: { o: 'ref:O!', at: 'time', late: 'bool := at > now' } }, views: 'auto' }, ':memory:');
  const o = store.insert('O', {});
  const base = Date.UTC(2026, 8, 29, 12);
  for (let j = 0; j < 30; j++) store.insert('I', { o, at: new Date(base + j).toISOString() });
  const Real = globalThis.Date;
  let k = 0;
  globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [base + (k++ % 30)])); } };
  t.after(() => { globalThis.Date = Real; });
  for (let i = 0; i < 60; i++) {
    assert.deepEqual([store.get('O', o).diff, store.get('O', o).dd], [0, 0]);
    assert.deepEqual([jsOnly(store, () => store.get('O', o)).diff, jsOnly(store, () => store.get('O', o)).dd], [0, 0]);
  }
  assert.ok(k > 100, 'the clock really did move');
});
