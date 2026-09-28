// The expression half of the SQL compiler behind runtime/store/aggsql.mjs: turns
// the body/condition of `count/sum/avg/min/max(Child: …)` into SQL text, or
// returns null for anything that cannot be proven identical to what
// runtime/expr.mjs's evaluate() computes — null is always safe, the row-fetching
// path answers instead.
//
// A value is { sql, scale, text?, dusty? }. Numbers stay exact SQLite INTEGERs in
// their own scale (money = raw minor units, scale 100; int/bool/literal, scale 1;
// `a * b` multiplies scales, `a + b` brings both to the larger one) and are only
// divided once, by the caller, at the very end — never inside a body. `text` marks
// a `date`/`time` value (ISO text, compared exactly as evaluate() compares the
// strings: SQLite's BINARY collation is code-unit order for ASCII). `scale: null`
// is the wildcard of a bare `null` literal.
//
// `dusty`: evaluate() multiplies the *major-unit doubles* (qty * 0.07 is
// 7.000000000000001), while this compiler multiplies exact integers. A sum absorbs
// that (evaluate() rounds it, `exact()`), and so do `+`/`-` and a derived field's
// storage rounding. A comparison of a raw product against an exactly equal value does
// not: `qty * price > disc` is true in JS and false here when qty=3, price=0.1,
// disc=0.3 — the SQL answer is the decimal one. That divergence shipped in 0.1.2 and
// is kept as it is (the answers of a route do not change in a performance round; see
// CHANGELOG). What this round adds never widens it: a nested min/max over a dusty
// body, whose raw double would meet a comparison, is not compiled.
//
// A derived field of the child is inlined (its own expression compiled in the
// child's scope), a derived or written-out aggregate over a grandchild becomes a
// correlated scalar subquery. Both are bounded (MAX_STACK, MAX_DEPTH, and MAX_EXPANSIONS
// for the work of one plan — a derived field used five times per level doubles every level)
// and a derived field met again while it is being inlined stops the compile, so a
// cycle can never loop here; the JS path raises its own error for it, as before.

const MAX_STACK = 8; // derived fields inlined inside one another
const MAX_DEPTH = 5; // nested subqueries
export const MAX_EXPANSIONS = 200; // derived fields inlined + subqueries built for one aggregate: a graph cannot make the compiler exponential
const MAX_SCALE = 1e6; // exact() (rounds to 6 decimals) is the identity up to here, so integers stay faithful
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T[0-9:.Zz+-]*$/;
const CMP = ['=', '!=', '<', '<=', '>', '>='];

const isPlainPath = (n) => n.t === 'path' && n.p.length === 1;
const isNum = (v) => !v.text && v.scale !== null;
const int = (sql) => ({ sql, scale: 1 });

// scale === null is the wildcard of a bare `null` literal: it stays unscaled
// (SQL NULL times anything is still NULL) and never forces the other side's scale.
const commonScale = (a, b) => (a.scale == null ? (b.scale ?? 1) : b.scale == null ? a.scale : Math.max(a.scale, b.scale));
const scaleTo = (x, scale) => (x.sql === 'NULL' || x.text || x.scale === scale ? x.sql : `(${x.sql} * ${scale / x.scale})`);
// Two operands may meet when both are numbers, both are date/time text, or one is a bare null.
const agree = (a, b) => (a.text ? !isNum(b) : b.text ? !isNum(a) : true);

// A value sub-expression, or null when this node (or anything under it) is not representable.
function compileValue(cx, n) {
  if (n.t === 'num') return Number.isSafeInteger(n.v) ? int(String(n.v)) : null;
  if (n.t === 'null') return { sql: 'NULL', scale: null };
  if (n.t === 'str') return DATE.test(n.v) || TIME.test(n.v) ? { sql: `'${n.v}'`, text: true } : null;
  if (isPlainPath(n)) return compileField(cx, n.p[0]);
  if (n.t === 'un' && n.op === '-') { const a = compileValue(cx, n.a); return a && isNum(a) ? { ...a, sql: `(-(${a.sql}))` } : null; }
  if (n.t === 'bin') return compileBin(cx, n);
  if (n.t === 'call' && n.fn === 'if') return compileIf(cx, n);
  if (n.t === 'agg') return compileSubAgg(cx, n);
  return null;
}

