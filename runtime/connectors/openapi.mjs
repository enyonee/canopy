// OpenAPI import: a JSON OpenAPI 3.0/3.1 document in, `{ descriptor, unsupported }` out. Pure, layer 0.
// The descriptor is a draft for a human to review: it is `live` only and has no sandbox rules (the author adds them).
// Nothing is guessed: what is not mapped is listed in `unsupported` as `{ path, message }`, `path` a JSON pointer into
// the document. Whatever the input, the descriptor passes `checkDescriptor` or the list says why not (an operation
// the checker refuses is left out and listed). Input that is not an OpenAPI 3 document throws.
import { checkDescriptor, METHODS } from './descriptor.mjs';
import { schemaReader, deref } from './oas_schema.mjs';
import { mapParams, mapBody, sanitize, unique, jsonOf, TOKEN } from './oas_request.mjs';

const IDEMPOTENT = ['GET', 'PUT', 'DELETE'];
const LEFT_OUT = ['head', 'options', 'trace'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

// A security scheme as a header: { headers, slot }, or { why }. The secret is a slot `{secret.<scheme name>}`, never a value.
function schemeOf(ctx, name) {
  const found = Object.hasOwn(ctx.spec.components?.securitySchemes || {}, name) ? ctx.spec.components.securitySchemes[name] : undefined;
  const s = deref(ctx.spec, found, `#/components/securitySchemes/${esc(name)}`, ctx.note);
  if (!isObject(s)) return { why: `"${name}" is not a defined security scheme` };
  const slot = sanitize(name);
  const scheme = String(s.scheme).toLowerCase();
  if (s.type === 'apiKey' && s.in === 'header' && typeof s.name === 'string' && TOKEN.test(s.name)) return { slot, headers: { [s.name.toLowerCase()]: `{secret.${slot}}` } };
  if (s.type === 'apiKey') return { why: `"${name}" is an API key in ${s.in}: ${s.in === 'query' ? 'the secret would be in the url, which the outbox shows' : 'a descriptor sets no cookies'}` };
  if (s.type === 'http' && scheme === 'bearer') return { slot, headers: { authorization: `Bearer {secret.${slot}}` } };
  if (s.type === 'http' && scheme === 'basic') {
    ctx.note(`#/components/securitySchemes/${esc(name)}`, `basic authentication: a template cannot encode user:password, so the secret "${slot}" must hold base64(user:password) already`);
    return { slot, headers: { authorization: `Basic {secret.${slot}}` } };
  }
  return { why: `"${name}" (${s.type}${s.type === 'http' ? ` ${s.scheme}` : ''}) is not mapped: apiKey in a header, http bearer and http basic are` };
}

// The first security alternative every scheme of which can be mapped; none, reported, means no authentication.
function authOf(ctx, security, at) {
  const alts = Array.isArray(security) ? security.filter(isObject) : [];
  const whys = [];
  for (const alt of alts) {
    const got = Object.keys(alt).map((n) => schemeOf(ctx, n));
    const headers = got.flatMap((g) => Object.keys(g.headers || {}));
    if (got.every((g) => g.headers) && new Set(headers).size === headers.length) return Object.assign({}, ...got.map((g) => g.headers));
    whys.push(got.find((g) => g.why)?.why ?? 'two schemes write the same header');
  }
  if (alts.length) ctx.note(at, `no security alternative can be mapped (${whys.join('; ')}): the operation has no authentication`);
  return {};
}

// The schema of the first 2xx answer that is JSON; the others with a body are reported.
function outputOf(ctx, responses, at) {
  if (!isObject(responses)) return undefined;
  for (const code of Object.keys(responses).filter((c) => /^2(\d\d|XX)$/i.test(c)).sort()) {
    const r = deref(ctx.spec, responses[code], `${at}/${code}`, ctx.note);
    const types = isObject(r?.content) ? Object.keys(r.content) : [];
    const json = jsonOf(types);
    if (json !== undefined) {
      const out = r.content[json]?.schema === undefined ? {} : ctx.read(r.content[json].schema, `${at}/${code}/content/${esc(json)}/schema`);
      return Object.keys(out).length ? out : undefined;
    }
    if (types.length) ctx.note(`${at}/${code}/content`, `the answer is ${types.join(', ')}, not JSON: not mapped`);
  }
  return undefined;
}

function operationOf(ctx, pathKey, method, item, op, at) {
  const lists = [[item.parameters, `#/paths/${esc(pathKey)}/parameters`], [op.parameters, `${at}/parameters`]];
  const b = mapParams(ctx, pathKey, lists, at);
  if (b === null || !mapBody(ctx, op.requestBody, `${at}/requestBody`, b)) return null;
  const auth = authOf(ctx, op.security ?? ctx.spec.security, `${at}/security`);
  for (const k of Object.keys(auth)) if (Object.hasOwn(b.headers, k)) ctx.note(at, `the header "${k}" is a parameter and the authentication: the authentication wins`);
  const output = outputOf(ctx, op.responses, `${at}/responses`);
  // The engine sets a content type only for a form: a JSON body says so itself, and a JSON answer is asked for.
  const headers = { ...(output && { accept: 'application/json' }), ...(b.body !== undefined && !b.encoding && { 'content-type': 'application/json' }), ...b.headers, ...auth };
  const input = { type: 'object', properties: Object.fromEntries(b.props) };
  if (b.required.length) input.required = [...new Set(b.required)];
  const request = { method, url: `{base}${b.url}` };
  if (Object.keys(headers).length) request.headers = headers;
  if (b.body !== undefined) request.body = b.body;
  if (b.encoding) request.encoding = b.encoding;
  const summary = [op.summary, op.description].find((s) => typeof s === 'string' && s !== '');
  /** @type {any} */
  const out = { ...(summary && { summary }), idempotent: b.idem || IDEMPOTENT.includes(method), input, request };
  if (output) out.output = output;
  return out;
}

// What the document says the server is: the literal base, or (none usable) `{config.baseUrl}`, reported.
function baseOf(spec, note) {
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  const server = servers[0];
  let url = typeof server?.url === 'string' ? server.url : '';
  const vars = isObject(server?.variables) ? server.variables : {};
  url = url.replace(/\{([^}]*)\}/g, (all, v) => (Object.hasOwn(vars, v) && typeof vars[v]?.default === 'string' ? (note('#/servers/0/variables', `the server variable "${v}" is fixed to its default`), vars[v].default) : all));
  if (servers.length > 1) note('#/servers', 'only the first server is used');
  if (/^https?:\/\/[^{}\s]+$/.test(url)) return { base: url.replace(/\/+$/, '') };
  note('#/servers', `${servers.length ? `the first server "${url}" is not an absolute http(s) url` : 'the document has no servers'}: the base url is the connector's configuration, config.baseUrl`);
  const baseUrl = { type: 'string', format: 'uri', description: 'the base url of the API, https://host[/prefix]' };
  return { base: '{config.baseUrl}', config: { type: 'object', required: ['baseUrl'], properties: { baseUrl } } };
}

