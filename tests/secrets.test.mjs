// The secret store (encryption, wrong key, tampering, rotation), the masking of secret values,
// and the deploy file that holds each connector's mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openSecrets } from '../runtime/secrets.mjs';
import { redact, redactDeep } from '../runtime/connectors/redact.mjs';
import { readDeploy, writeMode, modeOf, modesOf, connectorModes, connectorEnv } from '../runtime/deploy.mjs';
import { createRegistry } from '../runtime/registry.mjs';
import { tmpDir } from './helpers.mjs';

const KEY = crypto.randomBytes(32).toString('base64');
const store = (dir, env = {}, app = 'a') => openSecrets({ dir, app, env });
const blob = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8'));
const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };

test('secrets: set, get, names and remove round-trip; the file holds neither a name nor a value in the clear', (t) => {
  const dir = tmpDir('ag-sec-', t);
  const s = store(dir);
  assert.deepEqual([s.names(), s.get('stripe_key'), s.values()], [[], [], []], 'no file is an empty store, and needs no key');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.key')), false, 'reading creates no key');
  s.set('stripe_key', 'sk_live_VALUE-1');
  s.set('mail_token', 'tok/é"2');
  assert.deepEqual(s.get('stripe_key'), ['sk_live_VALUE-1']);
  assert.deepEqual(s.names(), ['mail_token', 'stripe_key']);
  assert.deepEqual(s.values().sort(), ['sk_live_VALUE-1', 'tok/é"2']);
  const text = fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8');
  for (const leak of ['stripe_key', 'mail_token', 'VALUE-1', 'tok/']) assert.equal(text.includes(leak), false, `${leak} is not in the file`);
  assert.deepEqual(Object.keys(blob(dir)).sort(), ['alg', 'ct', 'nonce', 'salt', 'tag', 'v']);
  assert.equal(s.remove('mail_token'), true);
  assert.equal(s.remove('mail_token'), false);
  assert.deepEqual(store(dir).names(), ['stripe_key'], 'another handle sees the same file');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.enc.tmp')), false, 'the write went through a rename');
});

test('secrets: the key file and the store are readable by their owner only; each write is sealed afresh', (t) => {
  const dir = tmpDir('ag-sec-', t);
  const s = store(dir);
  s.set('a', '1');
  const first = blob(dir);
  s.set('a', '1');
  const second = blob(dir);
  assert.notEqual(first.ct, second.ct);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.salt, second.salt);
  assert.equal(fs.statSync(path.join(dir, 'secrets.key')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'secrets.enc')).mode & 0o777, 0o600);
  assert.equal(Buffer.from(fs.readFileSync(path.join(dir, 'secrets.key'), 'utf8').trim(), 'base64').length, 32);
});

test('secrets: CANOPY_MASTER_KEY is used when set and no key file is written; another key cannot open the store', (t) => {
  const dir = tmpDir('ag-sec-', t);
  store(dir, { CANOPY_MASTER_KEY: KEY }).set('k', 'v');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.key')), false);
  assert.deepEqual(store(dir, { CANOPY_MASTER_KEY: KEY }).get('k'), ['v']);
  const other = crypto.randomBytes(32).toString('base64');
  assert.throws(() => store(dir, { CANOPY_MASTER_KEY: other }).get('k'), /secrets\.enc cannot be read: the master key is wrong or the file was changed/);
  assert.throws(() => store(dir, { CANOPY_MASTER_KEY: other }).set('k2', 'v'), /master key is wrong/, 'a write never overwrites what it could not read');
  assert.deepEqual(store(dir, { CANOPY_MASTER_KEY: KEY }).get('k'), ['v'], 'and the file is intact');
});

test('secrets: a wrong key file, a missing key and a malformed key fail closed with a message that says what to do', (t) => {
  const dir = tmpDir('ag-sec-', t);
  store(dir).set('k', 'v');
  fs.writeFileSync(path.join(dir, 'secrets.key'), `${crypto.randomBytes(32).toString('base64')}\n`);
  assert.throws(() => store(dir).get('k'), /master key is wrong/);
  fs.rmSync(path.join(dir, 'secrets.key'));
  assert.throws(() => store(dir).get('k'), /there is no master key: set CANOPY_MASTER_KEY or restore secrets\.key/);
  assert.throws(() => store(dir, { CANOPY_MASTER_KEY: 'c2hvcnQ=' }).get('k'), /the master key must be 32 bytes, base64/);
});

