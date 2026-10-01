// C6: the OpenAPI import (runtime/connectors/openapi.mjs and its two helpers). Golden imports of small specs written for
// these tests (tests/fixtures/openapi -> tests/golden/openapi; UPDATE_GOLDEN=1 rewrites them, and the diff is the review),
// every imported operation built by the engine, the round trip against the hand-written Postmark descriptor, the rules one
// by one, and the command. The fuzz tests are in connectors_openapi_fuzz.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importOpenapi } from '../runtime/connectors/openapi.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { buildRequest, prepare, secretSlots } from '../runtime/connectors/engine.mjs';
import { main } from '../runtime/cli.mjs';
import { tmpDir } from './helpers.mjs';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'openapi');
const GOLDEN = path.resolve(import.meta.dirname, 'golden', 'openapi');
const NAMES = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const load = (n) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${n}.json`), 'utf8'));
const imp = (spec) => importOpenapi(spec, { name: 'x' });
const notes = (r) => r.unsupported.map((u) => `${u.path}: ${u.message}`);
const hasNote = (r, re) => notes(r).some((n) => re.test(n));
// A minimal OpenAPI document around one operation.
const doc = (op, extra = {}) => ({ openapi: '3.0.0', info: { title: 't' }, servers: [{ url: 'https://api.test' }], paths: { '/x': { post: { responses: {}, ...op } } }, ...extra });
const first = (r) => Object.values(r.descriptor.operations)[0];

test('golden: every fixture imports to its recorded descriptor and list, and the descriptor passes the checker', () => {
  assert.deepEqual(NAMES, ['cycles', 'edges', 'noservers', 'payments', 'petstore']);
  for (const n of NAMES) {
    const r = imp(load(n));
    assert.deepEqual(checkDescriptor(r.descriptor), [], n);
    const text = `${JSON.stringify(r, null, 2)}\n`;
    assert.equal(text, `${JSON.stringify(imp(load(n)), null, 2)}\n`, `${n}: the same document gives the same bytes`);
    const file = path.join(GOLDEN, `${n}.json`);
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(file, text);
    assert.equal(text, fs.readFileSync(file, 'utf8'), `${n}: tests/golden/openapi/${n}.json (UPDATE_GOLDEN=1 rewrites it)`);
  }
});

// A value that satisfies a schema of the subset, for the operations the engine is asked to build.
function sample(s) {
  if (s.default !== undefined) return s.default;
  if (s.enum) return s.enum[0];
  const known = { '^[0-9]+$': '123', '^[a-z]{3}$': 'usd' };
  if (s.type === 'object') return Object.fromEntries((s.required || []).map((k) => [k, sample(s.properties[k])]));
  if (s.type === 'array') return [];
  if (s.type === 'integer' || s.type === 'number') return Math.max(s.minimum ?? 1, 1);
  if (s.type === 'boolean') return true;
  if (s.format === 'email') return 'a@b.test';
  return s.pattern ? known[s.pattern] : 'x'.repeat(Math.max(s.minLength ?? 1, 1));
}

test('every imported operation is one the engine can build a request for, from an input of its own schema', () => {
  let built = 0;
  for (const n of NAMES) {
    const d = imp(load(n)).descriptor;
    const connector = { baseUrl: 'https://api.test' };
    for (const [op, def] of Object.entries(d.operations)) {
      const { input, target } = prepare(d, connector, op, sample(def.input));
      const req = buildRequest(d, connector, op, input, { secret: () => 'S3CR3T', idemKey: 'key-1', target });
      assert.match(req.url, /^https?:\/\/[^/{}]+/, `${n}.${op}`);
      assert.equal(req.method, def.request.method);
      for (const [k, v] of Object.entries(req.headers)) assert.ok(typeof v === 'string', `${n}.${op} header ${k}`);
      built++;
    }
  }
  assert.ok(built >= 15, `${built} operations built`);
});

test('petstore: names, methods, idempotency, bodies flattened into inputs, secrets as slots', () => {
  const d = imp(load('petstore')).descriptor;
  assert.deepEqual(Object.keys(d.operations), ['listPets', 'create_pet_', 'get_pets_petId', 'updatePet', 'renamePet', 'deletePet']);
  const flags = Object.fromEntries(Object.entries(d.operations).map(([k, o]) => [k, o.idempotent]));
  assert.deepEqual(flags, { listPets: true, create_pet_: false, get_pets_petId: true, updatePet: true, renamePet: false, deletePet: true });
  assert.equal(d.base, 'https://eu.petstore.test/v1', 'the server variable is its default, the trailing slash is gone');
  assert.deepEqual(d.modes, ['live']);
  assert.equal(d.sandbox, undefined);
  assert.deepEqual(secretSlots(d), ['apiKey']);
  assert.equal(d.operations.listPets.request.url, '{base}/pets?limit={input.limit}&status={input.status}', 'a required query parameter and one with a default; the other is listed');
  assert.deepEqual(d.operations.create_pet_.request.body.name, { $: 'input.name' });
  assert.equal(d.operations.create_pet_.request.headers['content-type'], 'application/json');
  assert.equal(d.operations.renamePet.request.body.$, 'input.body', 'a body that is no object is the one input "body"');
  assert.deepEqual(d.operations.updatePet.input.required, ['petId', 'name'], 'the properties a body requires are required inputs');
  assert.equal(d.operations.create_pet_.input.properties.owner.additionalProperties, true, 'a nested object is open unless the spec closes it');
  assert.equal(d.operations.create_pet_.summary, 'Add a pet to the store');
});

test('payments: a form body, basic auth, the idempotency header bound to the row key', () => {
  const r = imp(load('payments'));
  const d = r.descriptor;
  assert.deepEqual(d.idempotency, { header: 'Idempotency-Key' });
  const charge = d.operations.createCharge;
  assert.equal(charge.request.encoding, 'form');
  assert.equal(charge.idempotent, true, 'a POST with an idempotency header is idempotent');
  assert.equal(charge.input.properties['Idempotency-Key'], undefined, 'the key is the row\'s, not an input');
  assert.equal(charge.request.headers.authorization, 'Basic {secret.basic}');
  assert.equal(charge.request.headers['content-type'], undefined, 'the engine sets the form content type');
  assert.ok(hasNote(r, /base64\(user:password\)/));
  const req = buildRequest(d, {}, 'createCharge', { body: { amount: 5, currency: 'usd', 'metadata[order]': '7' } }, { secret: () => 'dTpw', idemKey: 'k1' });
  assert.equal(req.body, 'amount=5&currency=usd&metadata[order]=7');
  assert.equal(req.headers['Idempotency-Key'], 'k1');
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(d.operations.refund.input.properties.idempotency_key.type, 'string', 'a name the descriptor cannot send stays an input');
  assert.equal(d.operations.refund.idempotent, true, 'the second spelling of the header, the one that can be bound');
  assert.ok(hasNote(r, /"idempotency_key" cannot be the idempotency header/));
  assert.equal(d.operations.getCharge.request.headers, undefined, 'security: [] means no authentication');
  assert.ok(hasNote(r, /text\/plain, not JSON/));
  assert.ok(hasNote(r, /multipart\/form-data not mapped/));
});

test('cycles and compositions: a $ref cycle is cut and named, oneOf and callbacks are listed, never guessed', () => {
  const r = imp(load('cycles'));
  const add = r.descriptor.operations.addNode;
  assert.deepEqual(add.input.properties.parent, {}, 'the cycle is {}');
  assert.deepEqual(add.input.properties.children, { type: 'array', items: {} });
  assert.ok(hasNote(r, /requestBody.*properties\/parent: \$ref cycle: #\/components\/schemas\/Node/));
  assert.equal(r.descriptor.operations.findNode, undefined, 'a required parameter that cannot be mapped leaves the operation out');
  assert.ok(hasNote(r, /schema\/oneOf: oneOf with 2 alternatives is omitted/));
  assert.ok(hasNote(r, /post\/callbacks: callbacks are not mapped/));
  assert.ok(hasNote(r, /#\/webhooks\/nodeAdded/));
  assert.equal(r.descriptor.operations.loop.output.description, 'just a leaf', 'a one-element oneOf is unwrapped');
  assert.equal(r.descriptor.operations.mixed.output, undefined, 'members that disagree: omitted whole');
  assert.ok(hasNote(r, /an allOf that is not made of plain objects is omitted/));
  assert.ok(hasNote(r, /disagree about "label"/));
  assert.equal(r.descriptor.base, '{config.baseUrl}');
  assert.deepEqual(r.descriptor.config.required, ['baseUrl']);
});

test('edges: what is left out is listed, and a required thing that cannot be mapped takes its operation with it', () => {
  const r = imp(load('edges'));
  const ops = r.descriptor.operations;
  assert.deepEqual(Object.keys(ops), ['getA', 'patch_b', 'delete_b', 'getA_2', 'getA_3'], 'a name taken is numbered, in document order');
  for (const re of [/HEAD is not a method/, /"sid" is a cookie/, /"ids" is not a string/, /"accept" is a header that OpenAPI ignores/, /allowReserved is ignored/, /servers of a path/,
    /"need" is a cookie/, /no media type is mapped \(application\/xml\)/, /no security alternative can be mapped \("oauth"/, /nowhere" is not followed/, /example.com\/p.json" is not followed/,
    /without a name and a place/, /names without a declared property/, /schema for the other properties/, /\/d\/\{id\}\/\{missing\} names a parameter/, /a path starts with "\/"/, /a path item is an object/]) assert.ok(hasNote(r, re), String(re));
  assert.equal(ops.getA.request.url, '{base}/a/{input.x}?key={input.key}&page.size={input.page_size}&page%20size={input.page_size_2}&q={input.q}', 'the operation\'s parameter wins over the path item\'s; names a template can use');
  assert.equal(ops.getA.input.properties.x.type, 'integer');
  assert.equal(ops.delete_b.request.headers, undefined, 'no alternative can be mapped: no authentication, and the list says why');
  assert.ok(hasNote(r, /delete\/security: no security alternative can be mapped \("ghost" is not a defined security scheme; "keyq" is an API key in query: the secret would be in the url, which the outbox shows; "keyc" is an API key in cookie: a descriptor sets no cookies; "digest" \(http digest\) is not mapped.*; two schemes write the same header\)/));
  assert.deepEqual(ops.getA_3.input.properties.body_2.properties, { body: { type: 'string' } }, 'the body gets another name than the parameter');
  assert.equal(ops.getA_3.request.headers['x-a'], '{secret.both}');
  assert.equal(r.descriptor.version, undefined);
});

test('a base: the first server, its variables fixed, a relative or missing one is the connector\'s config.baseUrl', () => {
  const r = imp(load('noservers'));
  assert.equal(r.descriptor.base, '{config.baseUrl}');
  assert.ok(hasNote(r, /"\/api" is not an absolute http\(s\) url/));
  const sure = (servers) => imp(doc({}, { servers })).descriptor.base;
  assert.equal(sure([{ url: 'http://localhost:8080/' }]), 'http://localhost:8080');
  assert.equal(sure([{ url: 'https://{h}.t/{p}', variables: { h: { default: 'a' } } }]), '{config.baseUrl}', 'a variable with no default is not a url');
  assert.equal(sure([{ url: 'https://{h}.t', variables: { h: {} } }]), '{config.baseUrl}');
  assert.equal(sure(undefined), '{config.baseUrl}');
  assert.equal(sure([{ url: 'https://x.test/with space' }]), '{config.baseUrl}');
  const conn = buildRequest(imp(load('noservers')).descriptor, { baseUrl: 'https://api.test/v2' }, 'ping', {});
  assert.equal(conn.url, 'https://api.test/v2/ping', 'the connector\'s config supplies the base');
});

test('round trip: a spec of the Postmark send operation gives the request the hand-written descriptor builds', () => {
  const hand = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'connectors', 'postmark', 'descriptor.json'), 'utf8'));
  const spec = {
    openapi: '3.0.3', info: { title: 'Postmark', version: '2026-10' }, servers: [{ url: 'https://api.postmarkapp.com' }],
    security: [{ serverToken: [] }],
    paths: { '/email': { post: { operationId: 'sendEmail', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['From', 'To', 'Subject'], properties: {
      From: { type: 'string' }, To: { type: 'string' }, Subject: { type: 'string' }, TextBody: { type: 'string' }, HtmlBody: { type: 'string' }, Tag: { type: 'string' }, Metadata: { type: 'object' }, MessageStream: { type: 'string' } } } } } },
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', required: ['MessageID', 'ErrorCode'], properties: { To: { type: 'string' }, SubmittedAt: { type: 'string' }, MessageID: { type: 'string' }, ErrorCode: { type: 'integer' }, Message: { type: 'string' } } } } } } } } } },
    components: { securitySchemes: { serverToken: { type: 'apiKey', in: 'header', name: 'X-Postmark-Server-Token' } } },
  };
  const r = importOpenapi(spec, { name: 'postmark' });
  assert.deepEqual(r.unsupported, []);
  const secret = () => 'tok';
  const theirs = buildRequest(r.descriptor, {}, 'sendEmail', { From: 'shop@example.test', To: 'a@b.test', Subject: 'Hi', TextBody: 'text', Tag: 't', Metadata: { k: 'v' }, MessageStream: 'outbound' }, { secret });
  const mine = buildRequest(hand, { from: 'shop@example.test' }, 'sendEmail', { to: 'a@b.test', subject: 'Hi', text: 'text', tag: 't', metadata: { k: 'v' } }, { secret });
  assert.deepEqual({ ...theirs, timeout: 0 }, { ...mine, timeout: 0 });
  assert.equal(r.descriptor.operations.sendEmail.idempotent, hand.operations.sendEmail.idempotent);
  assert.deepEqual(r.descriptor.operations.sendEmail.output, hand.operations.sendEmail.output, 'the answer schema is the same');
  assert.deepEqual(secretSlots(r.descriptor), secretSlots(hand).filter((s) => s === 'serverToken'));
});

test('an apiKey in the query would put the secret in the url: listed, not mapped; the other schemes map to a header each', () => {
  const spec = (scheme, sec) => doc({ security: sec }, { components: { securitySchemes: { s: scheme } } });
  assert.equal(first(imp(spec({ type: 'apiKey', in: 'query', name: 'k' }, [{ s: [] }]))).request.headers, undefined);
  assert.ok(hasNote(imp(spec({ type: 'apiKey', in: 'query', name: 'k' }, [{ s: [] }])), /the secret would be in the url/));
  assert.equal(first(imp(spec({ type: 'apiKey', in: 'header', name: 'X-Key' }, [{ s: [] }]))).request.headers['x-key'], '{secret.s}');
  assert.equal(first(imp(spec({ type: 'http', scheme: 'Bearer' }, [{ s: [] }]))).request.headers.authorization, 'Bearer {secret.s}');
  assert.ok(hasNote(imp(spec({ type: 'openIdConnect', openIdConnectUrl: 'https://x' }, [{ s: [] }])), /openIdConnect\) is not mapped/));
  assert.ok(hasNote(imp(spec({ type: 'apiKey', in: 'header', name: 'a b' }, [{ s: [] }])), /"s" is an API key in header/), 'an unsendable header name');
  assert.ok(hasNote(imp(doc({}, { security: [{ missing: [] }] })), /"missing" is not a defined security scheme/));
  assert.equal(first(imp(spec({ type: 'http', scheme: 'bearer' }, [{}, { s: [] }]))).request.headers, undefined, 'an empty requirement is no authentication');
  assert.deepEqual(secretSlots(imp(spec({ type: 'http', scheme: 'bearer' }, [{ s: [] }])).descriptor), ['s']);
});

test('operation names: operationId sanitised, else <method>_<path>, a clash numbered', () => {
  const spec = { openapi: '3.1.0', servers: [{ url: 'https://a.test' }], paths: {
    '/a': { get: { operationId: '9lives' }, post: { operationId: 'a b' }, put: { operationId: 'a_b' }, delete: { operationId: 'a b' } },
    '/': { get: {} }, '/p-q/{id}': { get: { parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }] } }, '/__proto__': { get: { operationId: '__proto__' } } } };
  const r = imp(spec);
  assert.deepEqual(Object.keys(r.descriptor.operations), ['_9lives', 'a_b', 'a_b_2', 'a_b_3', 'get', 'get_p_q_id', '__proto__']);
  assert.equal(Object.getPrototypeOf(r.descriptor.operations), Object.prototype);
  assert.deepEqual(checkDescriptor(r.descriptor), []);
});

test('the schema subset: nullable, type lists and unknown keywords are reported; annotations and unsupported formats go quietly', () => {
  const body = (schema) => imp(doc({ requestBody: { content: { 'application/json': { schema } } } }));
  const props = (r) => first(r).input.properties;
  const r = body({ type: 'object', properties: {
    a: { type: 'string', nullable: true }, b: { type: ['integer', 'null'] }, c: { type: ['string', 'integer'] }, d: { type: ['null'] }, e: { type: 'money' },
    f: { type: 'string', format: 'uuid', example: 'x', readOnly: true, deprecated: true, 'x-vendor': 1, $comment: 'c' }, g: { type: 'integer', exclusiveMinimum: 0, multipleOf: 5 },
    h: { type: 'array', items: [{ type: 'string' }] }, i: { type: 'string', pattern: '(' }, j: { type: 'integer', default: 'x' }, k: { type: 'string', minLength: -1 },
    l: { properties: 4 }, m: 'text', n: true, o: { const: 'k' }, p: { type: 'string', enum: [] }, q: { type: 'integer', minimum: 1, maximum: 9, default: 3 },
    r: { type: 'string', format: 'date-time' }, s: { oneOf: [{ type: 'string' }] }, t: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, u: { allOf: 'no' }, v: { type: 'object', properties: { w: { type: 'integer' } }, additionalProperties: false } } });
  const p = props(r);
  assert.equal(Object.keys(p).length, 22, 'every property name is one a template can use: the body is flattened');
  assert.deepEqual(p.a, { type: 'string' });
  assert.equal(p.b.type, 'integer');
  assert.equal(p.c.type, undefined);
  assert.equal(p.d.type, 'null');
  assert.equal(p.e.type, undefined);
  assert.deepEqual(p.f, { type: 'string' });
  assert.deepEqual(p.g, { type: 'integer' });
  assert.equal(p.h.items, undefined);
  assert.equal(p.i.pattern, undefined);
  assert.equal(p.j.default, undefined);
  assert.equal(p.k.minLength, undefined);
  assert.equal(p.l.properties, undefined);
  assert.deepEqual(p.m, {});
  assert.deepEqual(p.n, {});
  assert.deepEqual(p.o, { enum: ['k'] });
  assert.equal(p.p.enum, undefined);
  assert.deepEqual(p.q, { type: 'integer', default: 3, minimum: 1, maximum: 9 });
  assert.equal(p.r.format, 'date-time');
  assert.deepEqual(p.s, { type: 'string' });
  assert.deepEqual(p.t, {});
  assert.equal(p.v.additionalProperties, false);
  for (const re of [/a\/nullable: nullable dropped/, /b\/type: null is no longer accepted/, /c\/type: a type list \(string, integer\)/, /e\/type: unknown type "money"/, /g\/exclusiveMinimum: "exclusiveMinimum" is not in/,
    /g\/multipleOf/, /h\/items: a list of item schemas/, /i\/pattern: "pattern" dropped/, /j\/default: "default" dropped/, /k\/minLength: "minLength" dropped/, /l\/properties: "properties" is not an object/,
    /m: a schema that is not an object/, /p\/enum: "enum" dropped/, /t\/anyOf: anyOf with 2 alternatives/, /u\/allOf: "allOf" is not a list/]) assert.ok(hasNote(r, re), String(re));
  for (const quiet of [/\/f\//, /\/n[:/]/]) assert.ok(!hasNote(r, quiet), `nothing said about ${quiet}`);
});

test('allOf: plain objects merged (properties, required, titles, additionalProperties), nothing else', () => {
  const schemas = { A: { type: 'object', title: 'A', required: ['a'], properties: { a: { type: 'string' }, s: { type: 'integer' } }, additionalProperties: false }, B: { type: 'object', description: 'B', required: ['b'], properties: { b: { type: 'string' }, s: { type: 'integer' } }, additionalProperties: false },
    C: { type: 'object', properties: { c: { type: 'string' } }, additionalProperties: true }, D: { type: 'object', properties: { s: { type: 'string' } } } };
  // the merged schema, read as the items of a list so that the body stays one input
  const all = (members, extra = {}) => ({ type: 'array', items: { allOf: members.map((m) => ({ $ref: `#/components/schemas/${m}` })), ...extra } });
  const body = (schema) => imp(doc({ requestBody: { content: { 'application/json': { schema } } } }, { components: { schemas } }));
  const out = (members, extra) => first(body(all(members, extra)));
  const ab = out(['A', 'B']).input.properties.body.items;
  assert.deepEqual(ab, { type: 'object', title: 'A', description: 'B', properties: { a: { type: 'string' }, s: { type: 'integer' }, b: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false });
  const abc = body(all(['A', 'C']));
  assert.equal(first(abc).input.properties.body.items.additionalProperties, undefined, 'members that disagree about additionalProperties: not said');
  assert.ok(hasNote(abc, /disagree about additionalProperties/));
  const clash = body(all(['A', 'D']));
  assert.deepEqual(first(clash).input.properties.body.items, {}, 'a property the members describe differently: the whole allOf is omitted');
  assert.ok(hasNote(clash, /disagree about "s"/));
  const sib = out(['A'], { description: 'one member and a note' }).input.properties.body.items;
  assert.equal(sib.description, 'one member and a note', 'the schema\'s own annotation wins over its member\'s');
});

