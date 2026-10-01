// The request side of an OpenAPI operation: its parameters and its body become the descriptor's `input` schema and
// the request template. Pure. A thing the request cannot be built without (a required parameter, a required body)
// that cannot be mapped makes the whole operation unusable (`null`, reported); an optional one is left out, reported.
import { deref } from './oas_schema.mjs';

const SCALARS = ['string', 'integer', 'number', 'boolean'];
const RESERVED = ['accept', 'content-type', 'authorization'];
export const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const IDEM = /idempotency[-_]?key/i;
const NAME = /^[A-Za-z_][\w-]*$/;
const FORM = 'application/x-www-form-urlencoded';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mediaOf = (t) => t.split(';')[0].trim().toLowerCase();
/** The first media type of a `content` map that is JSON (application/json or +json), or undefined. */
export const jsonOf = (types) => types.find((t) => mediaOf(t) === 'application/json' || mediaOf(t).endsWith('+json'));

/** A name a template can use: letters, digits, "_" and "-", not starting with a digit. */
export const sanitize = (s) => { const t = String(s).replace(/[^\w-]/g, '_'); return /^[A-Za-z_]/.test(t) ? t : `_${t}`; };

/** `base`, or `base_2`, `base_3`… the first not in `taken`. */
export function unique(base, taken) {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

// The parameters of a path item and of its operation, references followed; the operation's win by name and place.
function collect(ctx, lists) {
  const byKey = new Map();
  lists.forEach(([list, where]) => {
    (Array.isArray(list) ? list : []).forEach((raw, i) => {
      const p = deref(ctx.spec, raw, `${where}/${i}`, ctx.note);
      if (isObject(p) && typeof p.name === 'string' && typeof p.in === 'string') byKey.set(`${p.in}:${p.name}`, [p, `${where}/${i}`]);
      else if (p !== null) ctx.note(`${where}/${i}`, 'a parameter without a name and a place is left out');
    });
  });
  return [...byKey.values()];
}

// Why this parameter cannot be mapped (`why`), or the scalar schema it is given (`schema`).
function inspect(ctx, p, at) {
  if (!['path', 'query', 'header'].includes(p.in)) return { why: p.in === 'cookie' ? 'is a cookie: a descriptor sets no cookies' : `is in "${p.in}", which is not a place` };
  if (p.in === 'path' && p.style !== undefined && p.style !== 'simple') return { why: `has style "${p.style}": only the default style is mapped` };
  if (p.in === 'header' && (RESERVED.includes(p.name.toLowerCase()) || !TOKEN.test(p.name))) return { why: 'is a header that OpenAPI ignores or a header name that cannot be sent' };
  if (p.schema === undefined) return { why: 'has no schema: its type is not known' };
  const schema = ctx.read(p.schema, `${at}/schema`);
  if (!SCALARS.includes(schema.type)) return { why: 'is not a string, number, integer or boolean: it cannot be written into a url or a header' };
  if (p.in === 'query' && p.required !== true && schema.default === undefined) return { why: 'is optional and a url template cannot leave a query parameter out when it is absent: add it by hand' };
  return { schema };
}

// One parameter into the build: an input, and where its value goes. False when the operation cannot be called without it.
function place(ctx, p, at, b) {
  const required = p.required === true || p.in === 'path';
  const { why, schema } = inspect(ctx, p, at);
  if (why) { ctx.note(at, `parameter "${p.name}" ${why}`); return !required; }
  if (p.allowReserved === true) ctx.note(at, `parameter "${p.name}": allowReserved is ignored, the value is always percent-encoded`);
  if (p.in === 'header' && IDEM.test(p.name)) {
    const bound = /^[A-Za-z0-9-]+$/.test(p.name) && (ctx.idem.header ?? p.name).toLowerCase() === p.name.toLowerCase();
    if (bound) { ctx.idem.header ??= p.name; b.idem = true; return true; }
    ctx.note(at, `parameter "${p.name}" cannot be the idempotency header (one name, letters, digits and "-", for the whole descriptor): it stays an input`);
  }
  const name = unique(sanitize(p.name), b.taken);
  b.taken.add(name);
  if (p.description !== undefined && schema.description === undefined) schema.description = p.description;
  b.props.set(name, schema);
  if (required) b.required.push(name);
  const ref = { $: `input.${name}` };
  if (p.in === 'path') b.path.set(p.name, name);
  else if (p.in === 'query') b.query.push(`${encodeURIComponent(p.name)}={input.${name}}`);
  else b.headers[p.name.toLowerCase()] = ref;
  return true;
}

// The path with `{id}` as `{input.id}`; null when a placeholder has no path parameter or a stray brace is left.
function urlOf(pathKey, b) {
  const parts = pathKey.split(/\{([^}]*)\}/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) { if (!b.path.has(parts[i])) return null; out.push(`{input.${b.path.get(parts[i])}}`); } else if (/[{}]/.test(parts[i])) return null;
    else out.push(parts[i]);
  }
  return out.join('') + (b.query.length ? `?${b.query.join('&')}` : '');
}