test('secrets: any changed byte of the file — tag, ciphertext, nonce, salt — or another app is refused', (t) => {
  const dir = tmpDir('ag-sec-', t);
  const s = store(dir);
  s.set('k', 'v');
  const good = fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8');
  for (const field of ['tag', 'ct', 'nonce', 'salt']) {
    const b = blob(dir);
    b[field] = flip(b[field]);
    fs.writeFileSync(path.join(dir, 'secrets.enc'), JSON.stringify(b));
    assert.throws(() => s.get('k'), /the master key is wrong or the file was changed/, field);
    assert.throws(() => s.names(), /file was changed/, field);
  }
  for (const [field, cut] of [['tag', 4], ['tag', 15], ['nonce', 11]]) {
    const b = blob2(good);
    b[field] = Buffer.from(b[field], 'base64').subarray(0, cut).toString('base64');
    fs.writeFileSync(path.join(dir, 'secrets.enc'), JSON.stringify(b));
    assert.throws(() => s.get('k'), /the master key is wrong or the file was changed/, `${field} cut to ${cut}`);
  }
  const last = blob2(good), tagBytes = Buffer.from(last.tag, 'base64');
  tagBytes[15] ^= 1;
  fs.writeFileSync(path.join(dir, 'secrets.enc'), JSON.stringify({ ...last, tag: tagBytes.toString('base64') }));
  assert.throws(() => s.get('k'), /file was changed/, 'the last byte of the tag counts');
  fs.writeFileSync(path.join(dir, 'secrets.enc'), good);
  assert.deepEqual(s.get('k'), ['v']);
  assert.throws(() => store(dir, {}, 'another-app').get('k'), /file was changed/, 'the app is part of what is authenticated');
  for (const bad of [{ ...blob(dir), v: 2 }, { ...blob(dir), alg: 'aes-128-cbc' }, null]) {
    fs.writeFileSync(path.join(dir, 'secrets.enc'), JSON.stringify(bad));
    assert.throws(() => s.get('k'), /unknown format/);
  }
  fs.writeFileSync(path.join(dir, 'secrets.enc'), 'not json');
  assert.throws(() => s.get('k'), /it is not a secret store/);
  fs.writeFileSync(path.join(dir, 'secrets.enc'), JSON.stringify({ ...JSON.parse(good), salt: 5 }));
  assert.throws(() => s.get('k'), /file was changed/, 'a field of the wrong type is a changed file, not a crash');
});

const blob2 = (text) => JSON.parse(text);

test('secrets: a key file that group or others can read is refused, like ssh does', (t) => {
  const dir = tmpDir('ag-sec-', t);
  const s = store(dir);
  s.set('k', 'v');
  for (const mode of [0o640, 0o604, 0o644]) {
    fs.chmodSync(path.join(dir, 'secrets.key'), mode);
    assert.throws(() => s.get('k'), /secrets\.key is readable by group or others: run chmod 600/, mode.toString(8));
    assert.throws(() => s.set('x', 'y'), /chmod 600/);
  }
  fs.chmodSync(path.join(dir, 'secrets.key'), 0o400);
  assert.deepEqual(s.get('k'), ['v'], 'owner-only is fine');
  fs.chmodSync(path.join(dir, 'secrets.key'), 0o644);
  assert.deepEqual(store(dir, { CANOPY_MASTER_KEY: fs.readFileSync(path.join(dir, 'secrets.key'), 'utf8').trim() }).get('k'), ['v'], 'the file is not consulted when the environment gives the key');
});

