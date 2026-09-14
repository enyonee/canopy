// Scalar functions of the expression algebra. Each entry: arity (a number or
// [min, max]), kind(argKinds) — the result kind or a thrown type error — and
// run(args) — the value. Aggregates (sum, count, avg, min, max over an entity)
// are grammar, not functions, and stay in expr.mjs. A plugin adds a function
// with the same shape.
const NUMERIC = new Set(['number', 'money']);
const dayMs = 86_400_000;
// days() counts calendar days: a timestamp is its date, the hours never make a day negative.
const toDate = (v) => (v == null || v === '' ? null : new Date(`${String(v).slice(0, 10)}T00:00:00Z`));
export const truthy = (v) => v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
const needNumber = (fn, k) => { if (!NUMERIC.has(k) && k !== 'any') throw new Error(`${fn}() needs a number, got ${k}`); };
const firstKnown = (ks) => ks.find((k) => k !== 'any') || 'any';

export const FUNCTIONS = {
  if: { arity: 3, kind: (ks) => (ks[1] === 'any' ? ks[2] : ks[1]), run: (a) => (truthy(a[0]) ? a[1] : a[2]) },
  days: { arity: 2,
    kind: (ks) => { for (const k of ks) if (!['date', 'time', 'any'].includes(k)) throw new Error(`days() needs dates, got ${k}`); return 'number'; },
    run: (a) => { const x = toDate(a[0]), y = toDate(a[1]); return x && y ? Math.round((x - y) / dayMs) : null; } },
  round: { arity: [1, 2], kind: (ks) => { needNumber('round', ks[0]); return ks[0] === 'any' ? 'number' : ks[0]; },
    run: (a) => { if (a[0] == null) return null; const m = 10 ** (a[1] || 0); return Math.round(a[0] * m) / m; } },
  abs: { arity: 1, kind: (ks) => { needNumber('abs', ks[0]); return ks[0] === 'any' ? 'number' : ks[0]; },
    run: (a) => (a[0] == null ? null : Math.abs(a[0])) },
  min: { arity: 2, kind: firstKnown, run: (a) => (a[0] == null ? a[1] : a[1] == null ? a[0] : Math.min(a[0], a[1])) },
  max: { arity: 2, kind: firstKnown, run: (a) => (a[0] == null ? a[1] : a[1] == null ? a[0] : Math.max(a[0], a[1])) },
  coalesce: { arity: [2, 9], kind: firstKnown, run: (a) => a.find((x) => x !== null && x !== undefined && x !== '') ?? null },
  len: { arity: 1, kind: () => 'number', run: (a) => (a[0] == null ? 0 : String(a[0]).length) },
  lower: { arity: 1, kind: () => 'text', run: (a) => (a[0] == null ? null : String(a[0]).toLowerCase()) },
  upper: { arity: 1, kind: () => 'text', run: (a) => (a[0] == null ? null : String(a[0]).toUpperCase()) },
  concat: { arity: [1, 9], kind: () => 'text', run: (a) => a.map((x) => (x == null ? '' : String(x))).join('') },
  not: { arity: 1, kind: () => 'bool', run: (a) => !truthy(a[0]) },
  addDays: { arity: 2,
    kind: (ks) => { if (!['date', 'any'].includes(ks[0])) throw new Error(`addDays() needs a date first, got ${ks[0]}`); needNumber('addDays', ks[1]); return 'date'; },
    run: (a) => { const d = toDate(a[0]); if (!d || a[1] == null) return null; d.setUTCDate(d.getUTCDate() + Math.round(a[1])); return d.toISOString().slice(0, 10); } },
};
