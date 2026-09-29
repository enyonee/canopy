// Sandbox and live: the sandbox engine, what a delivery does in each mode, the secrets it reads, the masking of
// them, and the command line that switches a connector (secrets from stdin, live only with --confirm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { sandboxAnswer, checkSandbox } from '../runtime/connectors/sandbox.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { secretSlots, secretName } from '../runtime/connectors/engine.mjs';
import { createRegistry, registerDescriptor, register } from '../runtime/registry.mjs';
import { openSecrets } from '../runtime/secrets.mjs';
import { connectorEnv } from '../runtime/deploy.mjs';
import { Store } from '../runtime/store.mjs';
import { flush, deliver } from '../runtime/outbox.mjs';
import { serve } from '../runtime/server.mjs';
import { main } from '../runtime/cli.mjs';
import { fakeClock, boot, tmpDir, tmpGraph, rows } from './helpers.mjs';

const KEY = 'sk_live_TOPSECRET-1234';
const PREV = 'sk_live_OLDSECRET-5678';
const SBX = {
  descriptor: 1, name: 'sbx', modes: ['sandbox', 'live'], timeoutMs: 2000, idempotency: { header: 'Idempotency-Key' },
  retry: { max: 3, baseMs: 1000, capMs: 1000, jitter: 0 }, breaker: { threshold: 1, cooldownMs: 1000, maxCooldownMs: 1000 },
  config: { type: 'object', properties: { host: { type: 'string' } } },
  operations: {
    charge: {
      idempotent: true,
      input: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' }, ref: { type: 'string' } } },
      request: { method: 'POST', url: '{config.host}/charge', headers: { authorization: 'Bearer {secret.apiKey}' }, body: { $: 'input' } },
      output: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, status: { type: 'string' } } },
      result: { id: '$.id' },
    },
    ping: { idempotent: true, input: { type: 'object', properties: {} }, request: { method: 'GET', url: '{config.host}/ping' } },
  },
  sandbox: { operations: {
    charge: [
      { when: { 'input.amount': { gt: 1000 } }, status: 402, body: { error: 'too_large' } },
      { when: { 'input.ref': 'flaky' }, status: 503 },
      { status: 200, body: { id: 'sbx_{key}', status: 'ok', ref: { $: 'input.ref' } } },
    ],
    ping: [{ body: { pong: true } }],
  } },
};
const graph = { app: 'modes', data: { A: { n: 'text' } }, connectors: { p: { kind: 'sbx', host: 'https://api.test', secrets: { apiKey: 'stripe_key' } }, web: { kind: 'http', url: 'https://h.test' }, letters: { kind: 'mail' } } };
const registryOf = (d = SBX) => registerDescriptor(createRegistry(), structuredClone(d), 'sbx.json');
const answer = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const netOf = (respond) => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); } }; };
const world = (t, { deploy, secrets = { stripe_key: KEY }, d = SBX } = {}) => {
  const dir = tmpDir('ag-mode-', t);
  if (deploy) fs.writeFileSync(path.join(dir, 'deploy.json'), JSON.stringify({ connectors: deploy }));
  const store = openSecrets({ dir, app: 'modes', env: {} });
  for (const [k, v] of Object.entries(secrets)) store.set(k, v);
  const env = connectorEnv(dir, 'modes', {});
  return { dir, env, registry: registryOf(d), store: new Store(graph, ':memory:'), clock: fakeClock(), trace: [] };
};
const queue = (w, payload = { amount: 5 }, op = 'charge', connector = 'p', kind = 'sbx') => w.store.enqueue({ kind, connector, target: 'https://api.test/charge', payload, op });
const run = (w, net) => flush(w.store, graph, { registry: w.registry, clock: w.clock, env: w.env, fetchImpl: net.fetchImpl, trace: (e) => w.trace.push(e) });

// --- the sandbox engine ---------------------------------------------------------------------

test('sandbox: the first rule whose "when" holds answers; the body is a template over input, config and {key}', () => {
  const rules = SBX.sandbox.operations.charge;
  const at = (input) => sandboxAnswer(rules, { input, key: 'K1', config: {} });
  assert.deepEqual(at({ amount: 2000 }), { status: 402, headers: {}, body: { error: 'too_large' } });
  assert.deepEqual(at({ amount: 5, ref: 'flaky' }), { status: 503, headers: {}, body: {} });
  assert.deepEqual(at({ amount: 5, ref: 'r1' }), { status: 200, headers: {}, body: { id: 'sbx_K1', status: 'ok', ref: 'r1' } });
  assert.equal(sandboxAnswer([{ when: { 'input.a': 1 } }], { input: {}, key: 'k', config: {} }), null, 'no rule matches: no answer');
  assert.equal(sandboxAnswer(undefined, { input: {}, key: 'k', config: {} }), null);
  const cfg = sandboxAnswer([{ headers: { 'Retry-After': '3' }, body: { host: '{config.host}' } }], { input: {}, key: 'k', config: { host: 'h' } });
  assert.deepEqual(cfg, { status: 200, headers: { 'Retry-After': '3' }, body: { host: 'h' } });
});

