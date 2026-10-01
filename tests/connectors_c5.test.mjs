// C5, the engine features the first real providers needed, each generic (no provider is named in the runtime):
// form-encoded bodies (runtime/connectors/form.mjs and `request.encoding`), an answer that is HTTP 200 and still a
// failure (`failure`), the idempotency header, an event id made of several fields or set per event, and the
// inbound `challenge`. The providers themselves are tested in tests/providers.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formEncode, FORM_TYPE } from '../runtime/connectors/form.mjs';
import { buildRequest, mapResponse, deliverRow } from '../runtime/connectors/engine.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { checkInbound, eventIdOf, challengeOf } from '../runtime/connectors/inbound.mjs';
import { settle } from '../runtime/settle.mjs';

// --- form encoding -----------------------------------------------------------------------------

test('form: an object nests as a[b]=1, a list as a[0]=x; null and absent values are left out', () => {
  assert.equal(formEncode({ amount: 2500, currency: 'usd' }), 'amount=2500&currency=usd');
  assert.equal(formEncode({ metadata: { order: '7', who: 'ann' } }), 'metadata[order]=7&metadata[who]=ann');
  assert.equal(formEncode({ a: { b: { c: 1 } } }), 'a[b][c]=1', 'any depth');
  assert.equal(formEncode({ items: ['x', 'y'], o: [{ k: 1 }] }), 'items[0]=x&items[1]=y&o[0][k]=1');
  assert.equal(formEncode({ confirm: true, off: false, n: 0 }), 'confirm=true&off=false&n=0');
  assert.equal(formEncode({ a: null, b: undefined, c: 'kept', d: { e: null } }), 'c=kept', 'an empty value is not sent: the provider default applies');
  assert.equal(formEncode({}), '');
  assert.equal(formEncode({ a: { b: 1 }, c: 2 }), 'a[b]=1&c=2', 'a nested value does not swallow the next name');
});

test('form: names and values are percent-encoded, brackets are not, and a flat key written with brackets equals the nested object', () => {
  assert.equal(formEncode({ description: 'Order 7 & more=1', 'q?': 'é' }), 'description=Order%207%20%26%20more%3D1&q%3F=%C3%A9');
  assert.equal(formEncode({ 'metadata[order]': '7' }), formEncode({ metadata: { order: '7' } }));
  assert.equal(formEncode({ 'a b': { 'c d': 1 } }), 'a%20b[c%20d]=1');
  for (const bad of [null, 'a=1', 5, ['a'], undefined]) assert.throws(() => formEncode(bad), /a form body is an object of names and values/, String(bad));
});

const FORM_D = {
  descriptor: 1, name: 'f', base: 'https://api.f.test', idempotency: { header: 'Idempotency-Key' },
  operations: {
    make: { idempotent: true, input: { type: 'object', properties: { amount: { type: 'integer' }, meta: { type: 'object' } } },
      request: { url: '{base}/v1/things', encoding: 'form', headers: { authorization: 'Bearer {secret.k}' }, body: { amount: { $: 'input.amount' }, metadata: { $: 'input.meta' } } } },
    bare: { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: '{base}/v1/things', encoding: 'form' } },
    custom: { idempotent: true, input: { type: 'object', properties: {} }, request: { url: '{base}/v1/things', encoding: 'form', headers: { 'Content-Type': 'application/x-custom' }, body: { a: 1 } } },
    json: { idempotent: true, input: { type: 'object', properties: {} }, request: { url: '{base}/v1/things', body: { a: { b: 1 } } } },
  },
};
const build = (op, input = {}, opts = {}) => buildRequest(FORM_D, {}, op, input, { secret: () => 'S', ...opts });

test('buildRequest: encoding "form" sends the flattened body with its content type; json stays the default', () => {
  const r = build('make', { amount: 5, meta: { order: '7' } }, { idemKey: 'k1' });
  assert.equal(r.body, 'amount=5&metadata[order]=7');
  assert.equal(r.headers['content-type'], FORM_TYPE);
  assert.equal(FORM_TYPE, 'application/x-www-form-urlencoded');
  assert.equal(r.headers.authorization, 'Bearer S');
  const bare = build('bare');
  assert.equal(bare.body, undefined, 'no body, no content type');
  assert.equal(bare.headers['content-type'], undefined);
  assert.equal(build('custom').headers['Content-Type'], 'application/x-custom', 'a content type the descriptor sets is kept');
  assert.equal(build('custom').headers['content-type'], undefined, 'and not set twice under another case');
  assert.equal(build('json').body, '{"a":{"b":1}}');
  assert.equal(build('json').headers['content-type'], undefined, 'json sets none by itself: the descriptor says it');
});

