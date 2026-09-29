// Templates (runtime/connectors/template.mjs) and descriptor validation
// (runtime/connectors/descriptor.mjs): what a descriptor may say, and every way it can be wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseRef, refs, expand, pick, pathSteps, SCOPES } from '../runtime/connectors/template.mjs';
import { checkDescriptor, MAX_TIMEOUT_MS, METHODS } from '../runtime/connectors/descriptor.mjs';
import { BUILTIN } from '../runtime/connectors/builtin.mjs';
import { LEASE_MS } from '../runtime/outbox.mjs';

test('template: references, literals and the ways a template is malformed', () => {
  assert.deepEqual(parse('a{input.x}b{config.y.z}{base}{key}{secret.k}'),
    ['a', { scope: 'input', path: ['x'] }, 'b', { scope: 'config', path: ['y', 'z'] }, { scope: 'base', path: [] }, { scope: 'key', path: [] }, { scope: 'secret', path: ['k'] }]);
  assert.deepEqual(parse('plain'), ['plain']);
  assert.deepEqual(parse(''), []);
  assert.throws(() => parse('a{input.x'), /unclosed "\{"/);
  assert.throws(() => parse('{nope.x}'), /unknown name "nope\.x" in a template/);
  assert.throws(() => parse('{input}'), /needs a name/);
  assert.throws(() => parse('{secret}'), /needs a name/);
  assert.throws(() => parse('{base.x}'), /base needs no name/);
  assert.throws(() => parse('{input.a b}'), /is not a reference/);
  assert.throws(() => parse('{input.}'), /is not a reference/);
  assert.deepEqual(SCOPES, ['config', 'input', 'secret', 'base', 'key']);
});

test('template: the whole-value form may name a whole scope, except secrets', () => {
  assert.deepEqual(parseRef('input', true), { scope: 'input', path: [] });
  assert.deepEqual(parseRef('config', true), { scope: 'config', path: [] });
  assert.throws(() => parseRef('secret', true), /needs a name/);
  assert.throws(() => parseRef('input'), /needs a name/);
});

test('template: refs lists what a structure mentions, in order', () => {
  const t = { a: '{input.x}', b: [{ $: 'config.y' }, '{secret.k}'], c: { '...': { $: 'config.headers' } }, d: 5, e: null };
  assert.deepEqual(refs(t).map((r) => `${r.scope}.${r.path.join('.')}`), ['input.x', 'config.y', 'secret.k', 'config.headers']);
  assert.throws(() => refs({ a: '{oops}' }), /unknown name/);
});

test('template: expansion is substitution — strings embed scalars, {"$"} keeps the type', () => {
  const scopes = { config: { url: 'https://x.test', n: 3, on: false }, input: { a: { b: [1] }, s: 'v', nothing: null }, base: 'https://b', key: 'K1', secret: (n) => `S(${n})` };
  assert.equal(expand('{config.url}/p/{input.s}/{config.n}/{config.on}', scopes), 'https://x.test/p/v/3/false');
  assert.equal(expand('{base}|{key}|{secret.tok}', scopes), 'https://b|K1|S(tok)');
  assert.equal(expand('[{input.missing}][{input.nothing}][{input.a.zzz.q}]', scopes), '[][][]', 'an absent value is empty text');
  assert.deepEqual(expand({ $: 'input.a' }, scopes), { b: [1] });
  assert.equal(expand({ $: 'input.nothing' }, scopes), null);
  assert.equal(expand({ $: 'input.missing' }, scopes), undefined);
  assert.deepEqual(expand({ x: '{input.s}', y: { $: 'input.missing' }, z: [{ $: 'input.missing' }, 1] }, scopes), { x: 'v', z: [null, 1] }, 'an absent property is left out; in a list it is null');
  assert.deepEqual(expand({ n: 1, t: true, z: null }, scopes), { n: 1, t: true, z: null }, 'literals stay');
  assert.throws(() => expand('{input.a}', scopes), /embeds only a string, number or boolean/);
});

test('template: "..." spreads an object, later keys win, absent spreads nothing', () => {
  const scopes = { config: { h: { 'x-a': '1', 'content-type': 'text/plain' } }, input: {} };
  assert.deepEqual(expand({ 'content-type': 'application/json', '...': { $: 'config.h' } }, scopes), { 'content-type': 'text/plain', 'x-a': '1' });
  assert.deepEqual(expand({ 'content-type': 'j', '...': { $: 'config.nothing' } }, scopes), { 'content-type': 'j' });
  assert.throws(() => expand({ '...': 'text' }, scopes), /spreads an object/);
  assert.throws(() => expand({ '...': { $: 'config.h.x-a' } }, { config: { h: { 'x-a': '1' } } }), /spreads an object/);
  assert.throws(() => expand({ '...': [] }, scopes), /spreads an object/);
  assert.throws(() => expand({ '...': { $: 'input.n' } }, { input: { n: null } }), /spreads an object/);
});

