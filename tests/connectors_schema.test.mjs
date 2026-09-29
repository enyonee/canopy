// The schema subset of connector descriptors (runtime/connectors/schema.mjs): each keyword
// on its own, every way a schema itself can be wrong, and the fail-closed rule for a keyword
// the subset does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validate, withDefaults, KEYWORDS } from '../runtime/connectors/schema.mjs';

const msgs = (list) => list.map(([p, m]) => `${p}: ${m}`);
const bad = (schema, value, re) => {
  const out = validate(schema, value);
  assert.ok(out.length, `${JSON.stringify(value)} should be refused by ${JSON.stringify(schema)}`);
  if (re) assert.match(msgs(out).join('\n'), re);
};
const good = (schema, value) => assert.deepEqual(validate(schema, value), [], `${JSON.stringify(value)} should fit ${JSON.stringify(schema)}`);

test('type: each type accepts its values and refuses the others', () => {
  const table = { string: ['a', 1], integer: [3, 1.5], number: [1.5, '1'], boolean: [false, 0], null: [null, 0], array: [[], {}], object: [{}, []] };
  for (const [type, [yes, no]] of Object.entries(table)) { good({ type }, yes); bad({ type }, no, /must be/); }
  bad({ type: 'number' }, Number.NaN);
  good({}, { anything: [1] });
  good({}, null);
});

test('enum compares by value, including objects', () => {
  good({ enum: ['a', 1, { k: 1 }] }, { k: 1 });
  bad({ enum: ['a', 1] }, 'b', /one of: "a", 1/);
});

test('string: length, pattern and format', () => {
  bad({ minLength: 2 }, 'a', /at least 2/); good({ minLength: 2 }, 'ab');
  bad({ maxLength: 2 }, 'abc', /at most 2/); good({ maxLength: 2 }, 'ab');
  bad({ pattern: '^[A-Z]{3}$' }, 'usd', /must match/); good({ pattern: '^[A-Z]{3}$' }, 'USD');
  good({ format: 'email' }, 'a@b.co'); bad({ format: 'email' }, 'a@b', /valid email/);
  good({ format: 'date-time' }, '2026-09-29T12:00:00Z'); bad({ format: 'date-time' }, '2026-09-29', /date-time/);
  bad({ format: 'date-time' }, '2026-13-99T99:99:99Z');
  good({ format: 'uri' }, 'https://x.test/a'); bad({ format: 'uri' }, 'not a uri', /valid uri/);
});

test('number: minimum and maximum are inclusive', () => {
  bad({ minimum: 1 }, 0, /at least 1/); good({ minimum: 1 }, 1);
  bad({ maximum: 5 }, 6, /at most 5/); good({ maximum: 5 }, 5);
});

test('object: required, closed by default when properties are declared, open when they are not', () => {
  const s = { type: 'object', required: ['a'], properties: { a: { type: 'integer' }, b: { type: 'string' } } };
  good(s, { a: 1 }); good(s, { a: 1, b: 'x' });
  bad(s, {}, /\/a: is required/);
  bad(s, { a: 1, c: 1 }, /\/c: unknown property "c"/);
  bad(s, { a: 'x' }, /\/a: must be a integer/);
  good({ ...s, additionalProperties: true }, { a: 1, c: 1 });
  bad({ ...s, additionalProperties: false }, { a: 1, c: 1 });
  good({ type: 'object' }, { whatever: 1 });
  good(s, { a: 1, b: undefined });
  assert.deepEqual(validate(s, { a: 1, c: 1 }, '', { extra: true }), [], 'the caller decides the default: a provider answer is open');
  assert.equal(validate({ ...s, additionalProperties: false }, { a: 1, c: 1 }, '', { extra: true }).length, 1, 'but a schema that says false still means it');
});

test('array: items are checked one by one with their position in the path', () => {
  const s = { type: 'array', items: { type: 'integer' } };
  good(s, [1, 2]); good({ type: 'array' }, [1, 'a']);
  assert.deepEqual(msgs(validate(s, [1, 'x', 3])), ['/1: must be a integer']);
  assert.deepEqual(msgs(validate({ type: 'object', properties: { l: s } }, { l: [1, 'x'] })), ['/l/1: must be a integer']);
});

