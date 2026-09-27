// The closed expression algebra. Arithmetic, field paths, aggregates over child
// rows, and the scalar functions of the registry. No calls out, no state, no way
// to reach past the row it is evaluated on — every computation is a pure leaf.
//
//   qty * price                      fields of the current row
//   customer.discount                one hop through a reference
//   sum(OrderItem: qty * price)      aggregate over rows of OrderItem that point here
//   count(Activity.lead: done)       explicit reverse reference, optional condition
//   if(total > 100, 0, 9.9)          a function; days(end, start); round(x, 2)
//   today, now                       the clock, read-only
//
// Scalars are number, money, text, bool, date, time, ref (an id). Money is read
// and written in major units (12.34) here; storage in minor units is the store's
// business, not the language's.
import { FUNCTIONS, truthy, family } from './functions.mjs';

const AGG = new Set(['sum', 'count', 'avg', 'min', 'max']);
const NUMERIC = new Set(['number', 'money']);

// --- tokens ------------------------------------------------------------------
const tokenize = (src) => {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m[0]), at: i }); i += m[0].length; continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end === -1) throw new Error(`unterminated string at ${i}`);
      out.push({ t: 'str', v: src.slice(i + 1, end), at: i }); i = end + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0], at: i }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '!=', '=='].includes(two)) { out.push({ t: 'op', v: two === '==' ? '=' : two, at: i }); i += 2; continue; }
    if ('+-*/()<>=,.:'.includes(c)) { out.push({ t: 'op', v: c, at: i }); i++; continue; }
    throw new Error(`unexpected character "${c}" at ${i}`);
  }
  out.push({ t: 'end', at: src.length });
  return out;
};

// --- parser (precedence climbing) --------------------------------------------
export function parse(src, functions = FUNCTIONS) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('empty expression');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v) => peek().t === 'op' && peek().v === v;
  const isWord = (v) => peek().t === 'id' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`expected "${v}" at ${peek().at}`); return next(); };

  const or = () => { let a = and(); while (isWord('or')) { next(); a = { t: 'bin', op: 'or', a, b: and() }; } return a; };
  const and = () => { let a = not(); while (isWord('and')) { next(); a = { t: 'bin', op: 'and', a, b: not() }; } return a; };
  const not = () => { if (isWord('not')) { next(); return { t: 'un', op: 'not', a: not() }; } return cmp(); };
  const cmp = () => {
    const a = add();
    if (peek().t === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(peek().v)) {
      const op = next().v; return { t: 'bin', op, a, b: add() };
    }
    return a;
  };
  const add = () => { let a = mul(); while (isOp('+') || isOp('-')) { const op = next().v; a = { t: 'bin', op, a, b: mul() }; } return a; };
  const mul = () => { let a = unary(); while (isOp('*') || isOp('/')) { const op = next().v; a = { t: 'bin', op, a, b: unary() }; } return a; };
  const unary = () => { if (isOp('-')) { next(); return { t: 'un', op: '-', a: unary() }; } return primary(); };
  const primary = () => {
    const tk = next();
    if (tk.t === 'num') return { t: 'num', v: tk.v };
    if (tk.t === 'str') return { t: 'str', v: tk.v };
    if (tk.t === 'op' && tk.v === '(') { const e = or(); expect(')'); return e; }
    if (tk.t === 'id') {
      if (tk.v === 'true' || tk.v === 'false') return { t: 'bool', v: tk.v === 'true' };
      if (tk.v === 'null') return { t: 'null' };
      if (isOp('(')) return call(tk.v);
      const path = [tk.v];
      while (isOp('.')) { next(); const s = next(); if (s.t !== 'id') throw new Error(`expected a name after "." at ${s.at}`); path.push(s.v); }
      return { t: 'path', p: path };
    }
    throw new Error(`unexpected ${tk.t === 'end' ? 'end of expression' : `"${tk.v}"`} at ${tk.at}`);
  };
  const call = (fn) => {
    expect('(');
    // Aggregate form: fn(Entity[.via][: body])
    if (AGG.has(fn) && peek().t === 'id' && /^[A-Z]/.test(peek().v)) {
      const save = p;
      const ent = next().v;
      let via = null;
      if (isOp('.')) { next(); via = next().v; }
      if (isOp(':') || isOp(')')) {
        let body = null;
        if (isOp(':')) { next(); body = or(); }
        expect(')');
        if (fn !== 'count' && !body) throw new Error(`${fn}(${ent}) needs a body: ${fn}(${ent}: field)`);
        return { t: 'agg', fn, entity: ent, via, body };
      }
      p = save;
    }
    const args = [];
    if (!isOp(')')) { args.push(or()); while (isOp(',')) { next(); args.push(or()); } }
    expect(')');
    if (AGG.has(fn) && (fn === 'sum' || fn === 'avg' || fn === 'count'))
      throw new Error(`${fn}() aggregates rows: write ${fn}(Entity: field)`);
    const def = functions[fn];
    if (!def) throw new Error(`unknown function "${fn}"; known: ${Object.keys(functions).join(', ')}, and sum/count/avg/min/max over an entity`);
    const [lo, hi] = Array.isArray(def.arity) ? def.arity : [def.arity, def.arity];
    if (args.length < lo || args.length > hi) throw new Error(`${fn}() takes ${lo === hi ? lo : `${lo}–${hi}`} argument(s), got ${args.length}`);
    return { t: 'call', fn, args };
  };

  const ast = or();
  if (peek().t !== 'end') throw new Error(`unexpected "${peek().v}" at ${peek().at}`);
  return ast;
}