/**
 * The parameters of an operation into a build `{ props, required, headers, url, idem }`, or null when it cannot be called.
 * `lists` is [[parameters, pointer of the list]…], the path item's first. `ctx` is { spec, note, read, idem: { header } }
 * (`idem.header` is the one idempotency header of the whole descriptor).
 */
export function mapParams(ctx, pathKey, lists, at) {
  const b = { props: new Map(), required: [], headers: {}, path: new Map(), query: [], taken: new Set(), idem: false };
  for (const [p, where] of collect(ctx, lists)) if (!place(ctx, p, where, b)) return null;
  b.url = urlOf(pathKey, b);
  if (b.url === null) { ctx.note(at, `the path ${pathKey} names a parameter that is not declared as a path parameter: the operation is left out`); return null; }
  return b;
}

// The content of a request body: JSON, else a form; null when it has neither.
function chooseMedia(content) {
  const types = Object.keys(content);
  const json = jsonOf(types);
  const form = types.find((t) => mediaOf(t) === FORM);
  return { media: json ?? form, form: json === undefined && form !== undefined, types };
}

/**
 * The request body into the build `b` (its input, its template and encoding); false when the operation cannot be called
 * without a body it cannot map. A body that is an object with plain property names becomes inputs of its own, any other
 * (a list, a name that a template cannot use, a clash with a parameter) is the one input `body`.
 */
export function mapBody(ctx, raw, at, b) {
  if (raw === undefined) return true;
  const rb = deref(ctx.spec, raw, at, ctx.note);
  const content = isObject(rb?.content) ? rb.content : {};
  const { media, form, types } = chooseMedia(content);
  const required = rb === null || rb.required === true;
  if (media === undefined) {
    ctx.note(`${at}/content`, `no media type is mapped (${types.join(', ') || 'none'}): application/json and application/x-www-form-urlencoded are`);
    return !required;
  }
  const others = types.filter((t) => t !== media);
  if (others.length) ctx.note(`${at}/content`, `${others.join(', ')} not mapped: the body is sent as ${media}`);
  const sAt = `${at}/content/${media.replace(/\//g, '~1')}/schema`;
  const schema = content[media]?.schema === undefined ? {} : ctx.read(content[media].schema, sAt, true);
  const objectLike = schema.type === 'object' || schema.properties !== undefined;
  if (form && !objectLike) { ctx.note(sAt, 'a form body must be an object: the body is left out'); return !required; }
  if (form) b.encoding = 'form';
  const names = Object.keys(schema.properties || {});
  if (names.length && names.every((k) => NAME.test(k) && !b.taken.has(k))) {
    const extra = deref(ctx.spec, content[media].schema, sAt, () => {});
    if (isObject(extra) && extra.additionalProperties !== undefined && extra.additionalProperties !== false) ctx.note(sAt, 'properties other than the declared ones are not accepted: the body is made of the declared inputs');
    names.forEach((k) => { b.taken.add(k); b.props.set(k, schema.properties[k]); });
    b.required.push(...(schema.required || []));
    b.body = Object.fromEntries(names.map((k) => [k, { $: `input.${k}` }]));
    return true;
  }
  const name = unique('body', b.taken);
  b.taken.add(name);
  if (rb.description !== undefined && schema.description === undefined) schema.description = rb.description;
  b.props.set(name, schema);
  if (required) b.required.push(name);
  b.body = { $: `input.${name}` };
  return true;
}