// `today` / `now` are the evaluation's one clock, bound as a named parameter
// (aggsql.mjs) — the same Date evaluate() reads, never SQLite's own clock.
function compileField(cx, name) {
  if (name === 'today') { cx.params.add('$today'); return { sql: '$today', text: true }; }
  if (name === 'now') { cx.params.add('$now'); return { sql: '$now', text: true }; }
  if (name === 'id') return int('"id"');
  const f = cx.store.field(cx.entity, name);
  if (!f) return null;
  if (f.derive) return compileDerived(cx, f);
  const sql = `"${f.name}"`;
  if (f.kind === 'money') return { sql, scale: 100 };
  if (f.kind === 'int' || f.kind === 'bool') return int(sql);
  return f.kind === 'date' || f.kind === 'time' ? { sql, text: true } : null;
}

// A derived field as the stored value Store#derived would hand back (`fromExpr`),
// read the way ctx.get() reads it (`toExpr`): a money field is rounded to whole
// minor units, which is the identity for scale 1 and 100 and would need real
// rounding for a money*money product — so that one is refused, and so is an int
// fed by a money expression.
function compileDerived(cx, f) {
  const key = `${cx.entity}.${f.name}`;
  if (cx.stack.includes(key) || cx.stack.length >= MAX_STACK || --cx.budget.left < 0) return null;
  const inner = { ...cx, stack: [...cx.stack, key] };
  if (f.kind === 'bool') { const c = compileBool(inner, f.derive); return c && int(c); }
  const v = compileValue(inner, f.derive);
  if (!v) return null;
  const clean = { ...v, dusty: false };
  if (f.kind === 'date' || f.kind === 'time') return v.text ? clean : null;
  if (v.text || (f.kind !== 'int' && f.kind !== 'money')) return null;
  const s = v.scale ?? 1;
  if (f.kind === 'int') return s === 1 ? clean : null;
  return s === 1 ? { sql: `(${v.sql} * 100)`, scale: 100 } : s === 100 ? clean : null;
}

function compileBin(cx, n) {
  if (n.op !== '+' && n.op !== '-' && n.op !== '*') return null; // division and comparisons are never a value
  const a = compileValue(cx, n.a), b = compileValue(cx, n.b);
  if (!a || !b || a.text || b.text) return null;
  if (n.op === '*') {
    const dusty = Boolean(a.dusty || b.dusty || (a.scale ?? 1) > 1 || (b.scale ?? 1) > 1);
    return { sql: `(${a.sql} * ${b.sql})`, scale: (a.scale ?? 1) * (b.scale ?? 1), dusty };
  }
  const scale = commonScale(a, b);
  return scale > MAX_SCALE ? null : { sql: `(${scaleTo(a, scale)} ${n.op} ${scaleTo(b, scale)})`, scale };
}

function compileIf(cx, n) {
  const cond = compileBool(cx, n.args[0]);
  const a = compileValue(cx, n.args[1]), b = compileValue(cx, n.args[2]);
  if (!cond || !a || !b || !agree(a, b)) return null;
  const scale = a.text || b.text ? undefined : commonScale(a, b);
  const sql = `(CASE WHEN ${cond} <> 0 THEN ${scaleTo(a, scale)} ELSE ${scaleTo(b, scale)} END)`;
  return { sql, scale, text: a.text || b.text, dusty: Boolean(a.dusty || b.dusty) };
}

// A boolean sub-expression: SQL text guaranteed to read as 0 or 1, never NULL —
// SQLite's own `<`/`>`/… yield NULL when an operand is NULL, but evaluate() always
// resolves a null-involved comparison to a definite `false` (its one exception,
// `=`/`!=`, uses loose equality, where `null == null` is `true`) — the CASE below is
// that same table, so AND/OR/NOT composed from these never see a NULL to propagate.
function compileBool(cx, n) {
  if (n.t === 'bool') return n.v ? '1' : '0';
  if (isPlainPath(n)) {
    const f = cx.store.field(cx.entity, n.p[0]);
    if (!f || f.kind !== 'bool') return null;
    return f.derive ? compileDerived(cx, f)?.sql ?? null : `(IFNULL("${f.name}",0) != 0)`;
  }
  if (n.t === 'un' && n.op === 'not') { const a = compileBool(cx, n.a); return a && `(NOT (${a}))`; }
  if (n.t === 'bin' && (n.op === 'and' || n.op === 'or')) {
    const a = compileBool(cx, n.a), b = compileBool(cx, n.b);
    return a && b && `(${a} ${n.op.toUpperCase()} ${b})`;
  }
  return n.t === 'bin' && CMP.includes(n.op) ? compileCmp(cx, n) : null;
}