test('sandbox: every comparison, on nested input, and a value written bare means "equal"', () => {
  const ok = (when, input) => sandboxAnswer([{ when, status: 201 }], { input, key: 'k', config: {} })?.status === 201;
  assert.equal(ok({ 'input.a': 1 }, { a: 1 }), true);
  assert.equal(ok({ 'input.a': 1 }, { a: 2 }), false);
  assert.equal(ok({ 'input.o': { x: 1 } }, { o: { x: 1 } }), false, 'an object is a set of comparisons, not a value: {x:1} names no comparison');
  assert.equal(ok({ 'input.a.b': { eq: 'x' } }, { a: { b: 'x' } }), true);
  assert.equal(ok({ 'input.a.b': { eq: 'x' } }, { a: 'x' }), false);
  assert.equal(ok({ 'input.a': { ne: 1 } }, { a: 2 }), true);
  assert.equal(ok({ 'input.a': { gt: 1 } }, { a: 1 }), false);
  assert.equal(ok({ 'input.a': { gte: 1 } }, { a: 1 }), true);
  assert.equal(ok({ 'input.a': { lt: 2 } }, { a: 1 }), true);
  assert.equal(ok({ 'input.a': { lte: 1, gt: 0 } }, { a: 1 }), true, 'every comparison of a key must hold');
  assert.equal(ok({ 'input.a': { lt: 2 } }, { a: '1' }), false, 'a comparison of order needs a number');
  assert.equal(ok({ 'input.a': { in: [1, 2] } }, { a: 2 }), true);
  assert.equal(ok({ 'input.a': { in: [1, 2] } }, { a: 3 }), false);
  assert.equal(ok({ 'input.a': { in: 'x' } }, { a: 3 }), false);
  assert.equal(ok({ 'input.a': { present: true } }, { a: 0 }), true);
  assert.equal(ok({ 'input.a': { present: true } }, {}), false);
  assert.equal(ok({ 'input.a': { present: false } }, { a: null }), true);
  assert.equal(ok({ 'input.a': 1, 'input.b': 2 }, { a: 1, b: 3 }), false, 'all keys must hold');
});

const sb = (rules, extra = {}) => ({ ...SBX, sandbox: { operations: { charge: rules, ping: [{}] } }, ...extra });
const said = (d) => checkDescriptor(d).map(([p, m]) => `${p}: ${m}`);

