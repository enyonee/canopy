// Compiles count/sum/avg/min/max over a direct child link into SQL, when the
// body is built only from the child's own stored int/money/bool fields —
// exactly the shape `total := sum(Item: qty * price)` is. Attached to
// Store.prototype by store.mjs is not needed: this module is called by
// runtime/store/query.mjs (buildAggCache, Store#ctx's agg hook), never by an
// app graph directly.
//
// Every number here stays an exact SQLite INTEGER until the very last step:
// money is represented by its raw minor-unit column (scale 100), int/literal
// by itself (scale 1), and `a op b` combines scales instead of dividing by
// 100 mid-expression. SQLite's SUM()/MIN()/MAX()/COUNT() over integers are
// exact (proven against a BigInt reference for 5000 random pairs while this
// was written) — the one place a real division happens is the single,
// final `raw / scale`, run once per parent in JS through the exact same
// `exact()` runtime/expr.mjs's own sum/avg use, so rounding can never drift
// between the two paths. Division inside the body would reintroduce a
// per-row float and, summed by SQLite's own (compensated, not left-to-right)
// SUM(), risk a last-bit mismatch against runtime/expr.mjs's naive
// left-to-right reduce — so `/` anywhere in a body is simply not compiled;
// neither are fractional literals, date/time, text/enum/ref, `row.*`
// (correlated), derived fields, or any function but `if`. All of those fall
// back to the row-fetching path this module is an alternative to.
import { exact } from '../expr.mjs';

// Kept equal to store/query.mjs's own IN_CHUNK (SQLite's bound-parameter
// limit) but not imported from it — aggsql.mjs is a leaf query.mjs calls
// into, not the other way around.
const IN_CHUNK = 5000;

const isPlainPath = (n) => n.t === 'path' && n.p.length === 1;

// A value sub-expression: { sql, scale } where the real value is sql/scale,
// or null when this node (or anything under it) is not representable.
function compileValue(store, entity, n) {
  if (n.t === 'num') return Number.isInteger(n.v) ? { sql: String(n.v), scale: 1 } : null;
  if (n.t === 'null') return { sql: 'NULL', scale: null };
  if (isPlainPath(n)) {
    if (n.p[0] === 'id') return { sql: '"id"', scale: 1 };
    const f = store.field(entity, n.p[0]);
    if (!f || f.derive) return null;
    if (f.kind === 'money') return { sql: `"${f.name}"`, scale: 100 };
    if (f.kind === 'int' || f.kind === 'bool') return { sql: `"${f.name}"`, scale: 1 };
    return null;
  }
  if (n.t === 'un' && n.op === '-') { const a = compileValue(store, entity, n.a); return a && { sql: `(-(${a.sql}))`, scale: a.scale }; }
  if (n.t === 'bin') return compileValueBin(store, entity, n);
  if (n.t === 'call' && n.fn === 'if') return compileIf(store, entity, n);
  return null;
}

function compileValueBin(store, entity, n) {
  if (n.op === '*') {
    const a = compileValue(store, entity, n.a), b = compileValue(store, entity, n.b);
    return a && b && { sql: `(${a.sql} * ${b.sql})`, scale: (a.scale ?? 1) * (b.scale ?? 1) };
  }
  if (n.op !== '+' && n.op !== '-') return null; // division and comparisons are never a value
  const a = compileValue(store, entity, n.a), b = compileValue(store, entity, n.b);
  if (!a || !b) return null;
  const scale = commonScale(a, b);
  return { sql: `(${scaleTo(a, scale)} ${n.op} ${scaleTo(b, scale)})`, scale };
}

function compileIf(store, entity, n) {
  const cond = compileBool(store, entity, n.args[0]);
  const a = compileValue(store, entity, n.args[1]), b = compileValue(store, entity, n.args[2]);
  if (!cond || !a || !b) return null;
  const scale = commonScale(a, b);
  return { sql: `(CASE WHEN ${cond} <> 0 THEN ${scaleTo(a, scale)} ELSE ${scaleTo(b, scale)} END)`, scale };
}

// scale === null is the wildcard of a bare `null` literal: it stays unscaled
// (SQL NULL times anything is still NULL) and never forces the other side's scale.
const commonScale = (a, b) => (a.scale == null ? (b.scale ?? 1) : b.scale == null ? a.scale : Math.max(a.scale, b.scale));
const scaleTo = (x, scale) => (x.sql === 'NULL' || x.scale === scale ? x.sql : `(${x.sql} * ${scale / x.scale})`);

// A boolean sub-expression: SQL text guaranteed to read as 0 or 1, never
// NULL — SQLite's own `<`/`>`/… yield NULL when an operand is NULL, but
// runtime/expr.mjs's evaluate() always resolves a null-involved comparison
// to a definite `false` (its one exception, `=`/`!=`, uses loose equality,
// where `null == null` is `true`) — the CASE below is that same table, so
// AND/OR/NOT composed from these below never see a NULL to propagate either.
function compileBool(store, entity, n) {
  if (n.t === 'bool') return n.v ? '1' : '0';
  if (isPlainPath(n)) {
    const f = store.field(entity, n.p[0]);
    return f && !f.derive && f.kind === 'bool' ? `(IFNULL("${f.name}",0) != 0)` : null;
  }
  if (n.t === 'un' && n.op === 'not') { const a = compileBool(store, entity, n.a); return a && `(NOT (${a}))`; }
  if (n.t === 'bin' && (n.op === 'and' || n.op === 'or')) {
    const a = compileBool(store, entity, n.a), b = compileBool(store, entity, n.b);
    return a && b && `(${a} ${n.op.toUpperCase()} ${b})`;
  }
  if (n.t === 'bin' && ['=', '!=', '<', '<=', '>', '>='].includes(n.op)) return compileCmp(store, entity, n);
  return null;
}

