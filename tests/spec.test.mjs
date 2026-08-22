import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseField, sqlType, defaultValue, coerce } from '../runtime/spec.mjs';

test('parses every kind of field spec', () => {
  assert.deepEqual(parseField('title', 'text!'), { name: 'title', kind: 'text', options: null, target: null, required: true, optional: false, def: null });
  assert.equal(parseField('notes', 'longtext').kind, 'longtext');
  assert.equal(parseField('n', 'int=3').def, '3');
  assert.equal(parseField('at', 'time=now').kind, 'time');
  assert.equal(parseField('who', 'ref:User?').target, 'User');
  assert.equal(parseField('who', 'ref:User?').optional, true);
  assert.deepEqual(parseField('s', 'enum[a, b ,c]=a').options, ['a', 'b', 'c']);
  assert.equal(parseField('s', '  text  ').kind, 'text', 'surrounding spaces are trimmed');
});

test('rejects what it cannot represent, and says what it knows', () => {
  assert.throws(() => parseField('due', 'date!'), /unknown type "date".*text, longtext, bool, int, time/s);
  assert.throws(() => parseField('s', 'enum[]'), /enum needs at least one option/);
  assert.throws(() => parseField('s', 42), /spec must be a string/);
});

test('maps kinds to storage types', () => {
  assert.equal(sqlType(parseField('a', 'int')), 'INTEGER');
  assert.equal(sqlType(parseField('a', 'bool')), 'INTEGER');
  for (const k of ['text', 'longtext', 'time', 'enum[a]', 'ref:X']) assert.equal(sqlType(parseField('a', k)), 'TEXT');
});

test('defaults: a declared default is a value, an undeclared one is null (except bool)', () => {
  assert.equal(defaultValue(parseField('a', 'bool')), 0);
  assert.equal(defaultValue(parseField('a', 'bool=true')), 1);
  assert.equal(defaultValue(parseField('a', 'bool=false')), 0);
  assert.equal(defaultValue(parseField('a', 'int=7')), 7);
  assert.equal(defaultValue(parseField('a', 'text')), null);
  assert.equal(defaultValue(parseField('a', 'text=hi')), 'hi');
  assert.equal(defaultValue(parseField('a', 'time=2020-01-01')), '2020-01-01');
  assert.match(defaultValue(parseField('a', 'time=now')), /^\d{4}-\d{2}-\d{2}T/);
});

test('coercion accepts every shape a browser or a block can send — this is where three defects lived', () => {
  const b = parseField('done', 'bool=false');
  for (const truthy of [true, 1, 'true', 'on', '1']) assert.equal(coerce(b, truthy), 1, `${JSON.stringify(truthy)} must be true`);
  for (const falsy of [false, 0, 'false', 'off', '', undefined, null]) assert.equal(coerce(b, falsy), 0, `${JSON.stringify(falsy)} must be false`);
  const i = parseField('n', 'int');
  assert.equal(coerce(i, '5'), 5);
  assert.equal(coerce(i, ''), null);
  assert.equal(coerce(i, undefined), null);
  const t = parseField('s', 'text');
  assert.equal(coerce(t, 5), '5');
  assert.equal(coerce(t, undefined), null);
});