test('sandbox: the descriptor checker fails closed on every part of a rule', () => {
  assert.deepEqual(said(SBX), []);
  assert.deepEqual(said(sb([{}])), []);
  assert.match(said(sb([1]))[0], /\/sandbox\/operations\/charge\/0: a sandbox rule is an object/);
  assert.match(said(sb([{ what: 1 }]))[0], /charge\/0\/what: unknown key "what"/);
  assert.match(said(sb([{ status: 99 }]))[0], /charge\/0\/status: "status" is an HTTP status/);
  assert.match(said(sb([{ status: '200' }]))[0], /"status" is an HTTP status/);
  assert.match(said(sb([{ headers: { a: 1 } }]))[0], /"headers" maps a name to a string/);
  assert.match(said(sb([{ headers: [] }]))[0], /"headers" maps a name to a string/);
  assert.match(said(sb([{ when: 5 }]))[0], /"when" maps input\.<name>/);
  assert.match(said(sb([{ when: { amount: 1 } }]))[0], /charge\/0\/when\/amount: "when" keys read the input/);
  assert.match(said(sb([{ when: { 'input.nope': 1 } }]))[0], /input\.nope is not an input of this operation/);
  assert.match(said(sb([{ when: { 'input.amount': { near: 1 } } }]))[0], /unknown comparison "near"/);
  assert.match(said(sb([{ body: { a: '{input.nope}' } }]))[0], /\{input\.nope\} is not an input/);
  assert.match(said(sb([{ body: { a: '{secret.apiKey}' } }]))[0], /\{secret\} cannot be used in a sandbox answer/);
  assert.match(said(sb([{ body: { a: '{base}' } }]))[0], /\{base\} cannot be used/);
  assert.match(said(sb([{ body: { a: '{nope.x}' } }]))[0], /unknown name "nope\.x"/);
  assert.deepEqual(said(sb([{ body: { a: '{key}', b: '{config.host}', c: { $: 'input.amount' } } }])), []);
  assert.match(said(sb([]))[0], /a list of at least one rule/);
  assert.match(said(sb('x'))[0], /a list of at least one rule/);
  assert.match(said({ ...SBX, sandbox: { operations: { charge: [{}], ping: [{}], gone: [{}] } } })[0], /\/sandbox\/operations\/gone: "gone" is not an operation/);
  assert.match(said({ ...SBX, sandbox: { operations: { charge: [{}] } } })[0], /\/sandbox\/operations\/ping: a descriptor with the "sandbox" mode answers every operation/);
  for (const bad of [1, null, [], { operations: 1 }, { other: 1, operations: {} }]) assert.match(said({ ...SBX, sandbox: bad })[0], /"sandbox" is \{"operations"/, JSON.stringify(bad));
});

test('descriptor modes: a list of sandbox and/or live, each once; sandbox rules and the sandbox mode need each other', () => {
  const only = (modes) => said({ ...SBX, modes });
  assert.deepEqual(only(['sandbox', 'live']), []);
  assert.deepEqual(only(['live', 'sandbox']), []);
  for (const bad of [[], ['prod'], ['live', 'live'], 'live', {}]) assert.match(only(bad)[0], /"modes" lists "sandbox" and\/or "live"/, JSON.stringify(bad));
  const noRules = { ...SBX }; delete noRules.sandbox;
  assert.match(said(noRules)[0], /the "sandbox" mode needs a "sandbox" block/);
  assert.match(said({ ...noRules, modes: ['live'] }).join(), /^$/, 'a live-only descriptor has no sandbox');
  assert.match(said({ ...SBX, modes: ['live'] })[0], /sandbox rules need "sandbox" in "modes"/);
  assert.match(said({ ...SBX, modes: undefined })[0], /sandbox rules need "sandbox" in "modes"/, 'no "modes" means live only');
});

test('secret slots: the secrets a descriptor reads in its requests, and the store name each maps to', () => {
  assert.deepEqual(secretSlots(SBX), ['apiKey']);
  assert.deepEqual(secretSlots({ operations: { a: { request: { url: 'u', headers: { x: '{secret.k}', y: '{secret.k}' }, body: { z: '{secret.m}', w: '{input.q}' } } } } }), ['k', 'm']);
  assert.equal(secretName(graph.connectors.p, 'apiKey'), 'stripe_key', 'the connector maps the slot');
  assert.equal(secretName({ kind: 'sbx' }, 'apiKey'), 'apiKey', 'or the slot is the name');
  assert.equal(secretName(undefined, 'apiKey'), 'apiKey');
});

// --- a delivery in each mode ----------------------------------------------------------------

test('sandbox mode is the default of a descriptor that lists it first: nothing is sent, the rule answers, output and result are read', async (t) => {
  const w = world(t);
  const id = queue(w, { amount: 5, ref: 'r1' });
  const net = netOf(() => { throw new Error('the network must not be touched'); });
  assert.deepEqual(await run(w, net), ['sent']);
  assert.equal(net.calls.length, 0);
  const row = w.store.outboxGet(id);
  assert.deepEqual([row.status, row.code, row.drift], ['sent', 200, 0]);
  assert.match(row.response, /"id":"sbx_[0-9a-f]{32}"/);
  assert.deepEqual(JSON.parse(row.result), { id: JSON.parse(row.response).id });
  assert.deepEqual(w.store.breakers(), [], 'a sign of life on a closed breaker writes nothing');
  const again = queue(w, { amount: 5, ref: 'r1' });
  await run(w, net);
  assert.notEqual(JSON.parse(w.store.outboxGet(again).response).id, JSON.parse(row.response).id, 'the fake id follows the idempotency key of each row');
});

test('sandbox mode: a rule can answer with an error or a status the outbox treats like a real one; no matching rule fails the delivery for good', async (t) => {
  const w = world(t);
  const big = queue(w, { amount: 5000 });
  const flaky = queue(w, { amount: 1, ref: 'flaky' });
  const net = netOf(() => { throw new Error('no network'); });
  const [a, b] = await run(w, net);
  assert.deepEqual([a, w.store.outboxGet(big).code, w.store.outboxGet(big).error], ['failed', 402, 'HTTP 402']);
  assert.equal(b, 'queued', 'a 503 in the sandbox is retried like a real one');
  assert.equal(w.store.outboxGet(flaky).nextAttemptAt, w.clock.now() + 1000);
  assert.deepEqual(w.store.breakers().map((x) => [x.connector, x.mode, x.state]), [['p', 'sandbox', 'open']], 'and the breaker is the sandbox one');
  const w2 = world(t, { d: { ...SBX, sandbox: { operations: { charge: [{ when: { 'input.amount': 1 } }], ping: [{}] } } } });
  const id = queue(w2, { amount: 2 });
  assert.deepEqual(await run(w2, net), ['failed']);
  const row = w2.store.outboxGet(id);
  assert.match(row.error, /sbx\.charge: no sandbox rule answers this input/);
  assert.equal(row.nextAttemptAt, null);
  assert.deepEqual(w2.store.breakers(), []);
  const direct = { ...SBX, modes: ['live'] }; delete direct.sandbox;
  await assert.rejects(() => registryOf(direct).transports.sbx.deliver({ op: 'charge', payload: { amount: 1 } }, {}, { mode: 'sandbox', idemKey: 'k' }), /no sandbox rule answers/);
});

test('sandbox mode answers a Retry-After the way a provider does, and a body that is no JSON object is drift', async (t) => {
  const w = world(t, { d: { ...SBX, retry: { ...SBX.retry, capMs: 10000 }, sandbox: { operations: { charge: [{ status: 429, headers: { 'Retry-After': '4' } }], ping: [{}] } } } });
  const id = queue(w);
  await run(w, netOf(() => { throw new Error('no network'); }));
  assert.equal(w.store.outboxGet(id).nextAttemptAt, w.clock.now() + 4000);
  const w2 = world(t, { d: { ...SBX, sandbox: { operations: { charge: [{ body: { id: 5 } }], ping: [{}] } } } });
  const drifted = queue(w2);
  await run(w2, netOf(() => { throw new Error('no network'); }));
  assert.equal(w2.store.outboxGet(drifted).drift, 1);
});

test('live mode: the request is built with the secret from the store, the mapping and its rotation; the row keeps the input only', async (t) => {
  const w = world(t, { deploy: { p: 'live' }, secrets: { stripe_key: KEY, 'stripe_key.prev': PREV } });
  const id = queue(w, { amount: 7 });
  const net = netOf(() => answer(200, { id: 'ch_1' }));
  assert.deepEqual(await run(w, net), ['sent']);
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].url, 'https://api.test/charge');
  assert.equal(net.calls[0].init.headers.authorization, `Bearer ${KEY}`, 'the current value, not the previous one');
  const row = w.store.outboxGet(id);
  assert.equal(JSON.stringify(row).includes(KEY), false);
  assert.deepEqual(row.payload, { amount: 7 });
});

