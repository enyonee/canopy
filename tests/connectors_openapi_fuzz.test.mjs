// C6: the importer never throws for an OpenAPI document of any content, and what it returns always passes
// runtime/connectors/descriptor.mjs, or the list says why it does not. Seeded, so a failure repeats: the seed is in the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importOpenapi } from '../runtime/connectors/openapi.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'openapi');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const chance = (r, p) => r() < p;

const TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null', 'money', ['string', 'null'], undefined];
const WORDS = ['id', 'name', 'a b', 'x-y', '__proto__', 'constructor', 'page.size', 'q[0]', '', 'é', '1st'];

function schema(r, depth) {
  const s = {};
  const type = pick(r, TYPES);
  if (type !== undefined) s.type = type;
  if (chance(r, 0.15)) s.nullable = true;
  if (chance(r, 0.2)) s.format = pick(r, ['email', 'uri', 'date-time', 'uuid', 'int64']);
  if (chance(r, 0.2)) s.enum = pick(r, [[1, 2], ['a'], [], 'no']);
  if (chance(r, 0.15)) s.default = pick(r, [1, 'x', null, [], {}]);
  if (chance(r, 0.15)) s.pattern = pick(r, ['^a+$', '(', '[']);
  for (const k of ['minLength', 'maxLength', 'minimum', 'maximum']) if (chance(r, 0.1)) s[k] = pick(r, [0, 5, -1, 1.5, 'x']);
  if (chance(r, 0.1)) s[pick(r, ['example', 'x-foo', 'multipleOf', 'minItems', 'not', 'readOnly'])] = pick(r, [1, {}, 'x']);
  if (depth > 0) {
    if (chance(r, 0.4)) s.properties = Object.fromEntries(Array.from({ length: Math.floor(r() * 4) }, () => [pick(r, WORDS), schema(r, depth - 1)]));
    if (chance(r, 0.3)) s.required = Array.from({ length: Math.floor(r() * 3) }, () => pick(r, WORDS));
    if (chance(r, 0.2)) s.items = pick(r, [schema(r, depth - 1), [schema(r, depth - 1)], 3]);
    if (chance(r, 0.15)) s.additionalProperties = pick(r, [true, false, {}, schema(r, depth - 1)]);
    for (const k of ['allOf', 'oneOf', 'anyOf']) if (chance(r, 0.12)) s[k] = Array.from({ length: Math.floor(r() * 3) }, () => schema(r, depth - 1));
    if (chance(r, 0.1)) s.allOf = pick(r, [s.allOf, 'no', {}]);
  }
  if (chance(r, 0.2)) return { $ref: pick(r, ['#/components/schemas/A', '#/components/schemas/B', '#/components/schemas/Self', '#/components/schemas/Gone', 'x.json#/y', '#', '#/components/schemas/%']) };
  return s;
}

const param = (r) => ({ name: pick(r, WORDS), in: pick(r, ['path', 'query', 'header', 'cookie', 'body']), required: chance(r, 0.5), schema: chance(r, 0.9) ? schema(r, 1) : undefined,
  ...(chance(r, 0.1) && { style: 'label' }), ...(chance(r, 0.1) && { $ref: '#/components/parameters/p' }), ...(chance(r, 0.1) && { name: 'Idempotency-Key' }) });
const content = (r) => Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, () => [pick(r, ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'application/problem+json']), { schema: chance(r, 0.9) ? schema(r, 2) : undefined }]));

function operation(r) {
  const op = {};
  if (chance(r, 0.6)) op.operationId = pick(r, WORDS);
  if (chance(r, 0.7)) op.parameters = Array.from({ length: Math.floor(r() * 4) }, () => param(r));
  if (chance(r, 0.5)) op.requestBody = pick(r, [{ required: chance(r, 0.5), content: content(r) }, { $ref: '#/components/requestBodies/b' }, 5]);
  if (chance(r, 0.8)) op.responses = Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, () => [pick(r, ['200', '201', '2XX', '404', 'default']), pick(r, [{ content: content(r) }, { $ref: '#/components/responses/r' }, null])]));
  if (chance(r, 0.3)) op.security = Array.from({ length: Math.floor(r() * 3) }, () => Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, () => [pick(r, ['k', 'b', 'o', 'u', 'ghost']), []])));
  if (chance(r, 0.1)) op.callbacks = {};
  return op;
}

