// Compiles count/sum/avg/min/max over a direct child link into SQL — the entry point
// and the runners; the expression compiler is runtime/store/aggexpr.mjs. Called by
// runtime/store/hydrate.mjs (buildAggCache, Store#ctx's agg hook), never by an app
// graph directly.
//
// What compiles: a body (or a count's condition) built from the child's own stored
// int/money/bool/date/time fields, its derived fields (inlined), aggregates over its
// own children (derived or written out — correlated subqueries), integer literals,
// ISO date/time literals, `today`/`now`, `+ - *`, comparisons, `and`/`or`/`not` and
// `if(...)`. `min`/`max` over date/time answer the stored text, as evaluate() does.
//
// Every number stays an exact SQLite INTEGER until the very last step: money is its
// raw minor-unit column (scale 100), int/literal itself (scale 1), and `a op b`
// combines scales instead of dividing by 100 mid-expression. SQLite's SUM()/MIN()/
// MAX()/COUNT() over integers are exact — the one place a real division happens is
// the single, final `raw / scale`, run once per parent in JS through the exact same
// `exact()` runtime/expr.mjs's own sum/avg use, so rounding can never drift between
// the two paths. `/` anywhere in a body is not compiled (a per-row float summed by
// SQLite's compensated SUM() could differ in the last bit from evaluate()'s naive
// left-to-right reduce), nor is a fractional literal, text/enum/ref, `row.*`
// (correlated), a hop through a reference, an inner `avg` (a fraction), a product of
// money where evaluate()'s float dust could decide a comparison or a min/max, or any
// function but `if`. All of those fall back to the row-fetching path this module is
// an alternative to. Every decline is a plain `null`, never an error.
//
// `today`/`now` are the evaluation's one clock (evaluate()'s `clock`, or the page's
// shared one, hydrate.mjs), bound as named parameters — never SQLite's own clock.
import { exact } from '../expr.mjs';
import { compileBody, MAX_EXPANSIONS } from './aggexpr.mjs';

// Kept equal to store/query.mjs's own IN_CHUNK (SQLite's bound-parameter
// limit) but not imported from it — aggsql.mjs is a leaf query.mjs calls
// into, not the other way around.
const IN_CHUNK = 5000;

// A compiled shape depends only on the AST node, the entity it is read in and the
// (fixed) fields of the store — one Store#ctx().agg() call per row per aggregate
// would otherwise redo the whole compile for each of them.
const PLANS = new WeakMap();

// The public entry point: an `agg` AST node (runtime/expr.mjs), evaluated in the
// scope of `entity` — or null when it (or anything it needs) falls outside the
// compilable shape documented at the top of this file.
export function compileAgg(store, entity, node) {
  if (node.t !== 'agg') return null;
  let byStore = PLANS.get(node);
  if (!byStore) PLANS.set(node, byStore = new WeakMap());
  let byEntity = byStore.get(store);
  if (!byEntity) byStore.set(store, byEntity = new Map());
  if (!byEntity.has(entity)) byEntity.set(entity, plan(store, entity, node));
  return byEntity.get(entity);
}

function plan(store, entity, node) {
  const via = store.childVia(node.entity, entity, node.via);
  if (!via) return null; // no direct link back — the one case query.mjs always kept unbatched
  const cx = { store, entity, depth: -1, stack: [], params: new Set(), budget: { left: MAX_EXPANSIONS } };
  const b = compileBody(cx, node);
  if (!b) return null;
  const key = `${node.entity}|${via}|${node.fn}|${b.exprSQL}|${b.condSQL}`;
  return { child: node.entity, via, fn: node.fn, exprSQL: b.exprSQL, condSQL: b.condSQL, scale: b.scale, text: Boolean(b.text), params: [...cx.params], key };
}