test('secrets: rotation — a name and its .prev are both returned, newest first; a name is a name, not a path', (t) => {
  const dir = tmpDir('ag-sec-', t);
  const s = store(dir);
  s.set('hook', 'new');
  assert.deepEqual(s.get('hook'), ['new']);
  s.set('hook.prev', 'old');
  assert.deepEqual(s.get('hook'), ['new', 'old']);
  s.remove('hook');
  assert.deepEqual(s.get('hook'), ['old'], 'the previous value alone still answers during a rotation');
  for (const bad of ['', '1x', 'a b', '../x', 'a.b', 'a.prev.prev', 'x\n']) assert.throws(() => s.set(bad, 'v'), /cannot be a secret name/, JSON.stringify(bad));
  assert.throws(() => s.set('ok', ''), /a secret cannot be empty/);
});

test('redact: a value is masked as it is, as JSON text and as a URL component, longest first; deep, and only strings', () => {
  const values = ['abc', 'abc/d"e', '', 7, undefined];
  assert.equal(redact('x abc y', values), 'x «secret» y');
  assert.equal(redact('abc/d"e and abc', values), '«secret» and «secret»', 'the longer value is not left half masked');
  assert.equal(redact('{"k":"abc/d\\"e"}', values), '{"k":"«secret»"}');
  assert.equal(redact('?q=abc%2Fd%22e', values), '?q=«secret»');
  assert.equal(redact('nothing here', values), 'nothing here');
  assert.equal(redact(42, ['4']), '«secret»2', 'a non-string is text first');
  assert.equal(redact('anything', []), 'anything');
  const deep = { a: 'abc', b: ['abc', 1, null, { c: 'xabcx' }], n: 5, ok: true };
  assert.deepEqual(redactDeep(deep, values), { a: '«secret»', b: ['«secret»', 1, null, { c: 'x«secret»x' }], n: 5, ok: true });
  assert.deepEqual(deep.a, 'abc', 'the original is not changed');
});

test('deploy: no file is every connector at its first mode; the file is read afresh and written whole', (t) => {
  const dir = tmpDir('ag-dep-', t);
  const registry = createRegistry();
  const graph = { connectors: { web: { kind: 'http' }, letters: { kind: 'mail' }, x: { kind: 'nope' } } };
  assert.deepEqual(readDeploy(dir), { connectors: {} });
  assert.deepEqual(modesOf(registry, 'http'), ['live']);
  assert.deepEqual(modesOf(registry, 'mail'), ['sandbox']);
  assert.deepEqual(modesOf(registry, 'nope'), ['live'], 'a kind that says nothing runs as it always did');
  assert.deepEqual(connectorModes(graph, registry, readDeploy(dir)).map((m) => [m.connector, m.mode]), [['web', 'live'], ['letters', 'sandbox'], ['x', 'live']]);
  assert.deepEqual(connectorModes({}, registry, readDeploy(dir)), []);
  assert.equal(modeOf({ connectors: { web: 'sandbox' } }, 'web', ['live']), 'sandbox', 'the file decides');
  writeMode(dir, 'web', 'sandbox');
  writeMode(dir, 'other', 'live');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'deploy.json'), 'utf8')), { connectors: { web: 'sandbox', other: 'live' } });
  assert.equal(fs.existsSync(path.join(dir, 'deploy.json.tmp')), false);
  const env = connectorEnv(dir, 'a', {});
  assert.equal(env.deploy().connectors.web, 'sandbox');
  writeMode(dir, 'web', 'live');
  assert.equal(env.deploy().connectors.web, 'live', 'read on every call, so the command line takes effect without a restart');
  assert.deepEqual(env.secrets.names(), []);
});

test('deploy: a file that is not JSON or not the shape is an error, never a silent default', (t) => {
  const dir = tmpDir('ag-dep-', t);
  const put = (text) => fs.writeFileSync(path.join(dir, 'deploy.json'), text);
  put('{');
  assert.throws(() => readDeploy(dir), /deploy\.json is not JSON/);
  for (const bad of ['[]', 'null', '{}', '{"connectors": []}', '{"connectors": {"p": "prod"}}', '{"connectors": {"p": {"mode": "live"}}}']) {
    put(bad);
    assert.throws(() => readDeploy(dir), /deploy\.json is \{"connectors"/, bad);
  }
});