test('a "message" replaces the text of a failure at its node, "{value}" is the value; "hint" comes along', () => {
  const s = { type: 'string', pattern: '^x', message: 'need x, got "{value}"', hint: 'start with x' };
  assert.deepEqual(validate(s, 'abc'), [['', 'need x, got "abc"', 'start with x']]);
  assert.deepEqual(validate(s, 5), [['', 'need x, got "5"', 'start with x']], 'also for the wrong type');
  const o = { type: 'object', required: ['u'], properties: { u: s } };
  assert.equal(validate(o, {})[0][1], 'need x, got ""', 'and for a missing required property, from the property\'s schema');
});

test('withDefaults fills what is missing, recursively, and touches nothing else', () => {
  const s = { type: 'object', properties: { m: { type: 'string', default: 'POST' }, n: { type: 'object', properties: { k: { default: 1 } } }, z: { default: 0 } } };
  assert.deepEqual(withDefaults(s, {}), { m: 'POST', z: 0 });
  assert.deepEqual(withDefaults(s, { m: 'GET', n: {} }), { m: 'GET', n: { k: 1 }, z: 0 });
  assert.deepEqual(withDefaults(s, { z: null }), { m: 'POST', z: null }, 'null is a value');
  assert.equal(withDefaults({ type: 'string' }, 'x'), 'x');
  assert.equal(withDefaults(s, 5), 5);
});

test('checkSchema: an unknown keyword is an error, never ignored', () => {
  assert.deepEqual(checkSchema({ type: 'string', minLength: 1 }), []);
  const out = checkSchema({ type: 'string', patern: 'x' }, '/op/input');
  assert.equal(out.length, 1);
  assert.equal(out[0][0], '/op/input/patern');
  assert.match(out[0][1], /unknown schema keyword "patern"/);
  assert.match(out[0][2], /keywords: type, properties/);
  for (const k of ['oneOf', 'anyOf', 'allOf', '$ref', 'not', 'if', 'const', 'multipleOf', 'uniqueItems', 'minItems'])
    assert.equal(checkSchema({ [k]: 1 }).length, 1, `${k} is not in the subset`);
  assert.equal(checkSchema({ properties: { a: { nope: 1 } } }, '/x')[0][0], '/x/properties/a/nope', 'nested schemas are checked too');
  assert.equal(checkSchema({ type: 'array', items: { nope: 1 } })[0][0], '/items/nope');
  assert.ok(KEYWORDS.includes('type') && KEYWORDS.includes('message'));
});

test('checkSchema: every keyword must have the shape it is used with', () => {
  const one = (schema, re) => { const out = checkSchema(schema); assert.ok(out.length >= 1, JSON.stringify(schema)); assert.match(out.map((o) => o[1]).join('\n'), re); };
  one(null, /a schema is an object/); one([], /a schema is an object/); one({ properties: 5 }, /an object of schemas/);
  one({ properties: [] }, /an object of schemas/);
  one({ type: 'text' }, /"type" is one of/);
  one({ required: 'a' }, /list of property names/); one({ required: [1] }, /list of property names/);
  one({ properties: { a: {} }, required: ['b'] }, /"b" is not among the properties/);
  one({ required: ['a'] }, /needs "properties"/);
  one({ additionalProperties: {} }, /true or false/);
  one({ enum: [] }, /non-empty list/); one({ enum: 'a' }, /non-empty list/);
  one({ format: 'phone' }, /"format" is one of/);
  one({ minLength: -1 }, /whole number/); one({ maxLength: 1.5 }, /whole number/);
  one({ minimum: '1' }, /is a number/); one({ maximum: Number.POSITIVE_INFINITY }, /is a number/);
  one({ pattern: 5 }, /is a string/); one({ pattern: '(' }, /not a regular expression/);
  one({ message: 5 }, /"message" is a string/); one({ hint: 5 }, /"hint" is a string/);
  one({ type: 'integer', default: 'x' }, /must be a integer/);
});
