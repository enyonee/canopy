// Scalar functions of the expression algebra. Each entry: arity (a number or
// [min, max]), kind(argKinds) — the result kind or a thrown type error — and
// run(args) — the value. Aggregates (sum, count, avg, min, max over an entity)
// are grammar, not functions, and stay in expr.mjs. A plugin adds a function
// with the same shape.
const NUMERIC = new Set(['number', 'money']);
const dayMs = 86_400_000;
// days() counts calendar days: a timestamp is its date, the hours never make a day negative.
// An impossible date ("2026-13-45") must be null, never an Invalid Date: the algebra is total.
const toDate = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
export const truthy = (v) => v !== null && v !== undefined && v !== false && v !== 0 && v !== '';
const needNumber = (fn, k) => { if (!NUMERIC.has(k) && k !== 'any') throw new Error(`${fn}() needs a number, got ${k}`); };
const needText = (fn, k) => { if (!['text', 'any'].includes(k)) throw new Error(`${fn}() needs text, got ${k}`); };
// Which kinds may meet: numbers with numbers, dates with dates, text with text.
export const family = (k) => (NUMERIC.has(k) ? 'number' : ['date', 'time'].includes(k) ? 'date' : k === 'any' ? null : k);
// The kind of a set of arguments that must agree ("if" branches, "min"/"max", "coalesce").
const unify = (fn, ks) => {
  const known = ks.filter((k) => k !== 'any');
  if (!known.length) return 'any';
  const fams = [...new Set(known.map(family))];
  if (fams.length > 1) throw new Error(`${fn}() needs arguments of one kind, got ${[...new Set(known)].join(' and ')}`);
  return known.includes('money') ? 'money' : known[0];
};

/** @type {Record<string, import('./types.d.ts').FunctionType>} */
export const FUNCTIONS = {
  if: { arity: 3, kind: (ks) => unify('if', [ks[1], ks[2]]), run: (a) => (truthy(a[0]) ? a[1] : a[2]) },
  days: { arity: 2,
    kind: (ks) => { for (const k of ks) if (!['date', 'time', 'any'].includes(k)) throw new Error(`days() needs dates, got ${k}`); return 'number'; },
    run: (a) => { const x = toDate(a[0]), y = toDate(a[1]); return x && y ? Math.round((+x - +y) / dayMs) : null; } },
  round: { arity: [1, 2], kind: (ks) => { needNumber('round', ks[0]); if (ks.length > 1) needNumber('round', ks[1]); return ks[0] === 'any' ? 'number' : ks[0]; },
    run: (a) => { if (a[0] == null) return null; const m = 10 ** (a[1] || 0); return Math.round(a[0] * m) / m; } },
  abs: { arity: 1, kind: (ks) => { needNumber('abs', ks[0]); return ks[0] === 'any' ? 'number' : ks[0]; },
    run: (a) => (a[0] == null ? null : Math.abs(a[0])) },
  // min/max compare whatever they are given: numbers numerically, dates and text in order.
  min: { arity: 2, kind: (ks) => unify('min', ks), run: (a) => (a[0] == null ? a[1] : a[1] == null ? a[0] : (a[1] < a[0] ? a[1] : a[0])) },
  max: { arity: 2, kind: (ks) => unify('max', ks), run: (a) => (a[0] == null ? a[1] : a[1] == null ? a[0] : (a[1] > a[0] ? a[1] : a[0])) },
  coalesce: { arity: [2, 9], kind: (ks) => unify('coalesce', ks), run: (a) => a.find((x) => x !== null && x !== undefined && x !== '') ?? null },
  len: { arity: 1, kind: (ks) => { needText('len', ks[0]); return 'number'; }, run: (a) => (a[0] == null ? null : String(a[0]).length) },
  lower: { arity: 1, kind: (ks) => { needText('lower', ks[0]); return 'text'; }, run: (a) => (a[0] == null ? null : String(a[0]).toLowerCase()) },
  upper: { arity: 1, kind: (ks) => { needText('upper', ks[0]); return 'text'; }, run: (a) => (a[0] == null ? null : String(a[0]).toUpperCase()) },
  concat: { arity: [1, 9], kind: () => 'text', run: (a) => a.map((x) => (x == null ? '' : String(x))).join('') },
  addDays: { arity: 2,
    kind: (ks) => { if (!['date', 'any'].includes(ks[0])) throw new Error(`addDays() needs a date first, got ${ks[0]}`); needNumber('addDays', ks[1]); return 'date'; },
    run: (a) => { const d = toDate(a[0]); if (!d || a[1] == null) return null; d.setUTCDate(d.getUTCDate() + Math.round(a[1])); return d.toISOString().slice(0, 10); } },
};