// Distinguishes two different aggregates that happen to share a (child, via)
// pair — `total := sum(Item: qty*price)` and `count := count(Item)` on the
// same Order both key off Item|order, but need separate cached maps. Built once
// with the plan: a derived body can make the SQL text kilobytes long, and this is
// asked for once per row per aggregate.
export const aggKey = (c) => c.key;

function selectCols(c) {
  if (c.fn === 'count') return 'COUNT(*) AS v';
  if (c.fn === 'avg') return `SUM(${c.exprSQL}) AS v, COUNT(${c.exprSQL}) AS c`;
  return `${{ sum: 'SUM', min: 'MIN', max: 'MAX' }[c.fn]}(${c.exprSQL}) AS v`;
}

function finalizeOne(c, row) {
  if (c.fn === 'count') return Number(row.v ?? 0);
  if (c.fn === 'sum') return exact(Number(row.v ?? 0) / c.scale);
  if (c.fn === 'avg') { const n = Number(row.c ?? 0); return n ? exact(Number(row.v ?? 0) / c.scale / n) : null; }
  if (row.v === null || row.v === undefined) return null;
  return c.text ? row.v : Number(row.v) / c.scale;
}

// Integers past what SQLite or a JS number can hold: SUM() raises "integer overflow" and node:sqlite
// refuses to read an INTEGER above 2^53. Only that case declines at run time (undefined, so
// evaluate() computes the aggregate in doubles as it always did); any other error is a bug and stays one.
const OVERFLOW = /integer overflow|too large to be represented/i;
function guarded(fn) {
  try { return fn(); } catch (e) {
    if (OVERFLOW.test(String(e?.message))) return undefined; // allow-swallow: declines to the JS path, which answers in doubles
    throw e;
  }
}

// The named parameters of `today`/`now`, from the one clock of this evaluation.
const clockParams = (c, clock) => Object.fromEntries(c.params.map((p) => [p, p === '$today' ? clock.toISOString().slice(0, 10) : clock.toISOString()]));

// One parent's value — used when no page-level batch (hydrate.mjs's
// buildAggCache) already computed it, e.g. Store#get() on a single row. The
// SQL text is fixed for a given compiled shape (only the bound id varies),
// so this goes through Store#prepare's cache like every other read.
export function runAggOne(store, compiled, parentId, clock = new Date()) {
  let sql = `SELECT ${selectCols(compiled)} FROM "${compiled.child.toLowerCase()}" AS t0 WHERE t0."${compiled.via}"=?`;
  if (compiled.condSQL) sql += ` AND (${compiled.condSQL} <> 0)`;
  return guarded(() => finalizeOne(compiled, store.prepare(sql).get(clockParams(compiled, clock), String(parentId))));
}

// Every parent id's value in one query per IN_CHUNK-sized slice, instead of
// fetching a single child row: `ids` with no matching children at all get
// the same empty-group default runtime/expr.mjs's own sum/count/avg/min/max
// would (0 for sum/count, null for avg/min/max) since GROUP BY never
// produces a row for a group with nothing in it. `undefined`: see `guarded`.
export function runAggBatch(store, compiled, ids, clock = new Date()) {
  const empty = compiled.fn === 'sum' || compiled.fn === 'count' ? 0 : null;
  const map = new Map(ids.map((id) => [String(id), empty]));
  const table = compiled.child.toLowerCase();
  const named = clockParams(compiled, clock);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK).map(String);
    let sql = `SELECT t0."${compiled.via}" AS grp, ${selectCols(compiled)} FROM "${table}" AS t0 WHERE t0."${compiled.via}" IN (${chunk.map(() => '?').join(',')})`;
    if (compiled.condSQL) sql += ` AND (${compiled.condSQL} <> 0)`;
    sql += ` GROUP BY t0."${compiled.via}"`;
    if (guarded(() => { for (const row of store.db.prepare(sql).all(named, ...chunk)) map.set(String(row.grp), finalizeOne(compiled, row)); return true; }) === undefined) return undefined;
  }
  return map;
}