test('$ref: local only; a malformed or missing one, an external one and a chain are handled', () => {
  const schemas = { Chain: { $ref: '#/components/schemas/End' }, End: { type: 'integer' }, Loop1: { $ref: '#/components/schemas/Loop2' }, Loop2: { $ref: '#/components/schemas/Loop1' }, 'a/b': { type: 'boolean' } };
  const prop = (ref) => first(imp(doc({ requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { p: { $ref: ref } } } } } } }, { components: { schemas } }))).input.properties.p;
  assert.deepEqual(prop('#/components/schemas/Chain'), { type: 'integer' });
  assert.deepEqual(prop('#/components/schemas/a~1b'), { type: 'boolean' });
  assert.deepEqual(prop('#/components/schemas/a%2Fb'), { type: 'boolean' });
  for (const bad of ['#/components/schemas/Nope', 'other.json#/x', '#', '#/components/schemas/%E0', '#/components/schemas/End/type/x', '#/components/schemas/Loop1', '#/components/__proto__']) assert.deepEqual(prop(bad), {}, bad);
  const r = imp(doc({ parameters: [{ $ref: '#/components/parameters/a' }], requestBody: { $ref: '#/components/requestBodies/loop' } }, {
    components: { parameters: { a: { $ref: '#/components/parameters/b' }, b: { $ref: '#/components/parameters/a' } }, requestBodies: { loop: { $ref: '#/components/requestBodies/loop' } } } }));
  assert.equal(Object.keys(r.descriptor.operations).length, 0);
  assert.ok(hasNote(r, /\$ref cycle through #\/components\/parameters\/a: cut/));
  assert.ok(hasNote(r, /no operation could be imported/));
});