function compileCmp(store, entity, n) {
  const a = compileValue(store, entity, n.a), b = compileValue(store, entity, n.b);
  if (!a || !b) return null;
  const scale = commonScale(a, b), as = scaleTo(a, scale), bs = scaleTo(b, scale);
  if (n.op === '=') return `(CASE WHEN ${as} IS NULL AND ${bs} IS NULL THEN 1 WHEN ${as} IS NULL OR ${bs} IS NULL THEN 0 ELSE (${as} = ${bs}) END)`;
  if (n.op === '!=') return `(CASE WHEN ${as} IS NULL AND ${bs} IS NULL THEN 0 WHEN ${as} IS NULL OR ${bs} IS NULL THEN 1 ELSE (${as} != ${bs}) END)`;
  return `(CASE WHEN ${as} IS NULL OR ${bs} IS NULL THEN 0 ELSE (${as} ${n.op} ${bs}) END)`;
}

// The public entry point: an `agg` AST node (runtime/expr.mjs), evaluated in
// the scope of `entity` — or null when it (or anything it needs) falls
// outside the compilable shape documented at the top of this file.
export function compileAgg(store, entity, node) {
  if (node.t !== 'agg') return null;
  const via = store.childVia(node.entity, entity, node.via);
  if (!via) return null; // no direct link back — the one case query.mjs always kept unbatched
  if (node.fn === 'count') {
    const condSQL = node.body ? compileBool(store, node.entity, node.body) : null;
    if (node.body && !condSQL) return null;
    return { child: node.entity, via, fn: 'count', exprSQL: null, condSQL, scale: 1 };
  }
  const val = compileValue(store, node.entity, node.body);
  return val && { child: node.entity, via, fn: node.fn, exprSQL: val.sql, condSQL: null, scale: val.scale };
}

// Distinguishes two different aggregates that happen to share a (child, via)
// pair — `total := sum(Item: qty*price)` and `count := count(Item)` on the
// same Order both key off Item|order, but need separate cached maps.
export const aggKey = (c) => `${c.child}|${c.via}|${c.fn}|${c.exprSQL}|${c.condSQL}`;

function selectCols(c) {
  if (c.fn === 'count') return 'COUNT(*) AS v';
  if (c.fn === 'avg') return `SUM(${c.exprSQL}) AS v, COUNT(${c.exprSQL}) AS c`;
  return `${{ sum: 'SUM', min: 'MIN', max: 'MAX' }[c.fn]}(${c.exprSQL}) AS v`;
}

function finalizeOne(c, row) {
  if (c.fn === 'count') return Number(row.v ?? 0);
  if (c.fn === 'sum') return exact(Number(row.v ?? 0) / c.scale);
  if (c.fn === 'avg') { const n = Number(row.c ?? 0); return n ? exact(Number(row.v ?? 0) / c.scale / n) : null; }
  return row.v === null || row.v === undefined ? null : Number(row.v) / c.scale;
}

// One parent's value — used when no page-level batch (query.mjs's
// buildAggCache) already computed it, e.g. Store#get() on a single row. The
// SQL text is fixed for a given compiled shape (only the bound id varies),
// so this goes through Store#prepare's cache like every other read.
export function runAggOne(store, compiled, parentId) {
  let sql = `SELECT ${selectCols(compiled)} FROM "${compiled.child.toLowerCase()}" WHERE "${compiled.via}"=?`;
  if (compiled.condSQL) sql += ` AND (${compiled.condSQL} <> 0)`;
  return finalizeOne(compiled, store.prepare(sql).get(String(parentId)));
}

// Every parent id's value in one query per IN_CHUNK-sized slice, instead of
// fetching a single child row: `ids` with no matching children at all get
// the same empty-group default runtime/expr.mjs's own sum/count/avg/min/max
// would (0 for sum/count, null for avg/min/max) since GROUP BY never
// produces a row for a group with nothing in it.
export function runAggBatch(store, compiled, ids) {
  const empty = compiled.fn === 'sum' || compiled.fn === 'count' ? 0 : null;
  const map = new Map(ids.map((id) => [String(id), empty]));
  const table = compiled.child.toLowerCase();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK).map(String);
    let sql = `SELECT "${compiled.via}" AS grp, ${selectCols(compiled)} FROM "${table}" WHERE "${compiled.via}" IN (${chunk.map(() => '?').join(',')})`;
    if (compiled.condSQL) sql += ` AND (${compiled.condSQL} <> 0)`;
    sql += ` GROUP BY "${compiled.via}"`;
    for (const row of store.db.prepare(sql).all(...chunk)) map.set(String(row.grp), finalizeOne(compiled, row));
  }
  return map;
}