test('template: a secret fails closed when nothing resolves it; base and key must exist to be used', () => {
  assert.throws(() => expand('Bearer {secret.apiKey}', { config: {}, input: {} }), /secret "apiKey" cannot be resolved: the secret store is not available yet/);
  assert.throws(() => expand('{base}/x', {}), /\{base\} has no value here/);
  assert.throws(() => expand('{key}', {}), /\{key\} has no value here/);
});

test('template: pick reads $.a.b[0] and says undefined for what is not there', () => {
  const v = { a: { b: [{ c: 7 }, 'x'] }, n: null };
  assert.equal(pick('$', v), v);
  assert.equal(pick('$.a.b[0].c', v), 7);
  assert.equal(pick('$.a.b[1]', v), 'x');
  assert.equal(pick('$.a.q.r', v), undefined);
  assert.equal(pick('$.n.x', v), undefined);
  assert.equal(pick('$.a.b[9]', v), undefined);
  assert.deepEqual(pathSteps('$.a[2].b-c'), ['a', 2, 'b-c']);
  assert.throws(() => pathSteps('a.b'), /starts with \$/);
  assert.throws(() => pathSteps(5), /starts with \$/);
  assert.throws(() => pathSteps('$.a..b'), /expected .name or \[index\] at 3/);
  assert.throws(() => pathSteps('$.a['), /expected/);
});

// --- descriptors ---------------------------------------------------------------------------

const good = () => ({
  descriptor: 1, name: 'pay', title: 'Pay', version: '1', base: '{config.host}', timeoutMs: 5000, legacy: 'charge',
  config: { type: 'object', properties: { host: { type: 'string' }, headers: { type: 'object' } } },
  operations: {
    charge: {
      summary: 's', idempotent: true,
      input: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer', minimum: 1 }, ref: { type: 'string' }, body: {} } },
      request: { method: 'POST', url: '{base}/v1/charge/{input.ref}', headers: { authorization: 'Bearer {secret.apiKey}', '...': { $: 'config.headers' } }, body: { amount: { $: 'input.amount' } } },
      output: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      result: { id: '$.id' },
    },
  },
});
const problems = (d) => checkDescriptor(d).map(([p, m]) => `${p}: ${m}`);
const only = (mutate, re, path) => {
  const d = good(); mutate(d);
  const out = checkDescriptor(d);
  assert.ok(out.length >= 1, 'expected a problem');
  const hit = out.find(([p, m]) => re.test(m) && (path === undefined || p === path));
  assert.ok(hit, `no problem matching ${re} at ${path}: ${JSON.stringify(out)}`);
};

test('descriptor: a good one and the built-in http descriptor pass', () => {
  assert.deepEqual(problems(good()), []);
  assert.deepEqual(problems(BUILTIN.http), []);
});

test('descriptor: the longest timeout is half the outbox lease', () => {
  assert.equal(MAX_TIMEOUT_MS, LEASE_MS / 2);
  assert.ok(METHODS.includes('DELETE') && METHODS.includes('GET'));
});

test('descriptor: the top level — fail closed on unknown keys, names and versions', () => {
  assert.deepEqual(problems(null), ['/: a descriptor is an object']);
  assert.deepEqual(problems([]), ['/: a descriptor is an object']);
  only((d) => { d.sandbox = {}; }, /unknown key "sandbox"/, '/sandbox');
  only((d) => { d.descriptor = 2; }, /format version is 1/, '/descriptor');
  only((d) => { delete d.descriptor; }, /format version is 1/);
  only((d) => { d.name = 'Pay Now'; }, /a "name"/, '/name');
  only((d) => { delete d.name; }, /a "name"/);
  only((d) => { d.title = 5; }, /"title" is a string/);
  only((d) => { d.version = 5; }, /"version" is a string/);
  only((d) => { d.timeoutMs = MAX_TIMEOUT_MS + 1; }, /"timeoutMs" is a whole number/, '/timeoutMs');
  only((d) => { d.timeoutMs = 0; }, /"timeoutMs"/);
  only((d) => { d.timeoutMs = 1.5; }, /"timeoutMs"/);
  only((d) => { d.legacy = 'nope'; }, /"legacy" names an operation this descriptor does not have/, '/legacy');
  only((d) => { d.operations = {}; }, /at least one operation/);
  only((d) => { delete d.operations; }, /at least one operation/);
  only((d) => { d.operations = []; }, /at least one operation/);
});

