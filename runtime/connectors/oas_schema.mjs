// The schemas of an OpenAPI document, read as the schema subset of runtime/connectors/schema.mjs. Pure.
// `$ref` is followed inside the document only (`#/components/...`); a cycle is cut where it comes back (that schema
// is `{}`). What the subset cannot say is dropped, and every drop that changes what a value may be is reported
// through `note(path, message)`; only pure annotations (example, readOnly, x-…) go quietly. Never a guess.
import { checkSchema } from './schema.mjs';

const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const FORMATS = ['email', 'date-time', 'uri'];
const PLAIN = ['enum', 'format', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'default', 'title', 'description'];
const KNOWN = [...PLAIN, 'type', 'properties', 'required', 'additionalProperties', 'items', 'const', 'nullable', 'allOf', 'oneOf', 'anyOf', 'not', '$ref'];
const QUIET = ['example', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'xml', 'externalDocs', 'discriminator'];
// What an allOf member may hold for the merge to say exactly what the members say together.
const MERGEABLE = ['type', 'properties', 'required', 'additionalProperties', 'title', 'description'];
const MAX_DEPTH = 48;
const MAX_NODES = 20000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What a local reference `#/a/b` points at in `spec`, or undefined (not local, not there, or a malformed escape). */
function pointer(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let at = spec;
  for (const raw of ref.slice(2).split('/')) {
    let key;
    try { key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return undefined; } // allow-swallow: a malformed escape is an unresolved reference, which the caller reports
    if (!isObject(at) && !Array.isArray(at)) return undefined;
    if (!Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/** `node` with its `$ref` chain followed (parameters, bodies, responses); null, reported, when it cannot be. */
export function deref(spec, node, path, note) {
  const seen = new Set();
  let at = node;
  while (isObject(at) && typeof at.$ref === 'string') {
    const ref = at.$ref;
    if (seen.has(ref)) { note(path, `$ref cycle through ${ref}: cut`); return null; }
    seen.add(ref);
    at = pointer(spec, ref);
    if (at === undefined) { note(path, `$ref "${ref}" is not followed: only references into this document (#/components/...) are`); return null; }
  }
  return at;
}

// The type keyword: a list (3.1) loses `null`, and `nullable` (3.0) is dropped: either way null is no longer accepted.
function typeOf(node, path, note) {
  let type = node.type;
  let nullable = node.nullable === true;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes('null');
    const rest = type.filter((t) => t !== 'null');
    if (rest.length > 1) { note(`${path}/type`, `a type list (${type.join(', ')}) cannot be said: "type" dropped`); return undefined; }
    type = rest.length ? rest[0] : 'null';
    if (nullable && rest.length) note(`${path}/type`, 'null is no longer accepted: the subset has one type per schema');
    nullable = false;
  }
  if (nullable) note(`${path}/nullable`, 'nullable dropped: null is no longer accepted');
  if (type !== undefined && !TYPES.includes(type)) { note(`${path}/type`, `unknown type "${type}": "type" dropped`); return undefined; }
  return type;
}

// A node's own keywords, in a fixed order, as the subset says them (children are read by the caller).
function ownKeywords(node, path, note) {
  const out = {};
  const type = typeOf(node, path, note);
  if (type !== undefined) out.type = type;
  for (const k of ['title', 'description']) if (node[k] !== undefined) out[k] = node[k];
  if (FORMATS.includes(node.format)) out.format = node.format;
  if (node.enum !== undefined) out.enum = node.enum;
  else if (node.const !== undefined) out.enum = [node.const];
  for (const k of ['default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern']) if (node[k] !== undefined) out[k] = node[k];
  for (const k of Object.keys(node)) {
    if (KNOWN.includes(k) || QUIET.includes(k) || k.startsWith('x-') || k.startsWith('$')) continue;
    note(`${path}/${k}`, `"${k}" is not in the descriptor's schema subset: dropped`);
  }
  return out;
}

// Drop each keyword the subset's own checker refuses (a default that does not fit, a bad pattern, a negative length…).
function fitSubset(out, path, note) {
  for (;;) {
    const { properties, items, required, ...own } = out;
    const bad = checkSchema(own);
    if (!bad.length) return;
    const key = bad[0][0].split('/')[1];
    delete out[key];
    note(`${path}/${key}`, `"${key}" dropped: ${bad[0][1]}`);
  }
}

// allOf of plain objects merged; anything else cannot be said exactly, so it is omitted whole (`{}`).
function merge(list, path, note) {
  const parts = list.filter((s) => Object.keys(s).length);
  const meta = {};
  for (const k of ['title', 'description']) { const s = parts.find((p) => p[k] !== undefined); if (s) meta[k] = s[k]; }
  const real = parts.filter((s) => Object.keys(s).some((k) => !(k in meta)));
  if (real.length < 2) return real.length ? { ...real[0], ...meta } : meta;
  if (!parts.every((s) => (s.type === undefined || s.type === 'object') && Object.keys(s).every((k) => MERGEABLE.includes(k)))) {
    note(`${path}/allOf`, 'an allOf that is not made of plain objects is omitted');
    return {};
  }
  const props = new Map();
  for (const s of parts) {
    for (const [k, v] of Object.entries(s.properties || {})) {
      if (props.has(k) && !same(props.get(k), v)) { note(`${path}/allOf`, `an allOf whose members disagree about "${k}" is omitted`); return {}; }
      props.set(k, v);
    }
  }
  const out = { type: 'object' };
  Object.assign(out, meta);
  if (props.size) out.properties = Object.fromEntries(props);
  const required = [...new Set(parts.flatMap((s) => s.required || []))];
  if (required.length) out.required = required;
  const extra = parts.filter((s) => s.additionalProperties !== undefined).map((s) => s.additionalProperties);
  if (extra.length && extra.every((e) => e === extra[0])) out.additionalProperties = extra[0];
  else if (extra.length) note(`${path}/allOf`, 'the members of an allOf disagree about additionalProperties: dropped');
  return out;
}

/**
 * A reader of the schemas in `spec`. `read(node, path, open)` is the subset schema for an OpenAPI schema; `open` says an
 * object that lists properties accepts others unless it says otherwise (the OpenAPI default; the subset's is closed),
 * which is what a request body wants.
 */
export function schemaReader(spec, note) {
  const budget = { nodes: 0, told: false };
  const cut = (path, why) => { if (!budget.told) note(path, why); budget.told = true; return {}; };

  function follow(ref, path, ctx) {
    const target = pointer(spec, ref);
    if (target === undefined) { note(path, `$ref "${ref}" is not followed: only references into this document (#/components/...) are`); return {}; }
    if (ctx.stack.includes(ref)) { note(path, `$ref cycle: ${ref} comes back to itself, cut here`); return {}; }
    return read(target, path, { ...ctx, stack: [...ctx.stack, ref] });
  }

  function children(node, out, path, ctx) {
    if (isObject(node.properties)) {
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, read(v, `${path}/properties/${k}`, ctx)]));
    } else if (node.properties !== undefined) note(`${path}/properties`, '"properties" is not an object: dropped');
    if (isObject(node.items)) out.items = read(node.items, `${path}/items`, ctx);
    else if (node.items !== undefined) note(`${path}/items`, 'a list of item schemas (a tuple) cannot be said: "items" dropped');
    const names = Object.keys(out.properties || {});
    const required = (Array.isArray(node.required) ? node.required : []).filter((k) => names.includes(k));
    if (required.length) out.required = required;
    if (Array.isArray(node.required) && required.length < node.required.length) note(`${path}/required`, 'names without a declared property are dropped from "required"');
    const extra = node.additionalProperties;
    if (typeof extra === 'boolean') out.additionalProperties = extra;
    else if (isObject(extra)) {
      if (Object.keys(extra).length) note(`${path}/additionalProperties`, 'a schema for the other properties cannot be said: they are not checked');
      out.additionalProperties = true;
    } else if (ctx.open && out.properties) out.additionalProperties = true;
  }

  function read(node, path, ctx) {
    if (++budget.nodes > MAX_NODES || ctx.depth > MAX_DEPTH) return cut(path, 'the schemas are too large or too deep: the rest is read as {}');
    if (node === true) return {};
    if (!isObject(node)) { note(path, 'a schema that is not an object is read as {}'); return {}; }
    if (typeof node.$ref === 'string') return follow(node.$ref, path, ctx);
    const deeper = { ...ctx, depth: ctx.depth + 1 };
    const out = ownKeywords(node, path, note);
    children(node, out, path, deeper);
    fitSubset(out, path, note);
    const members = [];
    for (const k of ['oneOf', 'anyOf']) {
      if (node[k] === undefined) continue;
      if (Array.isArray(node[k]) && node[k].length === 1) members.push([`${path}/${k}/0`, node[k][0]]);
      else note(`${path}/${k}`, `${k} with ${Array.isArray(node[k]) ? node[k].length : 0} alternatives is omitted`);
    }
    if (node.not !== undefined) note(`${path}/not`, '"not" is omitted');
    const all = Array.isArray(node.allOf) ? node.allOf.map((m, i) => [`${path}/allOf/${i}`, m]) : [];
    if (node.allOf !== undefined && !Array.isArray(node.allOf)) note(`${path}/allOf`, '"allOf" is not a list: omitted');
    const list = [...all, ...members].map(([p, m]) => read(m, p, deeper));
    return list.length ? merge([out, ...list], path, note) : out;
  }

  return { read: (node, path, open = false) => read(node, path, { stack: [], depth: 0, open }) };
}
