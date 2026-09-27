// The calculator itself: two pure functions over the expression text, registered
// as expression functions so a derived field can hold the result and a rule can
// refuse an expression that does not parse. Nothing here touches the store.
//
//   calc(expression, kind)     the result as text ("4", "2.5"), null when invalid
//   isValid(expression, kind)  whether the expression parses in that calculation type
//
// kinds: basic       numbers, + - * / and parentheses, unary minus
//        scientific  basic plus ^ (power), sqrt() abs() sin() cos() log(), pi and e
//        percentage  basic plus a postfix % (15% = 0.15)
const tokenize = (src) => {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[a-z]/i.test(c)) {
      const m = /^[a-z]+/i.exec(src.slice(i));
      out.push({ t: 'id', v: m[0].toLowerCase() }); i += m[0].length; continue;
    }
    if ('+-*/^%(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected "${c}" at ${i}`);
  }
  out.push({ t: 'end' });
  return out;
};

const FUNCS = { sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, log: Math.log10 };
const CONSTS = { pi: Math.PI, e: Math.E };

const evaluate = (src, kind) => {
  const toks = tokenize(String(src ?? ''));
  const sci = kind === 'scientific', pct = kind === 'percentage';
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v) => peek().t === 'op' && peek().v === v;
  const expect = (v) => { if (!isOp(v)) throw new Error(`expected "${v}"`); next(); };
  const add = () => { let a = mul(); while (isOp('+') || isOp('-')) { const op = next().v; const b = mul(); a = op === '+' ? a + b : a - b; } return a; };
  const mul = () => { let a = unary(); while (isOp('*') || isOp('/')) { const op = next().v; const b = unary(); a = op === '*' ? a * b : a / b; } return a; };
  const unary = () => { if (isOp('-')) { next(); return -unary(); } return power(); };
  const power = () => { const a = postfix(); if (sci && isOp('^')) { next(); return a ** unary(); } return a; };
  const postfix = () => { let a = primary(); while (pct && isOp('%')) { next(); a /= 100; } return a; };
  const primary = () => {
    const tk = next();
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'op' && tk.v === '(') { const v = add(); expect(')'); return v; }
    if (tk.t === 'id' && sci) {
      if (tk.v in CONSTS && !isOp('(')) return CONSTS[tk.v];
      if (tk.v in FUNCS) { expect('('); const v = add(); expect(')'); return FUNCS[tk.v](v); }
    }
    throw new Error(`unexpected ${tk.t === 'end' ? 'end of expression' : `"${tk.v}"`}`);
  };
  const v = add();
  if (peek().t !== 'end') throw new Error(`unexpected "${peek().v}"`);
  return v;
};

const format = (v) => {
  if (!Number.isFinite(v)) return 'not a number';
  const n = Number(v.toPrecision(12));
  return Number.isInteger(n) ? String(n) : String(n);
};

const textArgs = (fn) => (ks) => { for (const k of ks) if (k !== 'text' && k !== 'any') throw new Error(`${fn}() takes text, got ${k}`); };

export default {
  functions: {
    calc: {
      arity: 2,
      kind: (ks) => { textArgs('calc')(ks); return 'text'; },
      run: ([src, kind]) => { if (src == null || String(src).trim() === '') return null; try { return format(evaluate(src, kind)); } catch { return null; } },
    },
    isValid: {
      arity: 2,
      kind: (ks) => { textArgs('isValid')(ks); return 'bool'; },
      run: ([src, kind]) => { if (src == null || String(src).trim() === '') return false; try { evaluate(src, kind); return true; } catch { return false; } },
    },
  },
};