test('descriptor: config and base', () => {
  only((d) => { d.config = { type: 'object', pattren: 1 }; }, /unknown schema keyword/, '/config/pattren');
  only((d) => { d.config = { type: 'string' }; }, /must be "object"/, '/config/type');
  only((d) => { d.config = {}; }, /must be "object"/);
  only((d) => { d.base = 5; }, /"base" is a string template/, '/base');
  only((d) => { d.base = '{secret.k}'; }, /\{secret\.\*\} may not appear here/, '/base');
  only((d) => { d.base = '{input.x}'; }, /\{input\.\*\} may not appear here/, '/base');
  only((d) => { d.base = '{base}'; }, /needs a "base"/, '/base');
  only((d) => { d.base = '{config.nope}'; }, /\{config\.nope\} is not declared/, '/base');
  only((d) => { d.base = '{oops}'; }, /unknown name/);
  const noBase = good(); delete noBase.base; delete noBase.config; noBase.operations.charge.request.url = 'https://x.test';
  noBase.operations.charge.request.headers = {};
  assert.deepEqual(problems(noBase), [], 'a descriptor may have no config and no base');
});

test('descriptor: an operation says whether it is idempotent, and has an object input', () => {
  const op = (d) => d.operations.charge;
  only((d) => { d.operations['bad name'] = op(d); }, /cannot be an operation name/);
  only((d) => { d.operations.charge = 5; }, /an operation is an object/, '/operations/charge');
  only((d) => { op(d).extra = 1; }, /unknown key "extra"/, '/operations/charge/extra');
  only((d) => { delete op(d).idempotent; }, /whether it is idempotent/, '/operations/charge/idempotent');
  only((d) => { op(d).idempotent = 'yes'; }, /whether it is idempotent/);
  only((d) => { delete op(d).input; }, /needs an "input" schema/);
  only((d) => { op(d).input.type = 'array'; }, /must be "object"/, '/operations/charge/input/type');
  only((d) => { op(d).input.properties['a b'] = {}; }, /cannot be named in a template/);
  only((d) => { op(d).input.properties.amount.minimun = 1; }, /unknown schema keyword "minimun"/);
  only((d) => { op(d).output = { oneOf: [] }; }, /unknown schema keyword "oneOf"/, '/operations/charge/output/oneOf');
});

test('descriptor: the request — url, method, headers, body and the references they make', () => {
  const op = (d) => d.operations.charge;
  only((d) => { delete op(d).request; }, /needs a "request" object/);
  only((d) => { op(d).request = []; }, /needs a "request" object/);
  only((d) => { op(d).request.encoding = 'form'; }, /unknown key "encoding"/, '/operations/charge/request/encoding');
  only((d) => { delete op(d).request.url; }, /"url" as a template string/);
  only((d) => { op(d).request.url = 5; }, /"url" as a template string/);
  only((d) => { op(d).request.url = '{base}/x?k={secret.apiKey}'; }, /\{secret\.\*\} may not appear here: the value would be shown in the outbox/, '/operations/charge/request/url');
  only((d) => { op(d).request.method = 'FETCH'; }, /unsupported method "FETCH"/);
  only((d) => { op(d).request.method = 5; }, /"method" is a string/);
  only((d) => { op(d).request.method = '{secret.m}'; }, /\{secret/);
  only((d) => { op(d).request.headers = 'x'; }, /"headers" is an object/);
  only((d) => { op(d).request.headers = { a: '{key}' }; }, /idempotency key\) cannot be used in a template/);
  only((d) => { op(d).request.body = { a: '{input.nope}' }; }, /\{input\.nope\} is not an input of this operation/, '/operations/charge/request/body');
  only((d) => { op(d).request.body = { a: '{config.nope}' }; }, /\{config\.nope\} is not declared in "config"/);
  only((d) => { delete d.config; }, /is not declared in "config"/);
  only((d) => { op(d).request.body = { a: '{nope}' }; }, /unknown name "nope"/);
  const free = good(); free.operations.charge.input = { type: 'object' };
  free.operations.charge.request.url = '{base}/{input.anything}';
  assert.deepEqual(problems(free), [], 'a free-form input may be referred to by any name');
  const bare = good(); delete bare.operations.charge.request.method; delete bare.operations.charge.request.headers; delete bare.operations.charge.request.body;
  assert.deepEqual(problems(bare), []);
});

test('descriptor: result reads the answer, so it needs an output and valid paths', () => {
  const op = (d) => d.operations.charge;
  only((d) => { delete op(d).output; }, /needs an "output" schema/, '/operations/charge/result');
  only((d) => { op(d).result = []; }, /maps a name to a \$\.path/);
  only((d) => { op(d).result = { id: 'id' }; }, /starts with \$/, '/operations/charge/result/id');
  only((d) => { op(d).result = { id: '$.a..b' }; }, /expected .name/);
  const noOutput = good(); delete noOutput.operations.charge.output; delete noOutput.operations.charge.result;
  assert.deepEqual(problems(noOutput), []);
});