// --- static check ------------------------------------------------------------
// scope.field(path) -> kind, or throws; scope.children(entity, via) -> child scope, or throws.
export function check(ast, scope, functions = FUNCTIONS) {
  const kindOf = (n) => {
    switch (n.t) {
      case 'num': return 'number';
      // A literal that is written like a date is a date: "when > '2026-01-01'" and
      // days('2026-03-31', x) are legal, and mean what they read as.
      case 'str':
        if (/^\d{4}-\d{2}-\d{2}$/.test(n.v)) return 'date';
        if (/^\d{4}-\d{2}-\d{2}T/.test(n.v)) return 'time';
        return 'text';
      case 'bool': return 'bool';
      case 'null': return 'any';
      case 'path':
        if (n.p.length === 1 && n.p[0] === 'today') return 'date';
        if (n.p.length === 1 && n.p[0] === 'now') return 'time';
        return scope.field(n.p);
      case 'un': {
        const k = kindOf(n.a);
        if (n.op === '-') { if (!NUMERIC.has(k) && k !== 'any') throw new Error(`unary "-" needs a number, got ${k}`); return k; }
        return 'bool';
      }
      case 'bin': {
        const a = kindOf(n.a), b = kindOf(n.b);
        if (['+', '-', '*', '/'].includes(n.op)) {
          for (const k of [a, b]) if (!NUMERIC.has(k) && k !== 'any')
            throw new Error(`"${n.op}" needs numbers, got ${k}${k === 'text' ? ' (use concat() for text)' : ''}`);
          if (n.op === '/' && a === 'money' && b === 'money') return 'number';
          return a === 'money' || b === 'money' ? 'money' : 'number';
        }
        if (['and', 'or'].includes(n.op)) return 'bool';
        // Comparisons are closed too: numbers meet numbers, dates meet dates, text meets text.
        const fa = family(a), fb = family(b);
        if (fa && fb && fa !== fb && !(['=', '!='].includes(n.op) && (fa === 'bool' || fb === 'bool')))
          throw new Error(`"${n.op}" compares ${a} with ${b}; they are different kinds`);
        return 'bool';
      }
      case 'call': return functions[n.fn].kind(n.args.map(kindOf));
      default: {
        const child = scope.children(n.entity, n.via);
        if (!n.body) return 'number';
        // Inside the body, "row.x" is the outer row: a correlated aggregate.
        const inner = { field: (p) => (p[0] === 'row' && p.length > 1 ? scope.field(p.slice(1)) : child.field(p)), children: child.children };
        const k = check(n.body, inner, functions);
        if (n.fn === 'count') return 'number';
        if ((n.fn === 'min' || n.fn === 'max') && ['date', 'time'].includes(k)) return k;
        if (!NUMERIC.has(k) && k !== 'any') throw new Error(`${n.fn}(${n.entity}: …) needs a number${n.fn === 'min' || n.fn === 'max' ? ' or a date' : ''}, got ${k}`);
        return k;
      }
    }
  };
  return kindOf(ast);
}

// --- evaluation --------------------------------------------------------------
// ctx.get(path) -> value; ctx.rows(entity, via) -> array of child ctx.
export function evaluate(ast, ctx, functions = FUNCTIONS) {
  // One clock per evaluation: "now = now" is a tautology, and an expression cannot
  // straddle midnight halfway through.
  const clock = ctx.clock || new Date();
  // Money reaches the algebra in major units, so sums of cents pick up binary dust:
  // 10.10 + 20.20 must be 30.30, not 30.299999999999997.
  const exact = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);
  const ev = (n) => {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'null': return null;
      case 'path':
        if (n.p.length === 1 && n.p[0] === 'today') return clock.toISOString().slice(0, 10);
        if (n.p.length === 1 && n.p[0] === 'now') return clock.toISOString();
        return ctx.get(n.p);
      case 'un': {
        const a = ev(n.a);
        if (n.op === 'not') return !truthy(a);
        return a == null ? null : -a;
      }
      case 'bin': {
        if (n.op === 'and') return truthy(ev(n.a)) && truthy(ev(n.b));
        if (n.op === 'or') return truthy(ev(n.a)) || truthy(ev(n.b));
        const a = ev(n.a), b = ev(n.b);
        switch (n.op) {
          case '=': return a == b; // eslint-disable-line eqeqeq
          case '!=': return a != b; // eslint-disable-line eqeqeq
        }
        if (a == null || b == null) return n.op === '<' || n.op === '<=' || n.op === '>' || n.op === '>=' ? false : null;
        switch (n.op) {
          case '+': return exact(a + b);
          case '-': return exact(a - b);
          case '*': return a * b;
          case '/': return b === 0 ? null : a / b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          default: return a >= b;
        }
      }
      case 'call': return functions[n.fn].run(n.args.map(ev));
      default: {
        const rows = ctx.rows(n.entity, n.via).map((r) => ({ get: (p) => (p[0] === 'row' && p.length > 1 ? ctx.get(p.slice(1)) : r.get(p)), rows: r.rows, clock }));
        if (n.fn === 'count') return n.body ? rows.filter((r) => truthy(evaluate(n.body, r, functions))).length : rows.length;
        const vals = rows.map((r) => evaluate(n.body, r, functions)).filter((v) => v !== null && v !== undefined);
        if (n.fn === 'sum') return exact(vals.reduce((a, b) => a + b, 0));
        if (!vals.length) return null;
        if (n.fn === 'avg') return exact(vals.reduce((a, b) => a + b, 0) / vals.length);
        if (typeof vals[0] === 'string') return vals.reduce((a, b) => (n.fn === 'min' ? (b < a ? b : a) : (b > a ? b : a)));
        if (n.fn === 'min') return Math.min(...vals);
        return Math.max(...vals);
      }
    }
  };
  return ev(ast);
}

export const isExpression = (v) => typeof v === 'string' && v.startsWith('=');
export const stripExpression = (v) => v.slice(1).trim();
