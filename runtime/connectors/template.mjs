// Templates of connector descriptors: substitution and nothing else — no conditionals,
// no expressions. A string holds `{config.x}`, `{input.x.y}`, `{secret.x}`, `{base}`,
// `{key}`; the object `{"$": "input.x"}` stands for the whole value (any type, an
// absent one leaves its property out); the property "..." of an object spreads an
// object into it. `pick` reads a `$.a.b[0]` path out of a response. Pure functions.
export const SCOPES = ['config', 'input', 'secret', 'base', 'key'];
const NAME = /^[A-Za-z_][\w-]*$/;

/** One reference, `input.a.b` → { scope: 'input', path: ['a', 'b'] }; throws on anything else. */
export function parseRef(body, whole = false) {
  const [scope, ...path] = body.split('.');
  if (!SCOPES.includes(scope)) throw new Error(`unknown name "${body}" in a template (scopes: ${SCOPES.join(', ')})`);
  const bare = scope === 'base' || scope === 'key';
  const wholeOk = whole && (scope === 'input' || scope === 'config');
  if (bare ? path.length : path.some((p) => !NAME.test(p)) || (!path.length && !wholeOk))
    throw new Error(`"${body}" is not a reference (${scope} needs ${bare ? 'no name' : 'a name'})`);
  return { scope, path };
}

/** A string template as parts: literal strings and references. */
export function parse(text) {
  const parts = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{', at);
    if (open < 0) { parts.push(text.slice(at)); break; }
    if (open > at) parts.push(text.slice(at, open));
    const close = text.indexOf('}', open);
    if (close < 0) throw new Error(`unclosed "{" in template "${text}"`);
    parts.push(parseRef(text.slice(open + 1, close)));
    at = close + 1;
  }
  return parts;
}

const isWhole = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '$' in v;

/** Every reference a template structure makes, in order; throws on a malformed template. */
export function refs(value) {
  if (typeof value === 'string') return parse(value).filter((p) => typeof p !== 'string');
  if (Array.isArray(value)) return value.flatMap(refs);
  if (isWhole(value)) return [parseRef(String(value.$), true)];
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(refs);
  return [];
}

const secretGone = (name) => { throw new Error(`secret "${name}" cannot be resolved: the secret store is not available yet`); };

function lookup({ scope, path }, scopes) {
  if (scope === 'secret') return (scopes.secret || secretGone)(path[0]);
  if (scope === 'base' || scope === 'key') {
    if (scopes[scope] === undefined) throw new Error(`{${scope}} has no value here`);
    return scopes[scope];
  }
  return path.reduce((v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined), scopes[scope]);
}

const text = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') throw new Error('a string template embeds only a string, number or boolean; use {"$": "…"} for a whole value');
  return String(v);
};

/** The value of a template structure under `scopes` ({ config, input, base, key, secret(name) }). */
export function expand(value, scopes) {
  if (typeof value === 'string') return parse(value).map((p) => (typeof p === 'string' ? p : text(lookup(p, scopes)))).join('');
  if (Array.isArray(value)) return value.map((v) => expand(v, scopes) ?? null);
  if (isWhole(value)) return lookup(parseRef(String(value.$), true), scopes);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const x = expand(v, scopes);
    if (k === '...') {
      if (x !== undefined && (x === null || typeof x !== 'object' || Array.isArray(x))) throw new Error('"..." spreads an object');
      Object.assign(out, x);
    } else if (x !== undefined) out[k] = x;
  }
  return out;
}

// A url template. `{input.*}` and `{key}` are data, so each is percent-encoded whole
// (encodeURIComponent: "/", "?", "#", "%", ".." and non-ASCII cannot leave their segment);
// `{config.*}`, `{base}` and literals are the descriptor's and the operator's own, and stay raw.
export function expandUrl(template, scopes) {
  return parse(template).map((p) => {
    if (typeof p === 'string') return p;
    const v = text(lookup(p, scopes));
    return p.scope === 'input' || p.scope === 'key' ? encodeURIComponent(v) : v;
  }).join('');
}

/**
 * Why a url template lets data choose where the request goes, or null. The origin (scheme, host, port)
 * comes only from literals, `{config.*}` and `{base}`: an `{input.*}` or `{key}` must come after the
 * first "/" that follows the origin.
 */
export function originProblem(template) {
  const shape = parse(template).map((p) => (typeof p === 'string' ? p : p.scope === 'input' || p.scope === 'key' ? '\u0000' : 'X')).join('');
  const scheme = shape.indexOf('://');
  const end = shape.indexOf('/', scheme < 0 ? 0 : scheme + 3);
  const first = shape.indexOf('\u0000');
  if (first < 0) return null;
  return end < 0 || first < end ? '{input.*} and {key} may only appear after the first "/" following the host: data must never choose where the request goes' : null;
}

const STEP = /\.([A-Za-z_][\w-]*)|\[(\d+)\]/y;

/** The path steps of `$.a.b[0]`, or throws. */
export function pathSteps(path) {
  if (typeof path !== 'string' || path[0] !== '$') throw new Error(`"${path}" is not a path: it starts with $`);
  const steps = [];
  STEP.lastIndex = 1;
  while (STEP.lastIndex < path.length) {
    const at = STEP.lastIndex;
    const m = STEP.exec(path);
    if (!m) throw new Error(`"${path}" is not a path: expected .name or [index] at ${at}`);
    steps.push(m[1] ?? Number(m[2]));
  }
  return steps;
}

/** What `$.a.b[0]` names inside `value`; undefined when it is not there. */
export function pick(path, value) {
  return pathSteps(path).reduce((v, k) => (v !== null && typeof v === 'object' ? v[k] : undefined), value);
}