test('a schema too large or too deep is cut and said once', () => {
  let deep = { type: 'string' };
  for (let i = 0; i < 60; i++) deep = { type: 'object', properties: { n: deep } };
  const r = imp(doc({ requestBody: { content: { 'application/json': { schema: deep } } } }));
  assert.equal(notes(r).filter((n) => /too large or too deep/.test(n)).length, 1);
  // A document whose references fan out (each schema names the next twice) is a bomb: the work is bounded.
  const schemas = {};
  for (let i = 0; i < 30; i++) schemas[`S${i}`] = { type: 'object', properties: { a: { $ref: `#/components/schemas/S${i + 1}` }, b: { $ref: `#/components/schemas/S${i + 1}` } } };
  schemas.S30 = { type: 'string' };
  const t0 = Date.now();
  const bomb = imp(doc({ requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } } }, { components: { schemas } }));
  assert.ok(Date.now() - t0 < 5000, 'bounded');
  assert.ok(hasNote(bomb, /too large or too deep/));
});

test('a parameter: what a template can carry becomes an input; the rest is listed, or takes a required one\'s operation with it', () => {
  const one = (p, extra = {}) => imp(doc({ parameters: [p], ...extra }, { paths: { '/x/{id}': { post: { parameters: [p], responses: {} } } } }));
  const query = (p) => imp({ ...doc({}), paths: { '/x': { get: { parameters: [p], responses: {} } } } });
  assert.equal(first(query({ name: 'a', in: 'query', required: true, schema: { type: 'boolean' }, description: 'flag' })).input.properties.a.description, 'flag');
  assert.deepEqual(first(query({ name: 'a', in: 'query', required: true, schema: { type: 'string', description: 'own' }, description: 'flag' })).input.properties.a, { type: 'string', description: 'own' });
  assert.ok(hasNote(query({ name: 'a', in: 'query', schema: { type: 'string' } }), /optional and a url template cannot leave/));
  assert.ok(hasNote(query({ name: 'a', in: 'query', required: true }), /has no schema/));
  assert.ok(hasNote(query({ name: 'a', in: 'matrix', schema: { type: 'string' } }), /is in "matrix"/));
  assert.ok(hasNote(one({ name: 'id', in: 'path', required: true, style: 'label', schema: { type: 'string' } }), /has style "label"/));
  const noHeader = query({ name: 'bad name', in: 'header', schema: { type: 'string' } });
  assert.ok(hasNote(noHeader, /header name that cannot be sent/));
  assert.equal(first(noHeader).request.headers, undefined);
  const dupe = imp({ ...doc({}), paths: { '/x': { get: { parameters: [{ name: 'a', in: 'query', required: true, schema: { type: 'string' } }, { name: 'a', in: 'query', required: true, schema: { type: 'integer' } }], responses: {} } } } });
  assert.equal(first(dupe).input.properties.a.type, 'integer', 'the same name and place: the later wins');
});