test('buildRequest: the idempotency header carries the row\'s key (and only when there is a key)', () => {
  assert.equal(build('make', {}, { idemKey: 'key-from-the-row' }).headers['Idempotency-Key'], 'key-from-the-row');
  assert.equal('Idempotency-Key' in build('make', {}), false);
});

// --- the checker --------------------------------------------------------------------------------

const withOp = (patch) => ({ ...FORM_D, operations: { make: { ...FORM_D.operations.make, ...patch } } });
const problems = (d) => checkDescriptor(d).map(([p, m]) => `${p}: ${m}`);

test('descriptor: "encoding" is json or form, and a form body is an object', () => {
  assert.deepEqual(problems(FORM_D), []);
  const req = (r) => withOp({ request: { ...FORM_D.operations.make.request, ...r } });
  assert.match(problems(req({ encoding: 'xml' })).join('\n'), /\/operations\/make\/request\/encoding: "encoding" is one of: json, form/);
  assert.deepEqual(problems(req({ encoding: 'json' })), []);
  assert.match(problems(req({ body: 'text' })).join('\n'), /a form body is an object of names and values/);
  assert.match(problems(req({ body: [1] })).join('\n'), /a form body is an object/);
  assert.deepEqual(problems(req({ body: { a: 1 } })), []);
});

test('descriptor: "failure" names the flag, the reason and the statuses, and every part is checked', () => {
  const ok = { path: '$.ok', equals: false, error: '$.error', code: 400, codes: { ratelimited: 429, internal_error: 503 } };
  assert.deepEqual(problems(withOp({ failure: ok })), []);
  assert.deepEqual(problems(withOp({ failure: { path: '$.ok', equals: false } })), [], 'the reason and the statuses are optional');
  const bad = (f) => problems(withOp({ failure: f })).join('\n');
  assert.match(bad('x'), /"failure" is an object/);
  assert.match(bad({ ...ok, more: 1 }), /unknown key "more"/);
  assert.match(bad({ ...ok, path: 'ok' }), /failure\/path: "ok" is not a path/);
  assert.match(bad({ ...ok, path: undefined }), /failure\/path/);
  assert.match(bad({ ...ok, error: 'error' }), /failure\/error: "error" is not a path/);
  for (const equals of [undefined, null, {}, [false]]) assert.match(bad({ ...ok, equals }), /"equals" is the text, number or true\/false/, JSON.stringify(equals));
  for (const code of [200, 399, 600, 4.5, '400']) assert.match(bad({ ...ok, code }), /"code" is the HTTP status \(400 to 599\)/, String(code));
  for (const codes of [[], 'x', { a: 200 }, { a: '429' }, null]) assert.match(bad({ ...ok, codes }), /"codes" maps a reason to the HTTP status/, JSON.stringify(codes));
});

test('checkInbound: eventId may be a list of up to four body paths, an event may have its own, a challenge is a declared block', () => {
  const base = { signature: { scheme: 'slack' }, secret: 's', eventId: '$.id', type: '$.type', events: { a: { schema: { type: 'object' } } } };
  const bad = (inb) => checkInbound(inb).map(([p, m]) => `${p}: ${m}`).join('\n');
  assert.equal(bad({ ...base, eventId: ['$.a', '$.b.c', '$.d[0]'] }), '');
  assert.equal(bad({ ...base, events: { a: { schema: { type: 'object' }, eventId: ['$.x', '$.y'] } } }), '');
  assert.equal(bad({ ...base, events: { a: { schema: { type: 'object' }, eventId: '$.x' } } }), '');
  for (const eventId of [{ header: 'x-id' }, [], ['$.a', 5], ['$.a', '$.b', '$.c', '$.d', '$.e'], ['$.a['], 7]) {
    assert.match(bad({ ...base, events: { a: { schema: { type: 'object' }, eventId } } }), /\/inbound\/events\/a\/eventId/, JSON.stringify(eventId));
  }
  const challenge = { type: '$.type', equals: 'url_verification', echo: '$.challenge' };
  assert.equal(bad({ ...base, challenge }), '');
  assert.match(bad({ ...base, challenge: 'x' }), /"challenge" is an object/);
  assert.match(bad({ ...base, challenge: { ...challenge, more: 1 } }), /unknown key "more"/);
  for (const k of ['type', 'echo']) {
    assert.match(bad({ ...base, challenge: { ...challenge, [k]: 'nope' } }), new RegExp(`challenge/${k}`), k);
    assert.match(bad({ ...base, challenge: { ...challenge, [k]: undefined } }), new RegExp(`"${k}" is a \\$\\.path into the JSON body`), k);
    assert.match(bad({ ...base, challenge: { ...challenge, [k]: { header: 'x' } } }), new RegExp(`challenge/${k}`), k);
  }
  for (const equals of [undefined, '', 5]) assert.match(bad({ ...base, challenge: { ...challenge, equals } }), /"equals" is the text the type has/, String(equals));
});

