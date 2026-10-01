// R9 item 4: a differential property test over random expression trees. For a fixed seed
// it generates aggregate fields over a three-level graph (Parent → Child → Grand) whose
// bodies and conditions are random trees of the supported grammar — ints, money, bools,
// dates, times, nullable columns, derived scalar and derived aggregate fields of the
// child, nested aggregates, `+ - *`, comparisons, and/or/not, `if`, `today`/`now`,
// ISO literals — and asserts that the SQL-compiled path (runtime/store/aggsql.mjs) answers
// exactly what the JS path (runtime/expr.mjs, forced by switching the compiler off) does,
// for every fn, over random rows including empty groups and NULLs. Both a page (the batched
// cache) and a single row (Store#get) are compared, as JSON — the bytes a route answers.
// A failure prints the seed-relative round, the field and its source, so it reproduces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { validate } from '../runtime/validate.mjs';
import { compileAgg } from '../runtime/store/aggsql.mjs';
import { freezeClock, compilerOff } from './helpers.mjs';

// FUZZ_SEED / FUZZ_ROUNDS widen the search from the shell; the defaults are the gate.
const SEED = Number(process.env.FUZZ_SEED ?? 0x5EED9);
const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 12);
function rng(seed) {
  let s = seed | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// The child level of every generated graph: stored fields of every supported kind, derived
// scalars, derived aggregates over Grand (the ones a Parent body may inline or subquery),
// and a few derived fields that must fall back (division, an avg, a money*money product).
const GRAND = { child: 'ref:Child!', qty: 'int=1', n: 'int', price: 'money=1', disc: 'money', on: 'bool=false', d: 'date', t: 'time', line: 'money := qty * price' };
const CHILD_BASE = {
  parent: 'ref:Parent!', qty: 'int=1', n: 'int', price: 'money=1', disc: 'money', on: 'bool=false', d: 'date', t: 'time',
  line: 'money := qty * price', big: 'bool := price > disc', late: 'bool := d < today', both: 'bool := on and big',
  total: 'money := sum(Grand: qty * price)', gsum: 'money := sum(Grand: line)', cnt: 'int := count(Grand)', cntOn: 'int := count(Grand: on)',
  top: 'money := max(Grand: price)', low: 'money := min(Grand: price)', lastD: 'date := max(Grand: d)', firstT: 'time := min(Grand: t)',
  mix: 'money := total + line', nn: 'int := n + cnt', avgP: 'money := avg(Grand: price)', half: 'money := line / 2', sq: 'money := price * disc',
};
const CHILD_NUM = ['qty', 'n', 'price', 'disc', 'line', 'total', 'gsum', 'cnt', 'cntOn', 'top', 'low', 'mix', 'nn', 'avgP', 'half', 'sq', 'id'];
const CHILD_BOOL = ['on', 'big', 'late', 'both'];
const CHILD_DATE = ['d', 't', 'lastD', 'firstT'];
const GRAND_NUM = ['qty', 'n', 'price', 'disc', 'line', 'id'];

// The clock the whole test runs on (see freezeClock): rows sit on both sides of it, and exactly on it.
const NOW = '2026-09-29T12:00:00.000Z';
const DAYS = ['2019-12-31', '2020-02-29', '2024-06-15', '2026-01-05', '2026-01-05', '2026-09-29', '2030-01-01', '2099-12-31'];
const STAMPS = ['2026-09-29T12:00:00.000Z', '2026-09-29T11:59:59.999Z', '2026-09-29T12:00:00Z', '2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00Z', '2026-01-05 10:00:00', '2026-01-05T09:59:59.999Z', '2024-03-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', '2001-01-01T00:00:00.000Z'];
// Includes the exact products of the others (3 * 0.1 = 0.3, 3 * 0.7 = 2.1, 2 * 0.07 = 0.14…): ties for `qty * price OP disc`.
const PRICES = [0.1, 0.2, 0.07, 0.7, 1.1, 2.2, 0.3, 0.01, 99.99, 0, -0.5, -12.34, 5, 10, 100, 7.5, 0.6, 2.1, 0.14, 0.21, 7.7, 0.4, 0.28, 3.3];

// Expressions are generated as [source, { money }]. Raw money products (qty * price…) go into
// comparisons, nested min/max and int-typed aggregates like everything else: since R12 evaluate()
// finalizes `*` through exact(), so JS == SQL on the ties (3 * 0.1 > 0.3) that 0.1.2 diverged on.
const MONEY = new Set(['price', 'disc', 'line', 'total', 'gsum', 'top', 'low', 'mix', 'avgP', 'half', 'sq']);
function generator(rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const chance = (p) => rand() < p;
  const dateLit = () => `'${chance(0.7) ? pick(DAYS) : pick(STAMPS)}'`;
  const dateExpr = (fields, depth) => {
    if (depth > 0 && chance(0.2)) return `if(${cond(fields, depth - 1)}, ${dateExpr(fields, depth - 1)}, ${dateExpr(fields, depth - 1)})`;
    const r = rand();
    return r < 0.55 ? pick(fields.date) : r < 0.8 ? dateLit() : r < 0.9 ? 'today' : r < 0.97 ? 'now' : 'null';
  };
  const num = (fields, depth) => {
    const r = rand();
    if (depth <= 0 || r < 0.3) {
      if (chance(0.25)) return [String(Math.floor(rand() * 8)), {}];
      const f = pick(fields.num);
      return [f, { money: MONEY.has(f) }];
    }
    if (r < 0.55) {
      const op = pick(['+', '-', '*']), [a, x] = num(fields, depth - 1), [b, y] = num(fields, depth - 1);
      return [`(${a} ${op} ${b})`, { money: Boolean(x.money || y.money) }];
    }
    if (r < 0.62) { const [a, x] = num(fields, depth - 1); return [`-${a}`, x]; }
    if (r < 0.7) { const [a] = num(fields, depth - 1), [b] = num(fields, depth - 1); return [`(${a} / ${b})`, { money: true }]; }
    if (r < 0.85) {
      const [a, x] = num(fields, depth - 1), [b, y] = num(fields, depth - 1);
      return [`if(${cond(fields, depth - 1)}, ${a}, ${b})`, { money: Boolean(x.money || y.money) }];
    }
    return fields.sub ? nested(fields, depth - 1) : num(fields, 0);
  };
  const cmp = (fields, depth) => {
    const op = pick(['=', '!=', '<', '<=', '>', '>=']);
    if (fields.tie && chance(0.3)) return `${pick(['qty * price', 'price * qty', 'line'])} ${op} ${pick(['disc', 'disc', 'price', '3'])}`;
    return chance(0.35) ? `${dateExpr(fields, depth)} ${op} ${dateExpr(fields, depth)}` : `${num(fields, depth)[0]} ${op} ${num(fields, depth)[0]}`;
  };
  function cond(fields, depth) {
    const r = rand();
    if (depth <= 0 || r < 0.25) return chance(0.7) ? pick(fields.bool) : pick(['true', 'false']);
    if (r < 0.6) return cmp(fields, depth);
    if (r < 0.75) return `(${cond(fields, depth - 1)} and ${cond(fields, depth - 1)})`;
    if (r < 0.9) return `(${cond(fields, depth - 1)} or ${cond(fields, depth - 1)})`;
    return `not(${cond(fields, depth - 1)})`;
  }
  // An aggregate written out inside a Child-level body: over Grand, with Grand's own fields.
  const grandFields = { tie: true, num: GRAND_NUM, bool: ['on'], date: ['d', 't'] };
  function nested(fields, depth) {
    const fn = pick(['sum', 'count', 'min', 'max', 'avg']);
    if (fn === 'count') return [chance(0.5) ? 'count(Grand)' : `count(Grand: ${cond(grandFields, depth)})`, {}];
    const [body, x] = num(grandFields, depth);
    return [`${fn}(Grand: ${body})`, { money: x.money }];
  }
  // One Parent field: [name, spec].
  function parentField(i) {
    const child = { tie: true, num: CHILD_NUM, bool: CHILD_BOOL, date: CHILD_DATE, sub: true };
    const depth = 1 + Math.floor(rand() * 3);
    const fn = pick(['count', 'sum', 'sum', 'min', 'max', 'avg']);
    if (fn === 'count') return [`f${i}`, `int := count(Child${chance(0.9) ? `: ${cond(child, depth)}` : ''})`];
    if (chance(0.25) && (fn === 'min' || fn === 'max')) return [`f${i}`, `${pick(['date', 'time'])} := ${fn}(Child: ${dateExpr(child, depth)})`];
    const [body] = num(child, depth);
    const kind = pick(['money', 'money', 'int']);
    return [`f${i}`, `${kind} := ${fn}(Child: ${body})`];
  }
  return { parentField };
}

async function seedRows(store, rand) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const row = (extra) => {
    const qty = Math.floor(rand() * 7) - 2, price = pick(PRICES);
    // A quarter of the rows have disc exactly equal to qty * price at cent scale: the tie the doubles get wrong.
    const disc = rand() < 0.25 ? Number((qty * price).toFixed(2)) : rand() < 0.3 ? '' : pick(PRICES);
    return { qty, n: rand() < 0.3 ? '' : Math.floor(rand() * 5) - 1, price, disc, on: rand() < 0.5, d: rand() < 0.15 ? '' : pick(DAYS), t: rand() < 0.15 ? '' : pick(STAMPS), ...extra };
  };
  for (let p = 0; p < 24; p++) {
    const pid = await store.insert('Parent', { name: `P${p}` });
    const kids = p % 6 === 0 ? 0 : Math.floor(rand() * 6); // some parents are empty groups
    for (let c = 0; c < kids; c++) {
      const cid = await store.insert('Child', row({ parent: pid }));
      const grand = c % 3 === 0 ? 0 : Math.floor(rand() * 5);
      for (let g = 0; g < grand; g++) await store.insert('Grand', row({ child: cid }));
    }
  }
}