test('the idempotency header: bound once for the descriptor, the first spelling wins, other names stay inputs', () => {
  const hdr = (name) => ({ name, in: 'header', schema: { type: 'string' } });
  const op = (params) => ({ post: { parameters: params, responses: {} } });
  const r = imp({ ...doc({}), paths: { '/a': op([hdr('Idempotency-Key')]), '/b': op([hdr('idempotency-key')]), '/c': op([hdr('X-Idempotency-Key')]), '/d': op([hdr('Idempotency_Key')]) } });
  const ops = Object.values(r.descriptor.operations);
  assert.deepEqual(r.descriptor.idempotency, { header: 'Idempotency-Key' });
  assert.deepEqual(ops.map((o) => o.idempotent), [true, true, false, false]);
  assert.ok(ops.every((o) => !o.input.properties['Idempotency-Key'] && !o.input.properties['idempotency-key']));
  assert.ok(ops[2].input.properties['X-Idempotency-Key'], 'a different name cannot share the descriptor\'s one header');
  assert.equal(imp({ ...doc({}), paths: { '/a': op([]) } }).descriptor.idempotency, undefined);
});

test('a request body: JSON before a form, a body a template cannot name is "body", a required one that cannot be mapped leaves the operation out', () => {
  const body = (content, required) => imp(doc({ requestBody: { required, content } }));
  const both = body({ 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { a: { type: 'string' } } } }, 'application/vnd.x+json; charset=utf-8': { schema: { type: 'object', properties: { b: { type: 'string' } } } } });
  assert.deepEqual(Object.keys(first(both).input.properties), ['b'], 'JSON (a +json type too) is preferred to a form');
  assert.equal(first(both).request.encoding, undefined);
  assert.ok(hasNote(both, /application\/x-www-form-urlencoded not mapped: the body is sent as application\/vnd.x\+json/));
  const noSchema = body({ 'application/json': {} }, true);
  assert.deepEqual(first(noSchema).input, { type: 'object', properties: { body: {} }, required: ['body'] });
  const form = body({ 'application/x-www-form-urlencoded': { schema: { type: 'array', items: { type: 'string' } } } }, true);
  assert.equal(Object.keys(form.descriptor.operations).length, 0);
  assert.ok(hasNote(form, /a form body must be an object/));
  assert.equal(Object.keys(body({ 'application/x-www-form-urlencoded': { schema: { type: 'string' } } }, false).descriptor.operations).length, 1, 'an optional body that cannot be mapped is left out');
  const open = body({ 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true } } });
  assert.ok(hasNote(open, /properties other than the declared ones are not accepted/));
  const named = imp(doc({ requestBody: { description: 'the thing', content: { 'application/json': { schema: { type: 'array', items: { type: 'integer' } } } } } }));
  assert.equal(first(named).input.properties.body.description, 'the thing');
  assert.equal(first(named).input.required, undefined);
  const unresolved = imp(doc({ requestBody: { $ref: '#/components/requestBodies/gone' } }));
  assert.equal(Object.keys(unresolved.descriptor.operations).length, 0, 'a body that cannot be read may be a required one: nothing is guessed');
  assert.ok(hasNote(unresolved, /requestBodies\/gone" is not followed/));
  const plain = imp(doc({ requestBody: 7 }));
  assert.equal(Object.keys(plain.descriptor.operations).length, 1);
  const weird = imp(doc({ requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { 'a b': { type: 'string' } } } } } } }));
  assert.deepEqual(Object.keys(first(weird).input.properties), ['body'], 'a property name a template cannot use');
});