// --- ids and challenges ---------------------------------------------------------------------------

test('eventIdOf: a list of paths makes one id (as JSON, so no piece runs into the next), an event\'s own id wins, any missing piece is no id', () => {
  const inb = { eventId: '$.id' };
  assert.equal(eventIdOf(inb, { id: 'a' }), 'a');
  assert.equal(eventIdOf(inb, { id: 'a' }, { eventId: ['$.x'] }), undefined, 'the event\'s own path is the one read');
  assert.equal(eventIdOf(inb, { id: 'a', x: 'own' }, { eventId: '$.x' }), 'own');
  const ev = { eventId: ['$.m', '$.who', '$.at'] };
  assert.equal(eventIdOf(inb, { m: 'M1', who: 'a@x.test', at: '2024-01-01T00:00:00Z' }, ev), '["M1","a@x.test","2024-01-01T00:00:00Z"]');
  assert.notEqual(eventIdOf(inb, { m: 'a|b', who: 'c', at: 'd' }, ev), eventIdOf(inb, { m: 'a', who: 'b|c', at: 'd' }, ev), 'the pieces cannot be shifted into each other');
  assert.equal(eventIdOf(inb, { m: 5, who: 'w', at: 't' }, ev), '["5","w","t"]', 'a whole number is a piece, as text');
  for (const bad of [{ m: 'M', who: 'w' }, { m: 'M', who: '', at: 't' }, { m: 'M', who: 1.5, at: 't' }, { m: 'M', who: null, at: 't' }]) assert.equal(eventIdOf(inb, bad, ev), undefined, JSON.stringify(bad));
  assert.equal(eventIdOf(inb, { m: 'x'.repeat(250), who: 'w', at: 't' }, ev), undefined, 'the whole id is capped at 255');
});

test('challengeOf: not a challenge is undefined, a challenge with an unusable value is null, a token is echoed', () => {
  const inb = { challenge: { type: '$.type', equals: 'url_verification', echo: '$.challenge' } };
  assert.equal(challengeOf({}, { type: 'url_verification', challenge: 'abc' }), undefined, 'no block, no echo');
  assert.equal(challengeOf(inb, { type: 'event_callback', challenge: 'abc' }), undefined);
  assert.equal(challengeOf(inb, {}), undefined);
  assert.equal(challengeOf(inb, { type: 'url_verification', challenge: 'abc-DEF_1.2~3' }), 'abc-DEF_1.2~3');
  assert.equal(challengeOf(inb, { type: 'url_verification', challenge: 'x'.repeat(128) }), 'x'.repeat(128));
  for (const challenge of [undefined, '', 'x'.repeat(129), 'two words', '<script>', 'a"b', 'a\nb', 5, null, {}, ['a']]) assert.equal(challengeOf(inb, { type: 'url_verification', challenge }), null, JSON.stringify(challenge));
});

// --- an answer that is HTTP 200 and a failure --------------------------------------------------------

const RULE = { path: '$.ok', equals: false, error: '$.error', code: 400, codes: { ratelimited: 429, internal_error: 503 } };
const OP = { output: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, ts: { type: 'string' } } }, result: { ts: '$.ts' }, failure: RULE };
const answer = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('failure: ok:true is sent with its fields; ok:false is a failed delivery with the status the reason counts as', async () => {
  const sent = await mapResponse(OP, answer({ ok: true, ts: '1.2' }));
  assert.deepEqual(sent.patch, { code: 200, status: 'sent', error: null, response: '{"ok":true,"ts":"1.2"}', result: '{"ts":"1.2"}', drift: 0 });
  const bad = await mapResponse(OP, answer({ ok: false, error: 'channel_not_found' }));
  assert.deepEqual(bad, { patch: { code: 400, status: 'failed', error: 'rejected: channel_not_found', response: '{"ok":false,"error":"channel_not_found"}' }, drift: [] });
  assert.equal((await mapResponse(OP, answer({ ok: false, error: 'ratelimited' }))).patch.code, 429);
  assert.equal((await mapResponse(OP, answer({ ok: false, error: 'internal_error' }))).patch.code, 503);
  assert.equal((await mapResponse(OP, answer({ ok: false, error: 'constructor' }))).patch.code, 400, 'an inherited name is not a reason');
  assert.equal((await mapResponse(OP, answer({ ok: false }))).patch.error, 'rejected: no reason given');
  assert.equal((await mapResponse(OP, answer({ ok: false, error: 5 }))).patch.error, 'rejected: no reason given');
  assert.equal((await mapResponse({ ...OP, failure: { path: '$.ok', equals: false } }, answer({ ok: false, error: 'ratelimited' }))).patch.code, 400, 'no codes: the default');
  assert.equal((await mapResponse({ ...OP, failure: { path: '$.ok', equals: false, code: 502 } }, answer({ ok: false }))).patch.code, 502);
  assert.equal((await mapResponse({ ...OP, failure: { path: '$.s', equals: 'bad' } }, answer({ s: 'bad' }))).patch.status, 'failed', 'any scalar can be the flag');
  assert.equal((await mapResponse({ ...OP, failure: { path: '$.s', equals: 'bad' } }, answer({ s: 'good' }))).patch.status, 'sent');
});