// The reference: every aggregate through runtime/expr.mjs, the compiler and the page cache off.
const jsOnly = compilerOff;

// The old lazy path (`store.lazyEval`, S3a): the same fields evaluated over a RowCtx that queries on demand.
const lazily = async (store, fn) => { store.lazyEval = true; try { return await fn(); } finally { store.lazyEval = false; } };

const graphOf = (parentFields) => ({ app: 'fuzz', data: { Parent: { name: 'text!', ...parentFields }, Child: CHILD_BASE, Grand: GRAND }, views: 'auto' });

test('the SQL path equals the JS path over random expression trees, rows, empty groups and NULLs (seeded)', async (t) => {
  t.after(freezeClock(NOW)); // both paths read one clock: a `now` in a body compares the same on both sides
  const rand = rng(SEED);
  const gen = generator(rand);
  let fields = 0, compiled = 0;
  for (let round = 0; round < ROUNDS; round++) {
    // Keep the fields the checker accepts: what an app may actually declare.
    const parentFields = {};
    for (let i = 0; Object.keys(parentFields).length < 40 && i < 400; i++) {
      const [name, spec] = gen.parentField(i);
      if (!validate(graphOf({ [name]: spec })).length) parentFields[name] = spec;
    }
    const store = new Store(graphOf(parentFields), ':memory:');
    await seedRows(store, rand);
    const ids = (await store.listRaw('Parent', {})).map((r) => r.id);
    const sqlPage = (await store.list('Parent', {})).map((r) => JSON.stringify(r));
    const jsPage = (await jsOnly(store, async () => await store.list('Parent', {}))).map((r) => JSON.stringify(r));
    // The snapshot path against the lazy path, compiler on and off: S3a moved evaluation, not meaning.
    const lazyPage = (await lazily(store, async () => await store.list('Parent', {}))).map((r) => JSON.stringify(r));
    const lazyJsPage = (await lazily(store, async () => await jsOnly(store, async () => await store.list('Parent', {})))).map((r) => JSON.stringify(r));
    for (let k = 0; k < sqlPage.length; k++) {
      if (sqlPage[k] !== jsPage[k]) assert.fail(pointer(round, parentFields, JSON.parse(sqlPage[k]), JSON.parse(jsPage[k]), 'page'));
      if (sqlPage[k] !== lazyPage[k]) assert.fail(pointer(round, parentFields, JSON.parse(sqlPage[k]), JSON.parse(lazyPage[k]), 'page (snapshot vs lazy)'));
      if (jsPage[k] !== lazyJsPage[k]) assert.fail(pointer(round, parentFields, JSON.parse(jsPage[k]), JSON.parse(lazyJsPage[k]), 'page (snapshot vs lazy, JS only)'));
    }
    for (const id of ids) {
      const sql = JSON.stringify(await store.get('Parent', id)), js = JSON.stringify(await jsOnly(store, async () => await store.get('Parent', id)));
      if (sql !== js) assert.fail(pointer(round, parentFields, JSON.parse(sql), JSON.parse(js), `row ${id}`));
      const lazy = JSON.stringify(await lazily(store, async () => await store.get('Parent', id)));
      if (sql !== lazy) assert.fail(pointer(round, parentFields, JSON.parse(sql), JSON.parse(lazy), `row ${id} (snapshot vs lazy)`));
    }
    for (const name of Object.keys(parentFields)) {
      fields++;
      if (compileAgg(store, 'Parent', store.field('Parent', name).derive)) compiled++;
    }
  }
  if (process.env.FUZZ_VERBOSE) console.error(`compiled ${compiled} of ${fields}`);
  // Not vacuous: a healthy share of the random shapes really took the SQL path.
  assert.ok(compiled > fields * 0.25, `only ${compiled} of ${fields} random aggregates compiled — the generator drifted from the compilable grammar`);
});

function pointer(round, parentFields, sql, js, where) {
  const bad = Object.keys(js).filter((k) => JSON.stringify(sql[k]) !== JSON.stringify(js[k]));
  return `round ${round} (${where}): SQL and JS disagree on ${bad.map((k) => `${k} [${parentFields[k]}] sql=${JSON.stringify(sql[k])} js=${JSON.stringify(js[k])}`).join('; ')}`;
}