// Operations the checker refuses are left out and listed, so what is returned always passes it.
function enforce(d, origin, note) {
  for (;;) {
    const bad = new Map();
    for (const [p, m] of checkDescriptor(d)) {
      const op = /^\/operations\/([^/]+)/.exec(p)?.[1];
      if (op !== undefined && !bad.has(op)) bad.set(op, `${p}: ${m}`);
    }
    if (!bad.size) break;
    for (const [op, why] of bad) { delete d.operations[op]; note(origin.get(op), `the operation is left out, the descriptor checker refuses it (${why})`); }
  }
  if (!Object.keys(d.operations).length) note('#/paths', 'no operation could be imported: a descriptor needs at least one');
}

function addPath(ctx, pathKey, item, ops, origin) {
  const at = `#/paths/${esc(pathKey)}`;
  if (item.servers !== undefined) ctx.note(`${at}/servers`, 'servers of a path are not mapped: the base is the first server of the document');
  for (const m of LEFT_OUT) if (item[m] !== undefined) ctx.note(`${at}/${m}`, `${m.toUpperCase()} is not a method a descriptor can send: left out`);
  for (const method of METHODS) {
    const op = item[method.toLowerCase()];
    if (!isObject(op)) continue;
    const here = `${at}/${method.toLowerCase()}`;
    for (const k of ['callbacks', 'servers']) if (op[k] !== undefined) ctx.note(`${here}/${k}`, `${k} are not mapped`);
    const made = operationOf(ctx, pathKey, method, item, op, here);
    if (made === null) { ctx.note(here, 'the operation is left out'); continue; }
    const id = typeof op.operationId === 'string' && op.operationId !== '' ? sanitize(op.operationId)
      : [method.toLowerCase(), pathKey.replace(/[{}]/g, '').replace(/\W+/g, '_').replace(/^_+|_+$/g, '')].filter(Boolean).join('_');
    const name = unique(id, ops);
    ops.set(name, made);
    origin.set(name, here);
  }
}

/**
 * The descriptor an OpenAPI 3.0/3.1 document (parsed JSON) describes, and what could not be mapped.
 * @param {any} spec
 * @param {{ name: string }} opts the descriptor's name (lower case letters, digits, "-")
 * @returns {{ descriptor: any, unsupported: { path: string, message: string }[] }}
 */
export function importOpenapi(spec, { name } = { name: undefined }) {
  if (!isObject(spec)) throw new Error('not an OpenAPI document: expected a JSON object');
  if (spec.swagger !== undefined) throw new Error('this is a Swagger 2.0 document: only OpenAPI 3.0 and 3.1 are imported');
  if (typeof spec.openapi !== 'string' || !/^3\.[01](\.|$)/.test(spec.openapi)) throw new Error('not an OpenAPI 3.0 or 3.1 document: it has no "openapi": "3.0.x" or "3.1.x"');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('the descriptor needs a name: lower case letters, digits and "-"');
  const unsupported = [];
  const seen = new Set();
  const note = (path, message) => { if (!seen.has(`${path} ${message}`)) { seen.add(`${path} ${message}`); unsupported.push({ path, message }); } };
  const ctx = { spec, note, read: schemaReader(spec, note).read, idem: { header: undefined } };
  const ops = new Map();
  const origin = new Map();
  for (const [pathKey, raw] of Object.entries(isObject(spec.paths) ? spec.paths : {})) {
    if (pathKey.startsWith('x-')) continue;
    const at = `#/paths/${esc(pathKey)}`;
    if (!pathKey.startsWith('/')) { note(at, 'a path starts with "/": left out'); continue; }
    const item = deref(spec, raw, at, note);
    if (isObject(item)) addPath(ctx, pathKey, item, ops, origin);
    else if (item !== null) note(at, 'a path item is an object: left out');
  }
  for (const k of Object.keys(isObject(spec.webhooks) ? spec.webhooks : {})) note(`#/webhooks/${esc(k)}`, 'webhooks are not mapped: a descriptor receives events through "inbound"');
  const { title, version } = isObject(spec.info) ? spec.info : {};
  const descriptor = {
    descriptor: 1, name, ...(typeof title === 'string' && { title }), ...(typeof version === 'string' && { version }),
    modes: ['live'], ...baseOf(spec, note), ...(ctx.idem.header && { idempotency: { header: ctx.idem.header } }),
    operations: Object.fromEntries(ops),
  };
  enforce(descriptor, origin, note);
  return { descriptor, unsupported };
}