function spec(r) {
  const paths = {};
  for (let i = 0; i < 1 + Math.floor(r() * 4); i++) {
    const item = {};
    for (const m of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) if (chance(r, 0.35)) item[m] = operation(r);
    if (chance(r, 0.3)) item.parameters = Array.from({ length: 2 }, () => param(r));
    paths[pick(r, ['/a', '/a/{id}', '/b/{name}/{id}', '/c/{a b}', 'no-slash', '/d/{x', '/q?x=1', '/', '/p-q/{id}'])] = chance(r, 0.05) ? { $ref: '#/paths/~1a' } : item;
  }
  return {
    openapi: pick(r, ['3.0.0', '3.1.0', '3.0.3']), info: pick(r, [{ title: 't', version: '1' }, {}, 'x']),
    servers: pick(r, [[{ url: 'https://api.test/v1' }], [{ url: '/rel' }], [{ url: 'https://{h}.test', variables: { h: { default: 'a' } } }], [], undefined, 'x', [{}]]),
    security: chance(r, 0.5) ? [{ k: [] }] : undefined, paths,
    webhooks: chance(r, 0.1) ? { w: {} } : undefined,
    components: {
      schemas: { A: schema(r, 3), B: schema(r, 3), Self: { type: 'object', properties: { me: { $ref: '#/components/schemas/Self' }, a: { $ref: '#/components/schemas/A' } } } },
      parameters: { p: param(r) }, requestBodies: { b: { content: content(r) } }, responses: { r: { content: content(r) } },
      securitySchemes: { k: pick(r, [{ type: 'apiKey', in: 'header', name: 'X-K' }, { type: 'apiKey', in: 'query', name: 'k' }, { type: 'apiKey', in: 'header', name: 'bad name' }]),
        b: pick(r, [{ type: 'http', scheme: 'bearer' }, { type: 'http', scheme: 'basic' }, { type: 'http' }]), o: { type: 'oauth2' }, u: pick(r, [{ type: 'apiKey', in: 'cookie', name: 'c' }, 5, { $ref: '#/nope' }]) },
    },
  };
}

// What the importer returns must pass the checker, or have no operation and say why.
function property(result, seed) {
  const { descriptor, unsupported } = result;
  const bad = checkDescriptor(descriptor);
  assert.ok(bad.length === 0 || (Object.keys(descriptor.operations).length === 0 && unsupported.length > 0), `seed ${seed}: ${JSON.stringify(bad)}`);
  JSON.parse(JSON.stringify(result));
  for (const u of unsupported) assert.ok(typeof u.path === 'string' && typeof u.message === 'string', `seed ${seed}`);
  assert.equal(Object.getPrototypeOf(descriptor.operations), Object.prototype, `seed ${seed}`);
}

test('fuzz: generated specs always import to a descriptor that passes the checker, or to a list that says why not; never a throw', () => {
  let withOps = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const doc = spec(rng(seed));
    let result;
    try { result = importOpenapi(doc, { name: 'fz' }); } catch (e) { assert.fail(`seed ${seed} threw: ${e.stack}`); }
    property(result, seed);
    if (Object.keys(result.descriptor.operations).length) withOps++;
  }
  assert.ok(withOps > 150, `${withOps} of 600 specs had operations: the generator reaches the mapping`);
  assert.equal({}.polluted, undefined);
});

// Replace one node of a fixture by a value of the wrong kind, as a damaged or hand-edited document would have.
const JUNK = [null, 0, 'x', [], {}, true, [null], { $ref: 5 }, { type: 7 }, -1];
function damage(value, r) {
  const slots = [];
  const walk = (node, parent, key) => { if (parent) slots.push([parent, key]); if (node && typeof node === 'object') for (const k of Object.keys(node)) walk(node[k], node, k); };
  walk(value, null, null);
  const slotsLeft = slots.filter(([, k]) => k !== 'openapi');
  const [parent, key] = pick(r, slotsLeft);
  parent[key] = structuredClone(pick(r, JUNK));
}

test('fuzz: a fixture damaged anywhere (one to three nodes replaced by junk) still imports, never throws', () => {
  const names = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  for (const file of names) {
    const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    for (let seed = 1; seed <= 250; seed++) {
      const r = rng(seed * 7919);
      const doc = JSON.parse(text);
      for (let i = 0; i < 1 + Math.floor(r() * 3); i++) damage(doc, r);
      let result;
      try { result = importOpenapi(doc, { name: 'fz' }); } catch (e) { assert.fail(`${file} seed ${seed} threw: ${e.stack}`); }
      property(result, `${file}#${seed}`);
    }
  }
});

test('fuzz: the document is read, never changed', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const doc = spec(rng(seed));
    const before = JSON.stringify(doc);
    importOpenapi(doc, { name: 'fz' });
    assert.equal(JSON.stringify(doc), before, `seed ${seed}`);
  }
});