function compileCmp(cx, n) {
  const a = compileValue(cx, n.a), b = compileValue(cx, n.b);
  if (!a || !b || !agree(a, b)) return null;
  const scale = a.text || b.text ? undefined : commonScale(a, b), as = scaleTo(a, scale), bs = scaleTo(b, scale);
  if (n.op === '=') return `(CASE WHEN ${as} IS NULL AND ${bs} IS NULL THEN 1 WHEN ${as} IS NULL OR ${bs} IS NULL THEN 0 ELSE (${as} = ${bs}) END)`;
  if (n.op === '!=') return `(CASE WHEN ${as} IS NULL AND ${bs} IS NULL THEN 0 WHEN ${as} IS NULL OR ${bs} IS NULL THEN 1 ELSE (${as} != ${bs}) END)`;
  return `(CASE WHEN ${as} IS NULL OR ${bs} IS NULL THEN 0 ELSE (${as} ${n.op} ${bs}) END)`;
}

// The pieces of `node` (an `agg` AST node evaluated in the scope of cx.entity, whose
// row's table is aliased t<cx.depth>): the child's via column, the SQL of the body
// (`exprSQL`) or of the condition of a count (`condSQL`), the scale, and whether the
// value is date/time text — or null when any of it is not representable.
export function compileBody(cx, node) {
  if (cx.depth >= MAX_DEPTH || --cx.budget.left < 0) return null;
  const via = childViaOrNull(cx.store, node.entity, cx.entity, node.via);
  if (!via) return null;
  const inner = { ...cx, entity: node.entity, depth: cx.depth + 1 };
  if (node.fn === 'count') {
    const condSQL = node.body ? compileBool(inner, node.body) : null;
    return node.body && !condSQL ? null : { via, exprSQL: null, condSQL, scale: 1 };
  }
  const v = compileValue(inner, node.body);
  if (!v || (v.text && (node.fn === 'sum' || node.fn === 'avg'))) return null;
  return { via, exprSQL: v.sql, condSQL: null, scale: v.scale ?? 1, text: v.text, dusty: v.dusty };
}

// A nested aggregate — written out in a body, or the expression of a derived
// aggregate field of the child — as one correlated scalar subquery: sum and count of
// no rows are 0 (COALESCE, like evaluate()'s reduce), min/max of no rows are NULL
// (null, as evaluate()). An avg is a fraction: the JS path keeps it. The join is on
// the id as TEXT because a ref column is stored as TEXT (fields.mjs) and only a
// TEXT-to-TEXT comparison can use the ref's index.
function compileSubAgg(cx, n) {
  const b = compileBody(cx, n);
  if (!b || n.fn === 'avg' || (n.fn === 'sum' && b.scale > MAX_SCALE) || (b.dusty && n.fn !== 'sum' && n.fn !== 'count')) return null;
  const from = `FROM "${n.entity.toLowerCase()}" AS t${cx.depth + 1} WHERE t${cx.depth + 1}."${b.via}" = CAST(t${cx.depth}."id" AS TEXT)`
    + (b.condSQL ? ` AND (${b.condSQL} <> 0)` : '');
  if (n.fn === 'count') return int(`(SELECT COUNT(*) ${from})`);
  if (n.fn === 'sum') return { sql: `COALESCE((SELECT SUM(${b.exprSQL}) ${from}), 0)`, scale: b.scale };
  return { sql: `(SELECT ${n.fn.toUpperCase()}(${b.exprSQL}) ${from})`, scale: b.scale, text: b.text };
}

// The same lookup Store#childVia does, except that a nonsense link (the graph checker rejects
// it, a hand-built Store may not) declines to compile instead of throwing from
// inside a body: the JS path raises the identical error, when it actually reaches it.
function childViaOrNull(store, child, parent, via) {
  try { return store.childVia(child, parent, via); }
  catch { return null; } // allow-swallow: declining to compile; the JS path raises the same error when it evaluates the aggregate
}