test('failure: the reason is cut and cleaned before it is stored; an answer that is not JSON cannot be told from a success, so it fails', async () => {
  const long = await mapResponse(OP, answer({ ok: false, error: `${'a'.repeat(150)}` }));
  assert.equal(long.patch.error, `rejected: ${'a'.repeat(100)}`);
  const dirty = await mapResponse(OP, answer({ ok: false, error: 'a<b>\n"c"; d=e' }));
  assert.equal(dirty.patch.error, 'rejected: a_b___c__ d_e');
  const html = await mapResponse(OP, answer('<html>maintenance</html>'));
  assert.deepEqual(html.patch, { code: 502, status: 'failed', error: 'rejected: the answer is not JSON, so whether it succeeded cannot be told', response: '<html>maintenance</html>' });
  assert.deepEqual(html.drift, []);
  const nul = await mapResponse(OP, answer('null'));
  assert.equal(nul.patch.status, 'sent', 'JSON that holds no flag is not a failure');
});

test('failure: without the rule an ok:false body is still a success; an HTTP error is read as before and its body is not looked at', async () => {
  const { failure, ...plain } = OP;
  assert.equal((await mapResponse(plain, answer({ ok: false, error: 'x' }))).patch.status, 'sent');
  const http = await mapResponse(OP, answer({ ok: false, error: 'ratelimited' }, 429, { 'retry-after': '30' }));
  assert.deepEqual(http.patch, { code: 429, status: 'failed', error: 'HTTP 429', retryAfter: '30' });
  const noOutput = await mapResponse({ failure: RULE }, answer({ ok: false, error: 'x' }));
  assert.equal(noOutput.patch.status, 'failed', 'a rule needs no output schema');
  assert.equal((await mapResponse({ failure: RULE }, answer({ ok: true }))).patch.status, 'sent');
});

test('failure: the retry policy sees an ordinary failure — a transient reason is retried when the operation is idempotent, a permanent one never, and the breaker counts the transient', async () => {
  const run = async (reason, idempotent) => {
    const { patch } = await mapResponse(OP, answer({ ok: false, error: reason }));
    return settle({ attempts: 0 }, patch, null, { policy: { idempotent }, now: 1000, idemKey: 'k' });
  };
  const transient = await run('internal_error', true);
  assert.equal(transient.patch.status, 'queued');
  assert.ok(transient.patch.nextAttemptAt > 1000);
  assert.equal(transient.event, 'failure');
  const limited = await run('ratelimited', true);
  assert.equal(limited.patch.status, 'queued');
  const permanent = await run('channel_not_found', true);
  assert.equal(permanent.patch.status, 'failed');
  assert.equal(permanent.patch.nextAttemptAt, null);
  assert.equal(permanent.event, 'success', 'a refusal is a sign of life: it does not open the breaker');
  const notIdem = await run('internal_error', false);
  assert.equal(notIdem.patch.status, 'failed', 'a message is not posted twice: no automatic retry of a non-idempotent operation');
  assert.equal(notIdem.event, 'failure', 'but the provider is down, and the breaker knows');
});

test('deliverRow: a failure rule works through a sandbox answer and through a live one alike', async () => {
  const d = {
    descriptor: 1, name: 'chat', modes: ['sandbox', 'live'], base: 'https://chat.test',
    operations: { say: { ...OP, idempotent: false, input: { type: 'object', properties: { channel: { type: 'string' } } }, request: { url: '{base}/say', body: { channel: { $: 'input.channel' } } } } },
    sandbox: { operations: { say: [{ when: { 'input.channel': 'nowhere' }, body: { ok: false, error: 'channel_not_found' } }, { body: { ok: true, ts: '1.2' } }] } },
  };
  const row = (channel) => ({ id: 1, connector: 'c', op: 'say', payload: { channel } });
  assert.equal((await deliverRow(d, row('nowhere'), {}, { mode: 'sandbox', idemKey: 'k' })).error, 'rejected: channel_not_found');
  assert.equal((await deliverRow(d, row('here'), {}, { mode: 'sandbox', idemKey: 'k' })).status, 'sent');
  const live = await deliverRow(d, row('x'), {}, { mode: 'live', fetchImpl: async () => answer({ ok: false, error: 'invalid_auth' }) });
  assert.deepEqual([live.status, live.code], ['failed', 400]);
});