test('live mode: a secret that is not in the store fails the delivery for good — not retried, not a breaker failure, nothing sent', async (t) => {
  const w = world(t, { deploy: { p: 'live' }, secrets: {} });
  const id = queue(w);
  const net = netOf(() => answer(200, { id: 'x' }));
  assert.deepEqual(await run(w, net), ['failed']);
  const row = w.store.outboxGet(id);
  assert.equal(row.error, 'secret "stripe_key" is not set: put it in the secret store (--secrets set stripe_key)');
  assert.deepEqual([row.attempts, row.nextAttemptAt, net.calls.length], [1, null, 0], 'the operation is idempotent, yet it is not retried');
  assert.deepEqual(w.store.breakers(), [], 'the provider did nothing wrong');
  assert.equal(w.trace.some((e) => e.kind === 'breaker'), false);
});

test('a previous value alone never signs a request: only the current one is used, and a missing current fails the delivery', async (t) => {
  const w = world(t, { deploy: { p: 'live' }, secrets: { 'stripe_key.prev': PREV } });
  const id = queue(w);
  const net = netOf(() => answer(200, { id: 'x' }));
  assert.deepEqual(await run(w, net), ['failed']);
  assert.match(w.store.outboxGet(id).error, /secret "stripe_key" is not set/);
  assert.equal(net.calls.length, 0);
  assert.deepEqual(w.env.secrets.get('stripe_key'), [PREV], 'the list a verifier may accept still holds it');
});

