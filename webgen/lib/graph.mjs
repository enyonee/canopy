// Reading the graph the way the runtime does, without importing the runtime: field specs, labels and the
// permission vocabulary. The OpenAPI contract says how a value travels (its JSON type); app.json says what the
// field means (required, its default, a derived expression, the rules that guard it).

/** "createdAt" → "Created at": the caption of a field, sentence case. */
export function title(name) {
  const words = String(name).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().split(/\s+/);
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join(' ');
}

/** "OrderItem" → "Order item"; the runtime's own plural rule. */
export const plural = (word) => (/[^aeiou]y$/i.test(word) ? `${word.slice(0, -1)}ies`
  : /(s|x|z|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`);

/**
 * One field spec of `data`: `text!`, `int=0`, `enum[a,b]=a`, `ref:User!`, `money := sum(...)`.
 * @returns {{ name: string, kind: string, required: boolean, default: string|null, derived: string|null, options: string[]|null, target: string|null }}
 */
export function parseSpec(name, spec) {
  const s = String(spec).trim();
  const d = /^(\w+)\s*:=\s*(.+)$/.exec(s);
  if (d) return { name, kind: d[1], required: false, default: null, derived: d[2].trim(), options: null, target: null };
  const m = /^(ref:(\w+)|enum\[([^\]]*)\]|\w+)([!?])?(?:=(.*))?$/.exec(s);
  if (!m) throw new Error(`webgen: cannot read the spec of ${name}: "${spec}"`);
  const kind = m[2] ? 'ref' : m[3] !== undefined ? 'enum' : m[1];
  return {
    name, kind, required: m[4] === '!', default: m[5] ?? null, derived: null,
    options: m[3] !== undefined ? m[3].split(',').map((o) => o.trim()).filter(Boolean) : null,
    target: m[2] || null,
  };
}

/** The label field of an entity: its first text field, as the runtime picks it. */
export const labelField = (fields) => fields.find((f) => f.kind === 'text' && !f.derived)?.name ?? null;

// A rule `check` the browser can also judge before posting: "<field> <op> <number>". Anything richer stays the
// server's (the form shows its 400 answer).
const SIMPLE = /^\s*(\w+)\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)\s*$/;

/** The simple bounds the rules of an entity put on its fields: { field: [{ op, value, message }] }. */
export function ruleBounds(rules = []) {
  const out = {};
  for (const r of rules) {
    const m = r.check && SIMPLE.exec(r.check);
    if (!m) continue;
    (out[m[1]] ||= []).push({ op: m[2], value: Number(m[3]), message: r.message || `${title(m[1])} must be ${m[2]} ${m[3]}` });
  }
  return out;
}

/** Fields named in a `unique` rule: the form says the value must be new; the server decides. */
export function uniqueFields(rules = []) {
  return rules.flatMap((r) => (typeof r.unique === 'string' ? [r.unique] : []));
}