test('a response: the first 2xx that is JSON becomes "output"; none is no output', () => {
  const answer = (responses) => first(imp(doc({ responses })));
  const json = { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
  assert.deepEqual(answer({ 404: json, 201: json, 200: { description: 'x' } }).output, { type: 'object', properties: { id: { type: 'string' } } });
  assert.equal(answer({ 404: json }).output, undefined);
  assert.equal(answer({ default: json }).output, undefined);
  assert.equal(answer({ '2XX': json }).output.type, 'object');
  assert.equal(answer({ 200: { $ref: '#/components/responses/ok' } }).output, undefined, 'an unresolved response');
  assert.equal(answer({ 200: { content: { 'application/json': { schema: { oneOf: [{ type: 'string' }, { type: 'integer' }] } } } } }).output, undefined, 'a schema that is nothing is no output');
  assert.equal(answer({ 200: { content: { 'application/json': { schema: { type: 'object' } } } } }).request.headers.accept, 'application/json');
  assert.equal(first(imp({ ...doc({}), paths: { '/x': { get: { responses: 'none' } } } })).output, undefined);
});

test('not an OpenAPI 3 document: throws, and says why; a name that is no name too', () => {
  for (const [bad, re] of [[null, /expected a JSON object/], [5, /expected a JSON object/], ['openapi: 3.0.0', /expected a JSON object/], [[], /expected a JSON object/], [{}, /no "openapi"/],
    [{ swagger: '2.0' }, /Swagger 2.0/], [{ openapi: '2.0.0' }, /no "openapi"/], [{ openapi: 3 }, /no "openapi"/], [{ openapi: '3.2.0' }, /no "openapi"/]]) assert.throws(() => imp(bad), re, JSON.stringify(bad));
  for (const name of [undefined, '', 'Pets', '1pets', 'pe ts', 5]) assert.throws(() => importOpenapi(doc({}), { name }), /needs a name/);
  assert.throws(() => importOpenapi(doc({})), /needs a name/);
  assert.equal(imp({ openapi: '3.0', paths: {} }).descriptor.operations !== undefined, true, '3.0 without a patch number is 3.0');
});

test('the checker has the last word: an operation it refuses is left out and listed, so the result always passes', () => {
  // A default that does not fit the `items` of its own list: the node-level check does not look into children, the descriptor checker does.
  const tags = { type: 'object', properties: { tags: { type: 'array', items: { type: 'integer' }, default: ['a'] } } };
  const spec = doc({}, { paths: {
    '/ok': { get: { operationId: 'fine', responses: {} } },
    '/bad': { post: { operationId: 'bad', requestBody: { content: { 'application/json': { schema: tags } } }, responses: {} } } } });
  const r = imp(spec);
  assert.deepEqual(Object.keys(r.descriptor.operations), ['fine']);
  assert.deepEqual(checkDescriptor(r.descriptor), []);
  assert.ok(hasNote(r, /#\/paths\/~1bad\/post: the operation is left out, the descriptor checker refuses it \(\/operations\/bad\/input\/properties\/tags\/default/));
});

test('a document with no operations: a descriptor that cannot pass, and the list says so', () => {
  const r = imp({ openapi: '3.1.0', info: {}, paths: {} });
  assert.equal(Object.keys(r.descriptor.operations).length, 0);
  assert.notEqual(checkDescriptor(r.descriptor).length, 0);
  assert.ok(hasNote(r, /no operation could be imported/));
  assert.equal(imp({ openapi: '3.1.0', paths: { 'x-a': {}, '/p': { get: { responses: {} } } }, webhooks: 3 }).unsupported.length, 1);
});

// --- the command -------------------------------------------------------------------------------------------------------

const run = async (argv) => {
  const out = []; const err = [];
  const { code } = await main(argv, { log: (m) => out.push(m), err: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('--import-openapi: prints the descriptor, lists what is not mapped on stderr, says it is a draft', async () => {
  const r = await run(['--import-openapi', path.join(FIXTURES, 'petstore.json'), '--name', 'pets']);
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.equal(d.name, 'pets');
  assert.deepEqual(checkDescriptor(d), []);
  assert.equal(r.out, JSON.stringify(d, null, 2), 'pretty, two spaces');
  assert.match(r.err, /not mapped: #\/paths\/~1pets\/get\/parameters\/2: parameter "tag" is optional/);
  assert.match(r.err, /DRAFT for a human to review and commit/);
  assert.match(r.err, /Secret slots: apiKey/);
  assert.match(r.err, /live only, no sandbox rules/);
});

test('--import-openapi --out: writes the file (making its directory), prints only the path', async (t) => {
  const dir = tmpDir('ag-oas-', t);
  const file = path.join(dir, 'connectors', 'pets', 'descriptor.json');
  const r = await run(['--import-openapi', path.join(FIXTURES, 'payments.json'), '--name', 'pay', '--out', file]);
  assert.equal(r.code, 0);
  assert.equal(r.out, `wrote ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  assert.equal(JSON.parse(text).name, 'pay');
  assert.deepEqual(JSON.parse(text), importOpenapi(load('payments'), { name: 'pay' }).descriptor);
});

test('--import-openapi: exit 2 on a missing file name or --name; exit 1 on YAML, on a document that is not OpenAPI, on a result the checker refuses', async (t) => {
  const dir = tmpDir('ag-oas-', t);
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  assert.equal((await run(['--import-openapi'])).code, 2);
  assert.equal((await run(['--import-openapi', '--name', 'x'])).code, 2);
  assert.equal((await run(['--import-openapi', 'spec.json'])).code, 2);
  assert.equal((await run(['--import-openapi', 'spec.json', '--name'])).code, 2);
  assert.match((await run(['--import-openapi', 'spec.json'])).err, /usage: run.mjs --import-openapi/);
  const yaml = await run(['--import-openapi', write('s.yaml', 'openapi: 3.0.0\npaths: {}\n'), '--name', 'x']);
  assert.equal(yaml.code, 1);
  assert.match(yaml.err, /is not JSON.*YAML is not supported/);
  const not = await run(['--import-openapi', write('n.json', '{"swagger": "2.0"}'), '--name', 'x']);
  assert.equal(not.code, 1);
  assert.match(not.err, /Swagger 2.0/);
  assert.equal((await run(['--import-openapi', path.join(dir, 'missing.json'), '--name', 'x'])).code, 1);
  assert.equal((await run(['--import-openapi', write('b.json', '{"openapi": "3.0.0"}'), '--name', 'Bad Name'])).code, 1);
  const out = path.join(dir, 'never.json');
  const empty = await run(['--import-openapi', write('e.json', '{"openapi": "3.0.0", "paths": {}}'), '--name', 'x', '--out', out]);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /would not pass the descriptor checker/);
  assert.match(empty.err, /no operation could be imported/);
  assert.equal(fs.existsSync(out), false, 'nothing is written for a descriptor that would not pass');
});