test('a store that cannot be opened (wrong key) fails the delivery closed with its own message and never falls back to sandbox', async (t) => {
  const w = world(t, { deploy: { p: 'live' } });
  fs.writeFileSync(path.join(w.dir, 'secrets.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`);
  const id = queue(w);
  const net = netOf(() => answer(200, { id: 'x' }));
  assert.deepEqual(await run(w, net), ['failed']);
  assert.match(w.store.outboxGet(id).error, /secrets\.enc cannot be read: the master key is wrong/);
  assert.equal(net.calls.length, 0);
});

test('a mode the connector kind does not offer fails the delivery: http is live only, mail is sandbox only, and nothing falls back', async (t) => {
  const w = world(t, { deploy: { web: 'sandbox', letters: 'live' } });
  const a = w.store.enqueue({ kind: 'http', connector: 'web', target: 'https://h.test', payload: {} });
  const b = w.store.enqueue({ kind: 'mail', connector: 'letters', target: 'x@y', payload: {} });
  const net = netOf(() => answer(200, {}));
  assert.deepEqual(await run(w, net), ['failed', 'failed']);
  assert.equal(w.store.outboxGet(a).error, 'connector "web" cannot run in sandbox mode (it offers: live)');
  assert.equal(w.store.outboxGet(b).error, 'connector "letters" cannot run in live mode (it offers: sandbox)');
  assert.equal(net.calls.length, 0);
  assert.deepEqual(w.store.breakers(), []);
});

test('with no deploy file every kind runs as it always did: http live, mail recorded (sandbox), a plain descriptor live', async (t) => {
  const w = world(t, { d: { ...SBX, modes: undefined, sandbox: undefined } });
  const web = w.store.enqueue({ kind: 'http', connector: 'web', target: 'https://h.test/x', payload: { a: 1 } });
  const letter = w.store.enqueue({ kind: 'mail', connector: 'letters', target: 'x@y', payload: {} });
  const charge = queue(w);
  const net = netOf(() => answer(200, { id: 'x' }));
  assert.deepEqual(await run(w, net), ['sent', 'sent', 'sent']);
  assert.deepEqual(net.calls.map((c) => c.url), ['https://h.test/x', 'https://api.test/charge']);
  assert.deepEqual([web, letter, charge].map((id) => w.store.outboxGet(id).status), ['sent', 'sent', 'sent']);
  await flush(w.store, graph, { registry: w.registry, clock: w.clock, fetchImpl: net.fetchImpl });
  assert.equal(net.calls.length, 2, 'flush works with no environment at all');
});

test('the breaker is kept per connector and mode: the real mode of the delivery is the key', async (t) => {
  const w = world(t, { deploy: { p: 'live' } });
  queue(w);
  await run(w, netOf(() => answer(503, {})));
  assert.deepEqual(w.store.breakers().map((b) => [b.connector, b.mode, b.state]), [['p', 'live', 'open']]);
  fs.writeFileSync(path.join(w.dir, 'deploy.json'), JSON.stringify({ connectors: { p: 'sandbox' } }));
  const id = queue(w);
  assert.deepEqual(await run(w, netOf(() => answer(500, {}))), ['sent'], 'sandbox is not held back by the open live breaker');
  assert.equal(w.store.outboxGet(id).status, 'sent');
});

// --- secrets never leave ----------------------------------------------------------------------

const scan = (needle, ...haystacks) => haystacks.map((h) => (typeof h === 'string' ? h : JSON.stringify(h))).filter((h) => h.includes(needle));

test('redaction: neither the current nor the previous secret is in the outbox, the trace or an error, whatever the provider echoes', async (t) => {
  const w = world(t, { deploy: { p: 'live' }, secrets: { stripe_key: KEY, 'stripe_key.prev': PREV } });
  const echo = (_url, init) => answer(200, { id: `echo ${init.headers.authorization} ${PREV}`, status: encodeURIComponent(KEY) });
  const ok = queue(w, { amount: 1 });
  await run(w, netOf(echo));
  const bad = queue(w, { amount: 2 });
  await run(w, netOf(() => answer(200, `not json, but here is ${KEY}`)));
  const boom = queue(w, { amount: 3 });
  await run(w, netOf((_url, init) => { throw new TypeError(`fetch failed for ${init.headers.authorization}`); }));
  const rows = [ok, bad, boom].map((id) => w.store.outboxGet(id));
  for (const secret of [KEY, PREV]) assert.deepEqual(scan(secret, rows, w.trace, w.store.outbox()), [], `${secret.slice(0, 12)} leaked`);
  assert.match(rows[0].response, /echo Bearer «secret» «secret»/);
  assert.match(rows[1].response, /here is «secret»/);
  assert.match(rows[2].error, /fetch failed for Bearer «secret»/);
  assert.equal(rows[2].status, 'queued', 'the request was sent and its answer never came: an idempotent operation goes again');
});

test('redaction: a plugin transport that traces or throws a secret it read is masked in the trace lines and the row', async (t) => {
  const w = world(t, { secrets: { stripe_key: KEY } });
  const registry = register(createRegistry(), { transports: { leaky: {
    summary: 'leaks', validate: () => [],
    deliver: async (_row, _c, opts) => { const [v] = opts.secrets.get('stripe_key'); opts.trace({ kind: 'note', nested: [{ v }] }); throw new Error(`bad ${v}`); },
  } } }, 'leaky.mjs');
  const id = w.store.enqueue({ kind: 'leaky', connector: 'p', target: 't', payload: {} });
  await flush(w.store, graph, { registry, clock: w.clock, env: w.env, trace: (e) => w.trace.push(e) });
  assert.deepEqual(scan(KEY, w.trace, w.store.outboxGet(id)), []);
  assert.deepEqual(w.trace.find((e) => e.kind === 'note'), { kind: 'note', nested: [{ v: '«secret»' }] });
  assert.equal(w.store.outboxGet(id).error, 'bad «secret»');
  const direct = w.store.enqueue({ kind: 'leaky', connector: 'p', target: 't', payload: {} });
  assert.equal(await deliver(w.store, graph, w.store.outboxGet(direct), { registry, clock: w.clock, secrets: w.env.secrets }), 'failed');
  assert.equal(w.store.outboxGet(direct).error, 'bad «secret»', 'deliver called on its own masks too');
});

test('redaction, end to end: after deliveries with secrets nothing on the server — outbox screen, trace file, database — holds one', async () => {
  const dir = tmpDir('ag-red-');
  fs.writeFileSync(path.join(dir, 'sbx.json'), JSON.stringify(SBX));
  const g = { app: 'modes', plugins: [path.join(dir, 'sbx.json')], data: { Order: { ref: 'text' } },
    connectors: { p: { kind: 'sbx', host: 'https://api.test', secrets: { apiKey: 'stripe_key' } } },
    actions: [{ name: 'charge', in: 'Order', confirm: 'ok', do: [{ block: 'connector.call', connector: 'p', op: 'charge', input: { amount: 5, ref: '@row.ref' } }] }] };
  const net = netOf((_url, init) => answer(200, { id: `seen ${init.headers.authorization}` }));
  const s = await boot(tmpGraph(g), { fetchImpl: net.fetchImpl });
  try {
    openSecrets({ dir: s.dir, app: 'modes', env: {} }).set('stripe_key', KEY);
    fs.writeFileSync(path.join(s.dir, 'deploy.json'), JSON.stringify({ connectors: { p: 'live' } }));
    const order = s.app.store.insert('Order', { ref: 'R-1' });
    await s.post(`/Order/${order}/action/charge`, {});
    assert.equal(net.calls.length, 1);
    assert.equal(net.calls[0].init.headers.authorization, `Bearer ${KEY}`);
    const page = await s.get('/outbox');
    assert.equal(page.status, 200);
    assert.match(s.app.store.outbox()[0].response, /seen Bearer «secret»/);
    const files = fs.readdirSync(s.dir).filter((f) => f !== 'secrets.enc' && f !== 'secrets.key').map((f) => fs.readFileSync(path.join(s.dir, f)).toString('latin1'));
    assert.deepEqual(scan(KEY, page.html, s.trace(), s.app.store.outbox(), files), []);
    const failedNow = (await s.get('/outbox')).html;
    assert.match(failedNow, /Connector modes/);
    assert.match(failedNow, /<li><b>p<\/b> \(sbx\): <span class="status">live<\/span> <span class="muted">offers sandbox, live<\/span><\/li>/);
    assert.equal(rows(failedNow).length, s.app.store.outbox().length, 'the modes are not rows of the outbox table');
  } finally { s.close(); }
});

// --- /outbox, the server and the deploy file -------------------------------------------------

test('/outbox shows each connector with its mode and the modes it offers; no connectors, no table', async () => {
  const dir = tmpDir('ag-red-');
  fs.writeFileSync(path.join(dir, 'sbx.json'), JSON.stringify(SBX));
  const s = await boot(tmpGraph({ app: 'modes', plugins: [path.join(dir, 'sbx.json')], data: { A: { n: 'text' } }, connectors: { p: { kind: 'sbx', host: 'https://x.test' }, web: { kind: 'http', url: 'https://h.test' }, letters: { kind: 'mail' } } }));
  try {
    const cell = (html, name) => new RegExp(`<li><b>${name}</b> \\((\\w+)\\): <span class="status">(\\w+)</span> <span class="muted">offers ([^<]*)</span></li>`).exec(html).slice(1);
    let html = (await s.get('/outbox')).html;
    assert.deepEqual([cell(html, 'p'), cell(html, 'web'), cell(html, 'letters')], [['sbx', 'sandbox', 'sandbox, live'], ['http', 'live', 'live'], ['mail', 'sandbox', 'sandbox']]);
    fs.writeFileSync(path.join(s.dir, 'deploy.json'), JSON.stringify({ connectors: { p: 'live' } }));
    html = (await s.get('/outbox')).html;
    assert.equal(cell(html, 'p')[1], 'live', 'the file is read on every request: no restart');
  } finally { s.close(); }
  const none = await boot(tmpGraph({ app: 'none', data: { A: { n: 'text' } } }));
  try { assert.equal((await none.get('/outbox')).html.includes('Connector modes'), false); } finally { none.close(); }
});

test('a deploy file that is broken makes the app invalid at boot, and says so; it never runs in a guessed mode', async (t) => {
  const dir = tmpDir('ag-dep-', t);
  fs.writeFileSync(path.join(dir, 'deploy.json'), '{"connectors": {"p": "prod"}}');
  const file = tmpGraph({ app: 'x', data: { A: { n: 'text' } } });
  const app = serve({ graphFile: file, dbFile: path.join(dir, 'data.sqlite'), traceFile: path.join(dir, 't.jsonl'), port: 0, noTimers: true });
  await once(app.server, 'listening');
  try {
    assert.equal(app.invalid, true);
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/`);
    assert.equal(r.status, 500);
    assert.match(await r.text(), /\/deploy\.json: deploy\.json is \{&quot;connectors&quot;|deploy\.json is \{"connectors"/);
  } finally { app.server.closeAllConnections(); app.server.close(); }
});

test('a connector\'s "secrets" is a map of slots to store names: anything else is a checker error', () => {
  const reg = registryOf();
  const check = (c) => reg.transports.sbx.validate({ kind: 'sbx', ...c }).map(([p, m]) => `${p}: ${m}`);
  assert.deepEqual(check({ secrets: { apiKey: 'stripe_key' } }), []);
  assert.deepEqual(check({}), []);
  assert.match(check({ secrets: 'x' })[0], /^secrets: "secrets" maps a slot/);
  assert.match(check({ secrets: null })[0], /^secrets: "secrets" maps a slot/);
  assert.match(check({ secrets: [] })[0], /^secrets: "secrets" maps a slot/);
  assert.match(check({ secrets: { apiKey: 'sk live' } })[0], /^secrets\/apiKey: a secret is named/);
  assert.match(check({ secrets: { apiKey: 5 } })[0], /^secrets\/apiKey: a secret is named/);
  assert.deepEqual(check({ host: 'https://a' }), [], '"secrets" is not part of the descriptor\'s own "config"');
});

// --- the command line -------------------------------------------------------------------------

const dirWith = (t, g = graph, plugins = true) => {
  const dir = tmpDir('ag-cli-', t);
  fs.writeFileSync(path.join(dir, 'sbx.json'), JSON.stringify(SBX));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ ...g, ...(plugins ? { plugins: ['./sbx.json'] } : {}) }));
  return dir;
};
const cli = async (dir, args, stdin = '') => {
  const out = [], errs = [];
  const { code } = await main([path.join(dir, 'app.json'), ...args], { log: (m) => out.push(String(m)), err: (m) => errs.push(String(m)), stdin: async () => stdin });
  return { code, out: out.join('\n'), err: errs.join('\n'), all: [...out, ...errs].join('\n') };
};
const vault = (dir) => openSecrets({ dir, app: 'modes', env: {} });
const deployOf = (dir) => (fs.existsSync(path.join(dir, 'deploy.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'deploy.json'), 'utf8')).connectors : null);

test('--secrets set reads the value from stdin (one trailing newline dropped); the value is never printed and never taken from an argument', async (t) => {
  const dir = dirWith(t);
  const set = await cli(dir, ['--secrets', 'set', 'stripe_key'], `${KEY}\n`);
  assert.deepEqual([set.code, set.out], [0, 'set stripe_key']);
  assert.deepEqual(vault(dir).get('stripe_key'), [KEY]);
  assert.equal(fs.statSync(path.join(dir, 'secrets.key')).mode & 0o777, 0o600, 'the first set made the key file');
  await cli(dir, ['--secrets', 'set', 'crlf'], 'v\r\n');
  await cli(dir, ['--secrets', 'set', 'keep'], 'a\nb\n\n');
  assert.deepEqual([vault(dir).get('crlf'), vault(dir).get('keep')], [['v'], ['a\nb\n']]);
  const argv = await cli(dir, ['--secrets', 'set', 'other', 'THE-VALUE'], 'ignored');
  assert.equal(argv.code, 1);
  assert.match(argv.err, /read from stdin, never from the command line/);
  assert.equal(argv.all.includes('THE-VALUE'), false);
  assert.equal(vault(dir).get('other').length, 0, 'nothing was stored');
  assert.equal(set.all.includes(KEY), false);
  const empty = await cli(dir, ['--secrets', 'set', 'e'], '\n');
  assert.deepEqual([empty.code, empty.err], [1, 'a secret cannot be empty']);
  assert.match((await cli(dir, ['--secrets', 'set', 'bad name'], 'v')).err, /cannot be a secret name/);
  assert.match((await cli(dir, ['--secrets', 'set'], 'v')).err, /--secrets set needs a NAME/);
});

test('--secrets list prints names only; rm removes one; an unknown subcommand prints the usage', async (t) => {
  const dir = dirWith(t);
  assert.equal((await cli(dir, ['--secrets', 'list'])).out, '(no secrets)');
  await cli(dir, ['--secrets', 'set', 'b'], 'VALUE-B');
  await cli(dir, ['--secrets', 'set', 'a'], 'VALUE-A');
  const list = await cli(dir, ['--secrets', 'list']);
  assert.deepEqual([list.code, list.out], [0, 'a\nb']);
  assert.equal(list.all.includes('VALUE'), false);
  assert.deepEqual(await cli(dir, ['--secrets', 'rm', 'a']).then((r) => [r.code, r.out]), [0, 'removed a']);
  assert.deepEqual(await cli(dir, ['--secrets', 'rm', 'a']).then((r) => [r.code, r.err]), [1, 'no secret "a"']);
  assert.match((await cli(dir, ['--secrets', 'rm'])).err, /needs a NAME/);
  assert.match((await cli(dir, ['--secrets', 'show', 'b'])).err, /usage: --secrets set NAME \| list \| rm NAME/);
  assert.match((await cli(dir, ['--secrets'])).err, /usage: --secrets/);
  assert.match((await cli(dir, ['--connectors'])).err, /usage: --connectors status/);
  assert.match((await cli(dir, ['--connectors', 'dance'])).err, /usage: --connectors/);
});

test('--connectors live: refused without --confirm, refused while a secret the live requests read is missing, then it switches; sandbox switches back', async (t) => {
  const dir = dirWith(t);
  const noConfirm = await cli(dir, ['--connectors', 'live', 'p']);
  assert.equal(noConfirm.code, 1);
  assert.match(noConfirm.err, /switching "p" to live sends real requests: repeat with --confirm/);
  assert.equal(deployOf(dir), null, 'nothing was written');
  const missing = await cli(dir, ['--connectors', 'live', 'p', '--confirm']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /"p" stays as it is: its live requests need "stripe_key" in the secret store/);
  assert.equal(deployOf(dir), null);
  await cli(dir, ['--secrets', 'set', 'stripe_key'], KEY);
  const noConfirm2 = await cli(dir, ['--connectors', 'live', 'p']);
  assert.equal(noConfirm2.code, 1, 'the secret is there, the confirmation is still needed');
  assert.equal(deployOf(dir), null);
  const live = await cli(dir, ['--connectors', 'live', '--confirm', 'p', '--port', '8']);
  assert.deepEqual([live.code, live.out], [0, 'p: live'], '--confirm may stand before the name, and options after it are not part of it');
  assert.deepEqual(deployOf(dir), { p: 'live' });
  const back = await cli(dir, ['--connectors', 'sandbox', 'p']);
  assert.deepEqual([back.code, back.out, deployOf(dir)], [0, 'p: sandbox', { p: 'sandbox' }], 'sandbox needs no confirmation');
});

test('--connectors live counts the secrets by their store names, and an .prev alone does not stand in for the current one', async (t) => {
  const dir = dirWith(t);
  await cli(dir, ['--secrets', 'set', 'apiKey'], 'wrong name: the connector maps the slot to stripe_key');
  await cli(dir, ['--secrets', 'set', 'stripe_key.prev'], PREV);
  const r = await cli(dir, ['--connectors', 'live', 'p', '--confirm']);
  assert.match(r.err, /need "stripe_key"/);
  await cli(dir, ['--secrets', 'set', 'stripe_key'], KEY);
  assert.equal((await cli(dir, ['--connectors', 'live', 'p', '--confirm'])).code, 0);
});

test('--connectors refuses what does not exist or is not offered: an unknown connector, a missing name, live for mail, sandbox for http', async (t) => {
  const dir = dirWith(t);
  assert.match((await cli(dir, ['--connectors', 'live', 'zzz', '--confirm'])).err, /no connector "zzz" in this graph \(connectors: p, web, letters\)/);
  assert.match((await cli(dir, ['--connectors', 'live', '--confirm'])).err, /--connectors live needs a connector NAME/);
  assert.match((await cli(dir, ['--connectors', 'live', 'letters', '--confirm'])).err, /"letters" \(mail\) cannot run in live mode: it offers sandbox/);
  assert.match((await cli(dir, ['--connectors', 'sandbox', 'web'])).err, /"web" \(http\) cannot run in sandbox mode: it offers live/);
  assert.equal(deployOf(dir), null);
  const bare = dirWith(t, { app: 'b', data: { A: { n: 'text' } } });
  assert.match((await cli(bare, ['--connectors', 'sandbox', 'p'])).err, /no connector "p" in this graph \(connectors: none\)/);
  assert.equal((await cli(bare, ['--connectors', 'status'])).out, 'no connectors in this graph');
});

test('--connectors status lists each connector with its mode now and its secrets as set or MISSING — never a value; no deploy file is the defaults', async (t) => {
  const dir = dirWith(t);
  const first = await cli(dir, ['--connectors', 'status']);
  assert.deepEqual(first.out.split('\n'), [
    'p  sbx  sandbox  (offers: sandbox, live)  secrets: stripe_key MISSING',
    'web  http  live  (offers: live)',
    'letters  mail  sandbox  (offers: sandbox)',
  ]);
  await cli(dir, ['--secrets', 'set', 'stripe_key'], KEY);
  await cli(dir, ['--connectors', 'live', 'p', '--confirm']);
  const second = await cli(dir, ['--connectors', 'status']);
  assert.equal(second.out.split('\n')[0], 'p  sbx  live  (offers: sandbox, live)  secrets: stripe_key set');
  assert.equal(second.all.includes(KEY), false);
});

test('a wrong master key stops every command that needs the store, with the store\'s message and no change', async (t) => {
  const dir = dirWith(t);
  await cli(dir, ['--secrets', 'set', 'stripe_key'], KEY);
  fs.writeFileSync(path.join(dir, 'secrets.key'), `${Buffer.alloc(32, 9).toString('base64')}\n`);
  for (const args of [['--secrets', 'list'], ['--secrets', 'set', 'x'], ['--connectors', 'status'], ['--connectors', 'live', 'p', '--confirm']]) {
    const r = await cli(dir, args, 'v');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /master key is wrong or the file was changed/);
  }
  assert.equal(deployOf(dir), null);
  assert.deepEqual(scan(KEY, fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8')), []);
});
