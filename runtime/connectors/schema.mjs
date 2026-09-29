// The schema language of connector descriptors: a small JSON-Schema subset, pure
// data in and problems out. `checkSchema` says what is wrong with a schema (an
// unknown keyword is an error, never ignored); `validate` says what is wrong with a
// value. Both return a list of [path, message] pairs, empty when all is well.
//
// Keywords: type (object array string integer number boolean null), properties,
// required, additionalProperties (boolean; false unless declared, whenever
// `properties` is), items, enum, format (email date-time uri), minLength, maxLength,
// pattern, minimum, maximum. Annotations: default, title, description, and
// `message` (the text a failure at this node reports, "{value}" is the value) and `hint`.
const TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const FORMATS = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  'date-time': (v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(v) && !Number.isNaN(Date.parse(v)),
  uri: (v) => { try { return Boolean(new URL(v)); } catch { return false; } },
};
const ANNOTATIONS = ['default', 'title', 'description', 'message', 'hint'];
export const KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'format', 'minLength', 'maxLength',
  'pattern', 'minimum', 'maximum', ...ANNOTATIONS];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const join = (path, key) => `${path}/${key}`;

const typeOk = {
  object: isObject, array: Array.isArray, string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean',
  integer: Number.isInteger, number: (v) => typeof v === 'number' && Number.isFinite(v), null: (v) => v === null,
};

// Shape rules for the keywords whose value must have a particular form.
const SHAPES = {
  type: (v) => (TYPES.includes(v) ? null : `"type" is one of ${TYPES.join(', ')}`),
  required: (v) => (Array.isArray(v) && v.every((k) => typeof k === 'string') ? null : '"required" is a list of property names'),
  additionalProperties: (v) => (typeof v === 'boolean' ? null : '"additionalProperties" is true or false'),
  enum: (v) => (Array.isArray(v) && v.length ? null : '"enum" is a non-empty list'),
  format: (v) => (FORMATS[v] ? null : `"format" is one of ${Object.keys(FORMATS).join(', ')}`),
  minLength: (v) => (isCount(v) ? null : '"minLength" is a whole number, 0 or more'),
  maxLength: (v) => (isCount(v) ? null : '"maxLength" is a whole number, 0 or more'),
  minimum: (v) => (typeof v === 'number' && Number.isFinite(v) ? null : '"minimum" is a number'),
  maximum: (v) => (typeof v === 'number' && Number.isFinite(v) ? null : '"maximum" is a number'),
  message: (v) => (typeof v === 'string' ? null : '"message" is a string'),
  hint: (v) => (typeof v === 'string' ? null : '"hint" is a string'),
  pattern: (v) => {
    if (typeof v !== 'string') return '"pattern" is a string';
    try { new RegExp(v); return null; } catch (e) { return `"pattern" is not a regular expression: ${e.message}`; }
  },
};

/** What is wrong with a schema. `[[path, message]]`; empty when it is a valid schema of the subset. */
export function checkSchema(schema, path = '') {
  if (!isObject(schema)) return [[path, 'a schema is an object']];
  const out = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.includes(key)) { out.push([join(path, key), `unknown schema keyword "${key}"`, `keywords: ${KEYWORDS.join(', ')}`]); continue; }
    const bad = SHAPES[key]?.(value);
    if (bad) out.push([join(path, key), bad]);
  }
  out.push(...checkChildren(schema, path));
  if (schema.default !== undefined && !out.length) out.push(...validate(schema, schema.default, join(path, 'default'), { extra: true }));
  return out;
}

function checkChildren(schema, path) {
  const out = [];
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) out.push([join(path, 'properties'), '"properties" is an object of schemas']);
    else for (const [k, s] of Object.entries(schema.properties)) out.push(...checkSchema(s, `${join(path, 'properties')}/${k}`));
    const known = isObject(schema.properties) ? Object.keys(schema.properties) : [];
    for (const k of Array.isArray(schema.required) ? schema.required : []) if (!known.includes(k)) out.push([join(path, 'required'), `required "${k}" is not among the properties`]);
  } else if (Array.isArray(schema.required) && schema.required.length) out.push([join(path, 'required'), '"required" needs "properties"']);
  if (schema.items !== undefined) out.push(...checkSchema(schema.items, join(path, 'items')));
  return out;
}

const fail = (schema, path, text, value) => [[path, schema.message ? schema.message.replace('{value}', String(value)) : text, ...(schema.hint ? [schema.hint] : [])]];

function checkString(schema, value, path) {
  const out = [];
  if (schema.minLength !== undefined && value.length < schema.minLength) out.push(...fail(schema, path, `must be at least ${schema.minLength} characters`, value));
  if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(...fail(schema, path, `must be at most ${schema.maxLength} characters`, value));
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(...fail(schema, path, `must match ${schema.pattern}`, value));
  if (schema.format !== undefined && !FORMATS[schema.format](value)) out.push(...fail(schema, path, `must be a valid ${schema.format}`, value));
  return out;
}

function checkNumber(schema, value, path) {
  const out = [];
  if (schema.minimum !== undefined && value < schema.minimum) out.push(...fail(schema, path, `must be at least ${schema.minimum}`, value));
  if (schema.maximum !== undefined && value > schema.maximum) out.push(...fail(schema, path, `must be at most ${schema.maximum}`, value));
  return out;
}

function checkObject(schema, value, path, opts) {
  const out = [];
  const props = schema.properties;
  for (const k of schema.required || []) if (value[k] === undefined) out.push(...fail(props?.[k] || {}, join(path, k), 'is required', ''));
  if (!props) return out;
  const extra = schema.additionalProperties ?? opts.extra;
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    if (props[k]) out.push(...validate(props[k], v, join(path, k), opts));
    else if (!extra) out.push(...fail({}, join(path, k), `unknown property "${k}"`, k));
  }
  return out;
}

/**
 * What is wrong with a value. `opts.extra` is what "additionalProperties" defaults to: false
 * (inputs and configuration are closed) unless the caller says otherwise (a provider's answer).
 */
export function validate(schema, value, path = '', opts = { extra: false }) {
  if (schema.type !== undefined && !typeOk[schema.type](value)) return fail(schema, path, `must be ${schema.type === 'object' ? 'an object' : `a ${schema.type}`}`, value);
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return fail(schema, path, `must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`, value);
  if (typeof value === 'string') return checkString(schema, value, path);
  if (typeof value === 'number') return checkNumber(schema, value, path);
  if (Array.isArray(value)) return schema.items ? value.flatMap((v, i) => validate(schema.items, v, join(path, i), opts)) : [];
  return isObject(value) ? checkObject(schema, value, path, opts) : [];
}

/** `value` with every declared default filled in where the property is missing (objects only, recursively). */
export function withDefaults(schema, value) {
  if (!schema.properties || !isObject(value)) return value;
  const out = { ...value };
  for (const [k, s] of Object.entries(schema.properties)) {
    if (out[k] === undefined && s.default !== undefined) out[k] = s.default;
    else if (out[k] !== undefined) out[k] = withDefaults(s, out[k]);
  }
  return out;
}
