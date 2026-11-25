// The JSON Schemas of the OpenAPI contract (runtime/contract.mjs): what a row looks like in a JSON answer and what a
// JSON body may send. Pure over the parsed fields; the shapes are the ones the routes already write:
//   a row     rowJSON (runtime/render.mjs): `id`, every stored and derived field except secrets; money a major-unit
//             number, a bool a boolean, a reference the raw id (text), anything else as stored; any value may be null
//             (an optional field, or a `private` field the viewer may not read)
//   a body    the values a form posts (routes/context.mjs's jsonBody turns a JSON scalar into that text)

// Component names: an entity is its own name; what the runtime adds is namespaced so no entity name can collide.
export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
export const ERROR = 'canopy.Error';

const nullable = (s) => ({ ...s, type: [s.type, 'null'] });

// The type a stored value has in JSON, by the kind's own storage when the kernel does not convert it.
function base(f) {
  if (f.kind === 'money') return { type: 'number' };
  if (f.kind === 'bool') return { type: 'boolean' };
  if (f.kind === 'enum') return { type: 'string', enum: f.options };
  if (f.kind === 'date') return { type: 'string', format: 'date' };
  if (f.kind === 'time') return { type: 'string', format: 'date-time' };
  if (f.kind === 'ref') return { type: 'string', 'x-canopy-ref': f.target };
  if (f.type.sql === 'INTEGER') return { type: 'integer' };
  if (f.type.sql === 'REAL') return { type: 'number' };
  return { type: 'string' };
}

/** One field as a JSON answer reads it. */
function fieldSchema(f) {
  const s = { ...nullable(base(f)), 'x-canopy-kind': f.kind };
  if (f.derive) s.readOnly = true;
  if (f.type.upload) s.description = `the stored file name; download it at /file/<Entity>/<id>/${f.name}`;
  return s;
}

/**
 * A row as every /api answer writes it: always every key, `id` first, and `_labels`, the caption of each reference in
 * `captioned` that is not null (routes/load.mjs's jsonRows). An entity with its own `_labels` field has no captions.
 */
export function rowSchema(fields, captioned) {
  const shown = fields.filter((f) => !f.type.secret);
  const properties = { id: { type: 'integer', readOnly: true } };
  for (const f of shown) properties[f.name] = fieldSchema(f);
  const required = ['id', ...shown.map((f) => f.name)];
  if (!properties._labels) {
    properties._labels = { type: 'object', readOnly: true, additionalProperties: false, description: 'the caption of each reference the row names, as the app shows it',
      properties: Object.fromEntries(captioned.map((f) => [f.name, { type: 'string', 'x-canopy-ref': f.target }])) };
    required.push('_labels');
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// One field as a JSON body may send it. A reference also takes the numeric id; null is the empty value.
function inputField(f) {
  if (f.kind === 'ref') return { type: ['string', 'integer', 'null'], 'x-canopy-ref': f.target, 'x-canopy-kind': f.kind };
  const out = { ...nullable(base(f)), 'x-canopy-kind': f.kind };
  if (f.type.secret) out.writeOnly = true;
  return out;
}

/**
 * The fields a body may set: stored, not uploaded (a JSON body carries no file), not the status an entity's
 * transitions own, minus what the caller leaves out; `only` is a declared form list. Which of them a role may
 * really write (byRole, `own`, the role field) is the route's decision, made per request and not repeated here.
 */
export function writableFields(fields, { only = null, skip = [] } = {}) {
  return fields.filter((f) => !f.derive && !f.type.upload && !skip.includes(f.name) && (!only || only.includes(f.name)));
}

/** A body of named fields; `open` lets the steps read `values.<name>` beyond the declared ones. */
export function inputSchema(fields, { required = [], open = false } = {}) {
  const properties = {};
  for (const f of fields) properties[f.name] = inputField(f);
  const s = { type: 'object', properties, additionalProperties: open };
  if (required.length) s.required = required;
  return s;
}

/** The global action's fields: no entity to type them, plain required text. */
export function textInput(names) {
  return { type: 'object', properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])), required: names, additionalProperties: true };
}

const list = (items) => ({ type: 'array', items });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });

/** A page of rows (GET /Entity, /list/<id>). */
export const pageSchema = (row) => obj({ rows: list(row), total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' } });

/** A write that names its row: create, edit, an action, a transition, a related add. */
export const savedSchema = (row) => obj({ ok: { const: true }, id: { type: 'integer' }, created: { type: 'integer' }, flash: { type: 'string' }, row },
  ['ok', 'id', 'flash', 'row']);

/** Sign-in, registration, sign-out: the user the session now belongs to (null once signed out). */
export const signedSchema = (user) => obj({ ok: { const: true }, flash: { type: 'string' }, user: { oneOf: [user, { type: 'null' }] }, role: { type: ['string', 'null'] } });

// A dashboard group by a reference carries its caption.
const groupCaption = { type: 'object', properties: { grp: { type: 'string' } }, additionalProperties: false, description: 'present when the group is a reference' };

/** What the runtime itself answers, the same for every app. */
export function commonSchemas() {
  return {
    [ERROR]: obj({ ok: { const: false }, status: { type: 'integer' }, errors: list({ type: 'string' }) }),
    'canopy.Deleted': obj({ ok: { const: true }, id: { type: 'integer' }, flash: { type: 'string' } }),
    'canopy.Done': obj({ ok: { const: true }, created: { type: 'integer' }, flash: { type: 'string' } }, ['ok', 'flash']),
    'canopy.Dashboard': obj({
      cards: list(obj({ title: { type: 'string' }, value: { type: 'number' } })),
      tables: list(obj({ title: { type: 'string' }, rows: list({ type: 'object', properties: { _labels: groupCaption } }) })),
      charts: list(obj({ title: { type: 'string' }, type: { type: 'string' }, rows: list(obj({ grp: {}, v: { type: ['number', 'null'] }, _labels: groupCaption }, ['grp', 'v'])) })),
    }),
    'canopy.Search': obj({ results: list(obj({ entity: { type: 'string' }, rows: list({ type: 'object' }) })) }),
  };
}
