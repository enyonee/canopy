// A property, not an example: for any schema of the subset and any value, an input that
// validates always builds a request, and one that does not never gets as far as being queued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validate } from '../runtime/connectors/schema.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { prepare, buildRequest } from '../runtime/connectors/engine.mjs';

let seed = 20260929;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];

const word = (n) => Array.from({ length: n }, () => pick('abcxyz')).join('');

function randomSchema(depth = 0) {
  const kinds = depth > 2 ? ['string', 'integer', 'number', 'boolean', 'enum'] : ['string', 'integer', 'number', 'boolean', 'enum', 'array', 'object'];
  const kind = pick(kinds);
  if (kind === 'enum') return { enum: [pick(['a', 'b']), int(0, 3), null] };
  if (kind === 'string') return { type: 'string', ...(rnd() < 0.5 ? { minLength: int(0, 3), maxLength: int(3, 8) } : {}), ...(rnd() < 0.3 ? { format: pick(['email', 'uri', 'date-time']) } : {}) };
  if (kind === 'integer' || kind === 'number') return { type: kind, ...(rnd() < 0.5 ? { minimum: int(-5, 0), maximum: int(1, 9) } : {}) };
  if (kind === 'boolean') return { type: 'boolean' };
  if (kind === 'array') return { type: 'array', items: randomSchema(depth + 1) };
  const properties = {};
  for (let i = 0; i < int(1, 3); i++) properties[`p${i}`] = randomSchema(depth + 1);
  const names = Object.keys(properties);
  return { type: 'object', properties, required: names.filter(() => rnd() < 0.5), ...(rnd() < 0.3 ? { additionalProperties: true } : {}) };
}

// A value that fits the schema most of the time, and sometimes is deliberately off.
function randomValue(s) {
  if (rnd() < 0.08) return pick([null, 'x', 7, true, [], {}, 1.5, -100]);
  if (s.enum) return pick(s.enum);
  switch (s.type) {
    case 'string': return s.format === 'email' ? 'a@b.co' : s.format === 'uri' ? 'https://x.test' : s.format === 'date-time' ? '2026-09-29T12:00:00Z' : word(int(s.minLength ?? 0, s.maxLength ?? 6));
    case 'integer': return int(s.minimum ?? -3, s.maximum ?? 9);
    case 'number': return int((s.minimum ?? -3) * 2, (s.maximum ?? 9) * 2) / 2;
    case 'boolean': return rnd() < 0.5;
    case 'array': return Array.from({ length: int(0, 3) }, () => randomValue(s.items));
    default: {
      const out = {};
      for (const [k, sub] of Object.entries(s.properties)) if ((s.required || []).includes(k) || rnd() < 0.6) out[k] = randomValue(sub);
      if (rnd() < 0.1) out.extra = 1;
      return out;
    }
  }
}

test('any schema the generator makes is a valid schema of the subset', () => {
  for (let i = 0; i < 200; i++) assert.deepEqual(checkSchema(randomSchema()), [], `schema ${i}`);
});

test('any input that validates builds a request whose body is that input; any that does not is refused before it is queued', () => {
  let valid = 0, refused = 0;
  for (let i = 0; i < 400; i++) {
    const input = { type: 'object', properties: { a: randomSchema(), b: randomSchema(), c: randomSchema() }, required: ['a'] };
    const descriptor = { descriptor: 1, name: 'gen', config: { type: 'object', properties: { host: { type: 'string' } } },
      operations: { op: { idempotent: true, input, request: { method: 'PUT', url: '{config.host}/op', body: { $: 'input' } } } } };
    assert.deepEqual(checkDescriptor(descriptor), [], `descriptor ${i}`);
    const value = randomValue(input);
    const connector = { kind: 'gen', host: 'https://gen.test' };
    if (validate(input, value).length === 0) {
      valid++;
      const { input: stored, target } = prepare(descriptor, connector, 'op', value);
      const req = buildRequest(descriptor, connector, 'op', stored);
      assert.equal(target, 'https://gen.test/op');
      assert.equal(req.method, 'PUT');
      assert.deepEqual(JSON.parse(req.body), JSON.parse(JSON.stringify(value)), `body ${i}`);
    } else {
      refused++;
      assert.throws(() => prepare(descriptor, connector, 'op', value), /^Error: gen\.op: input/, `refused ${i}`);
    }
  }
  assert.ok(valid > 100 && refused > 20, `the generator reaches both sides (${valid} valid, ${refused} refused)`);
});
