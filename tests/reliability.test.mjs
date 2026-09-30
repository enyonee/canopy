// Retries, `unknown`, timeouts, the circuit breaker, the background flusher: the delivery path with a
// fake clock (tests/helpers.mjs fakeClock) and a scripted network. Time moves only when a test says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { open } from '../runtime/driver.mjs';
import { createRegistry, registerDescriptor } from '../runtime/registry.mjs';
import { checkDescriptor } from '../runtime/connectors/descriptor.mjs';
import { deliverRow, buildRequest, mapResponse } from '../runtime/connectors/engine.mjs';
import { idemKeyOf } from '../runtime/connectors/backoff.mjs';
import { flush, deliver, LEASE_MS } from '../runtime/outbox.mjs';
import { startFlusher } from '../runtime/server.mjs';
import { outboxView } from '../runtime/render/pages.mjs';
import { fakeClock, boot, tmpGraph, tmpDir, rows } from './helpers.mjs';

const IN = { type: 'object', properties: {} };
const D = {
  descriptor: 1, name: 'pay', timeoutMs: 2000, idempotency: { header: 'Idempotency-Key' },
  retry: { max: 4, baseMs: 1000, capMs: 8000, jitter: 0 },
  breaker: { threshold: 50, cooldownMs: 10000, maxCooldownMs: 40000 },
  operations: {
    get: { idempotent: true, input: IN, request: { method: 'GET', url: 'https://api.test/x' } },
    charge: { idempotent: false, input: IN, request: { method: 'POST', url: 'https://api.test/x', body: { $: 'input' } } },
  },
};
const graph = { app: 'r', data: { A: { n: 'text' } }, connectors: { p: { kind: 'pay' } } };
const make = (desc = {}, g = graph) => ({
  store: new Store(g, ':memory:'), graph: g, clock: fakeClock(),
  registry: registerDescriptor(createRegistry(), { ...structuredClone(D), ...desc }, 'pay.json'),
});
const queue = (store, op = 'get') => store.enqueue({ kind: 'pay', connector: 'p', target: 'https://api.test/x', payload: {}, op });
const answer = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => '' });
const scripted = (steps) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = typeof steps === 'function' ? steps(calls.length) : steps[Math.min(calls.length, steps.length) - 1];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
};
const hang = (calls = []) => (url, init) => new Promise((_, reject) => { calls.push(url); init.signal.addEventListener('abort', () => reject(init.signal.reason)); });
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
const opts = (t, extra = {}) => ({ registry: t.registry, clock: t.clock, ...extra });

test('a retryable failure goes back to queued with a growing wait, until max attempts', async () => {
  const t = make();
  const id = queue(t.store);
  const net = scripted([answer(503)]);
  const t0 = t.clock.now();
  const at = [];
  for (const wait of [1000, 2000, 4000]) {
    assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl })), ['queued']);
    const row = t.store.outboxGet(id);
    assert.deepEqual([row.status, row.code, row.error], ['queued', 503, 'HTTP 503']);
    at.push(row.nextAttemptAt - t.clock.now());
    assert.equal(row.nextAttemptAt, t.clock.now() + wait);
    await t.clock.advance(wait - 1);
    assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl })), [], 'not before its time');
    await t.clock.advance(1);
  }
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl })), ['failed']);
  const row = t.store.outboxGet(id);
  assert.deepEqual([row.status, row.attempts, row.error, row.nextAttemptAt], ['failed', 4, 'HTTP 503 (gave up after 4 attempts)', null]);
  assert.equal(net.calls.length, 4);
  await t.clock.advance(10 * 3600 * 1000);
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl })), []);
  assert.equal(t.clock.now() > t0, true);
  assert.deepEqual(at, [1000, 2000, 4000]);
});

test('the wait is capped, and Retry-After raises it (in seconds or as a date) up to the cap', async () => {
  const t = make({ retry: { max: 9, baseMs: 1000, capMs: 6000, jitter: 0 } });
  const id = queue(t.store);
  const net = scripted([answer(503), answer(503), answer(503), answer(503), answer(503)]);
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl }));
    seen.push(t.store.outboxGet(id).nextAttemptAt - t.clock.now());
    await t.clock.advance(seen[i]);
  }
  assert.deepEqual(seen, [1000, 2000, 4000, 6000, 6000], 'doubles, then stops at the cap');

  const r = make({ retry: { max: 9, baseMs: 1000, capMs: 60000, jitter: 0 } });
  const ids = [queue(r.store), queue(r.store), queue(r.store)];
  const date = new Date(r.clock.now() + 9000).toUTCString();
  const replies = [answer(429, { 'retry-after': '5' }), answer(503, { 'retry-after': date }), answer(503, { 'retry-after': '3600' })];
  await flush(r.store, r.graph, opts(r, { fetchImpl: scripted((n) => replies[n - 1]).fetchImpl }));
  assert.deepEqual(ids.map((i) => r.store.outboxGet(i).nextAttemptAt - r.clock.now()), [5000, 9000, 60000]);
});

test('4xx other than 429 is final, does not retry and never trips the breaker', async () => {
  const t = make({ breaker: { threshold: 2, cooldownMs: 10000, maxCooldownMs: 40000 } });
  const ids = Array.from({ length: 5 }, () => queue(t.store));
  const net = scripted([answer(404)]);
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl })), ['failed', 'failed', 'failed', 'failed', 'failed']);
  assert.equal(net.calls.length, 5, 'once each');
  assert.deepEqual(ids.map((i) => [t.store.outboxGet(i).attempts, t.store.outboxGet(i).nextAttemptAt]), ids.map(() => [1, null]));
  assert.deepEqual(t.store.breakerGet('p', 'live').state, 'closed');
  assert.equal(t.store.breakerGet('p', 'live').failures, 0);
  const n = queue(t.store);
  await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([answer(429)]).fetchImpl }));
  assert.equal(t.store.outboxGet(n).status, 'queued', '429 is retried');
});

test('a non-idempotent operation that timed out is unknown and never retried; an idempotent one is retried', async () => {
  const t = make();
  const id = queue(t.store, 'charge');
  const calls = [];
  const running = flush(t.store, t.graph, opts(t, { fetchImpl: hang(calls) }));
  assert.equal(t.clock.pending(), 1, 'the timeout is a timer on the clock');
  await t.clock.advance(1999);
  assert.equal(t.store.outboxGet(id).status, 'sending', 'still waiting');
  await t.clock.advance(1);
  assert.deepEqual(await running, ['unknown']);
  const row = t.store.outboxGet(id);
  assert.deepEqual([row.status, row.attempts, row.nextAttemptAt, row.code], ['unknown', 1, null, null]);
  assert.match(row.error, /^no answer within 2000 ms; the request may have landed, so it is not retried$/);
  assert.equal(t.clock.pending(), 0, 'the timer is cleared');
  await t.clock.advance(24 * 3600 * 1000);
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: hang(calls) })), []);
  assert.equal(calls.length, 1, 'never sent again');
  assert.equal(t.store.breakerGet('p', 'live').failures, 1, 'but the provider did fail');

  const g = queue(t.store, 'get');
  const p = flush(t.store, t.graph, opts(t, { fetchImpl: hang(calls) }));
  await t.clock.advance(2000);
  assert.deepEqual(await p, ['queued']);
  assert.equal(t.store.outboxGet(g).nextAttemptAt, t.clock.now() + 1000);
});

test('a request that never left is retried even when the operation is not idempotent; one that may have arrived is not', async () => {
  const t = make();
  const id = queue(t.store, 'charge');
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([refused()]).fetchImpl })), ['queued']);
  assert.match(t.store.outboxGet(id).error, /fetch failed/);
  await t.clock.advance(1000);
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('r'), { code: 'ECONNRESET' }) });
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([reset]).fetchImpl })), ['unknown']);
  const other = queue(t.store, 'charge');
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([answer(500)]).fetchImpl })), ['failed'], 'answered with 500: final for a POST');
  assert.equal(t.store.outboxGet(other).error, 'HTTP 500');
});

test('the timeout comes from the descriptor, the connector may change it, and nothing waits longer than half the lease', async () => {
  const g = { ...graph, connectors: { p: { kind: 'pay', timeout: 90000 } } };
  const t = make({}, g);
  queue(t.store);
  const running = flush(t.store, t.graph, opts(t, { fetchImpl: hang() }));
  assert.equal(t.clock.nextAt() - t.clock.now(), LEASE_MS / 2, '90 s asked, 30 s given');
  await t.clock.advance(LEASE_MS / 2);
  assert.deepEqual(await running, ['queued']);
  const h = make({}, { ...graph, connectors: { p: { kind: 'pay', timeout: 500 } } });
  queue(h.store);
  const short = flush(h.store, h.graph, opts(h, { fetchImpl: hang() }));
  assert.equal(h.clock.nextAt() - h.clock.now(), 500, 'a shorter connector timeout wins over the descriptor');
  const j = make();
  queue(j.store);
  const small = flush(j.store, j.graph, opts(j, { fetchImpl: hang(), leaseMs: 3000 }));
  assert.equal(j.clock.nextAt() - j.clock.now(), 1500, 'and a shorter lease shortens it');
  await h.clock.advance(500); await j.clock.advance(1500);
  await short; await small;
});

test('the idempotency key is fixed at enqueue, sent as the descriptor\'s header, and the same on every retry and after a lease takeover', async () => {
  const t = make();
  const id = queue(t.store);
  const other = queue(t.store);
  const row = t.store.outboxGet(id);
  assert.equal(row.idemKey, idemKeyOf('r', 'p', id, row.at));
  assert.notEqual(t.store.outboxGet(other).idemKey, row.idemKey);
  t.store.outboxUpdate(other, { status: 'sent' });
  const net = scripted([answer(503), answer(503), answer(200)]);
  for (let i = 0; i < 3; i++) { await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl })); await t.clock.advance(60000); }
  assert.deepEqual(net.calls.map((c) => c.init.headers['Idempotency-Key']), [row.idemKey, row.idemKey, row.idemKey], 'three attempts, one key');
  assert.equal(t.store.outboxGet(id).idemKey, row.idemKey, 'the stored key does not move');

  const taken = queue(t.store);
  assert.equal(t.store.outboxClaim(taken, t.clock.now(), LEASE_MS), true, 'a process claims it and dies');
  await t.clock.advance(LEASE_MS);
  const after = scripted([answer(200)]);
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: after.fetchImpl })), ['sent']);
  assert.equal(after.calls[0].init.headers['Idempotency-Key'], t.store.outboxGet(taken).idemKey);
});

test('lease and retry: a takeover after a lease expired schedules its own retry, and the slow first delivery cannot undo it', async () => {
  const t = make();
  const id = queue(t.store);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = scripted(() => gate.then(() => answer(200)));
  const first = flush(t.store, t.graph, opts(t, { fetchImpl: slow.fetchImpl }));
  assert.equal(t.store.outboxGet(id).status, 'sending');
  await t.clock.advance(LEASE_MS);
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([answer(503)]).fetchImpl })), ['queued'], 'taken over once the lease ran out');
  const row = t.store.outboxGet(id);
  assert.deepEqual([row.status, row.attempts, row.nextAttemptAt], ['queued', 1, t.clock.now() + 1000]);
  release();
  assert.deepEqual(await first, ['stale'], 'the first one lost its claim');
  const after = t.store.outboxGet(id);
  assert.deepEqual([after.status, after.attempts, after.nextAttemptAt], ['queued', 1, row.nextAttemptAt], 'and did not write over the retry');
  assert.deepEqual(t.store.outboxDue(t.clock.now(), LEASE_MS), [], 'which waits for its time');
  await t.clock.advance(1000);
  assert.deepEqual(t.store.outboxDue(t.clock.now(), LEASE_MS).map((r) => r.id), [id]);
});

test('breaker: opens after N failures in a row, spares the connector, probes once, closes on success, reopens with a doubled cooldown', async () => {
  const t = make({ retry: { max: 10, baseMs: 1000, capMs: 8000, jitter: 0 }, breaker: { threshold: 3, cooldownMs: 10000, maxCooldownMs: 40000 } });
  const events = [];
  const ids = Array.from({ length: 5 }, () => queue(t.store));
  let up = false;
  const net = scripted(() => (up ? answer(200) : answer(503)));
  const o = () => opts(t, { fetchImpl: net.fetchImpl, trace: (e) => events.push(e) });
  const t0 = t.clock.now();
  assert.deepEqual(await flush(t.store, t.graph, o()), ['queued', 'queued', 'queued']);
  assert.equal(net.calls.length, 3, 'the fourth and fifth are not even tried');
  const b = t.store.breakerGet('p', 'live');
  assert.deepEqual([b.state, b.failures, b.openUntil, b.cooldownMs], ['open', 3, t0 + 10000, 10000]);
  assert.deepEqual(events.filter((e) => e.kind === 'breaker').map((e) => [e.from, e.to]), [['closed', 'open']]);
  assert.deepEqual(ids.slice(3).map((i) => [t.store.outboxGet(i).attempts, t.store.outboxGet(i).nextAttemptAt, t.store.outboxGet(i).status]), [[0, t0 + 10000, 'queued'], [0, t0 + 10000, 'queued']],
    'pushed to the end of the cooldown, no attempt counted');
  await t.clock.advance(3000);
  assert.deepEqual(await flush(t.store, t.graph, o()), [], 'still open: nothing is claimed');
  assert.equal(net.calls.length, 3);

  await t.clock.advance(7000);
  assert.deepEqual(await flush(t.store, t.graph, o()), ['queued'], 'one probe, and it fails');
  assert.equal(net.calls.length, 4);
  const again = t.store.breakerGet('p', 'live');
  assert.deepEqual([again.state, again.cooldownMs, again.openUntil], ['open', 20000, t.clock.now() + 20000]);
  assert.deepEqual(ids.slice(1).map((i) => t.store.outboxGet(i).attempts), [1, 1, 0, 0], 'the others wait, without a new attempt');
  assert.deepEqual(ids.slice(1).map((i) => t.store.outboxGet(i).nextAttemptAt), ids.slice(1).map(() => again.openUntil));
  assert.deepEqual(events.filter((e) => e.kind === 'breaker').map((e) => [e.from, e.to]), [['closed', 'open'], ['half', 'open']]);

  up = true;
  await t.clock.advance(20000);
  assert.deepEqual(await flush(t.store, t.graph, o()), ['sent', 'sent', 'sent', 'sent', 'sent'], 'the probe succeeds, the breaker closes and the rest goes');
  assert.deepEqual([t.store.breakerGet('p', 'live').state, t.store.breakerGet('p', 'live').failures], ['closed', 0]);
  assert.deepEqual(ids.map((i) => t.store.outboxGet(i).status), ['sent', 'sent', 'sent', 'sent', 'sent']);
});

test('breaker: two flushes at once send one probe; a claim is one UPDATE that only the first caller wins', async () => {
  const t = make({ breaker: { threshold: 1, cooldownMs: 5000, maxCooldownMs: 40000 } });
  const ids = [queue(t.store), queue(t.store)];
  t.store.breakerRecord('p', 'live', 'failure', t.clock.now(), { threshold: 1, cooldownMs: 5000 });
  await t.clock.advance(5000);
  let release;
  const gate = new Promise((r) => { release = r; });
  const net = scripted(() => gate.then(() => answer(200)));
  const a = flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl }));
  const b = await flush(t.store, t.graph, opts(t, { fetchImpl: net.fetchImpl }));
  assert.deepEqual(b, [], 'the second flush finds the probe out and leaves the other row alone');
  assert.equal(net.calls.length, 1);
  assert.equal(t.store.breakerGet('p', 'live').state, 'half');
  release();
  assert.deepEqual(await a, ['sent', 'sent']);
  assert.equal(net.calls.length, 2);
  assert.deepEqual(ids.map((i) => t.store.outboxGet(i).status), ['sent', 'sent']);

  const s = new Store(graph, ':memory:');
  s.breakerRecord('p', 'live', 'failure', 0, { threshold: 1, cooldownMs: 1000 });
  let raced = false;
  s.drv.onQuery = (sql) => {
    if (raced || !sql.startsWith('UPDATE "_breaker"')) return;
    raced = true;
    s.drv.run(`UPDATE "_breaker" SET "state"='half', "probeClaimedAt"=? WHERE "key"=?`, [7, 'p|live']);
  };
  assert.equal(s.breakerClaim('p', 'live', 2000, {}), false, 'another instance took it between the read and the write');
  s.drv.onQuery = null;
  assert.equal(s.breakerGet('p', 'live').probeClaimedAt, 7, 'and its claim stands');
  assert.equal(s.breakerClaim('p', 'live', 2000, {}), false, 'a probe is out');
  assert.equal(s.breakerClaim('p', 'live', 2000 + 60000, {}), true, 'until its lease runs out');
});

test('breaker: one per connector and mode, kept in the table, listed in order', () => {
  const s = new Store(graph, ':memory:');
  const cfg = { threshold: 1, cooldownMs: 1000 };
  s.breakerRecord('p', 'live', 'failure', 0, cfg);
  assert.equal(s.breakerGet('p', 'sandbox').state, 'closed', 'sandbox is another breaker');
  assert.equal(s.breakerGet('q', 'live').state, 'closed');
  s.breakerRecord('a', 'sandbox', 'failure', 0, cfg);
  s.breakerRecord('a', 'live', 'failure', 0, cfg);
  assert.deepEqual(s.breakers().map((b) => [b.connector, b.mode, b.state]), [['a', 'live', 'open'], ['a', 'sandbox', 'open'], ['p', 'live', 'open']]);
  assert.equal(s.breakerRecord('z', 'live', 'success', 0, cfg).after.state, 'closed');
  assert.equal(s.breakers().length, 3, 'a success on a closed breaker writes nothing');
  const { before, after } = s.breakerRecord('p', 'live', 'success', 5, cfg);
  assert.deepEqual([before.state, after.state], ['open', 'closed']);
  assert.equal(s.breakerGet('p', 'live').failures, 0);
});

test('a breaker that is open in one mode does not stop deliveries in another', async () => {
  const t = make({ modes: ['sandbox', 'live'], sandbox: { operations: { get: [{ status: 200 }], charge: [{ status: 200 }] } } });
  const in_ = (mode) => ({ env: { deploy: () => ({ connectors: { p: mode } }), secrets: null } });
  queue(t.store);
  t.store.breakerRecord('p', 'live', 'failure', t.clock.now(), { threshold: 1, cooldownMs: 5000 });
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([answer(200)]).fetchImpl, ...in_('sandbox') })), ['sent']);
  queue(t.store);
  assert.deepEqual(await flush(t.store, t.graph, opts(t, { fetchImpl: scripted([answer(200)]).fetchImpl, ...in_('live') })), [], 'live is still open');
});

test('the queue helpers: outboxDue respects nextAttemptAt, outboxNextDue finds the earliest wait, outboxDefer and outboxMark are guarded', () => {
  const s = new Store(graph, ':memory:');
  const mk = (patch) => { const id = s.enqueue({ kind: 'pay', connector: 'p', target: 't', payload: 1, op: 'get' }); s.outboxUpdate(id, patch); return id; };
  const [a, b, c, d, e] = [mk({ nextAttemptAt: 5000 }), mk({ nextAttemptAt: 3000 }), mk({ status: 'sent', nextAttemptAt: 1000 }), mk({}), mk({ nextAttemptAt: 2000 })];
  assert.deepEqual(s.outboxDue(2000, LEASE_MS).map((r) => r.id), [d, e], 'due: no wait, or the wait is over');
  assert.deepEqual(s.outboxDue(9000, LEASE_MS).map((r) => r.id), [a, b, d, e]);
  assert.equal(s.outboxNextDue(2000), 3000, 'the earliest wait still ahead; sent rows and the past do not count');
  assert.equal(s.outboxNextDue(3000), 5000);
  assert.equal(s.outboxNextDue(5000), null);
  s.outboxDefer(d, 7000); s.outboxDefer(c, 7000);
  assert.deepEqual([s.outboxGet(d).nextAttemptAt, s.outboxGet(d).attempts, s.outboxGet(c).nextAttemptAt], [7000, 0, 1000], 'only a queued row moves, and no attempt is counted');
  s.outboxUpdate(a, { status: 'unknown' });
  assert.equal(s.outboxMark(a, 'failed', { status: 'sent' }), false);
  assert.equal(s.outboxGet(a).status, 'unknown');
  assert.equal(s.outboxMark(a, 'unknown', { status: 'sent', error: null }), true);
  assert.equal(s.outboxMark(a, 'unknown', { status: 'failed' }), false, 'a second click finds nothing to decide');
  assert.equal(s.outboxGet(a).status, 'sent');
});

const flusher = (t, extra = {}) => {
  const server = new EventEmitter();
  const events = [];
  const net = extra.net || scripted([answer(200)]);
  const f = startFlusher({ store: t.store, graph: t.graph, server, trace: (e) => events.push(e), clock: t.clock, registry: t.registry, fetchImpl: net.fetchImpl, ...extra.args });
  return { f, server, events, net };
};

test('the flusher sends what is queued every interval, and wakes at the earliest nextAttemptAt', async () => {
  const t = make();
  const id = queue(t.store);
  t.store.outboxUpdate(id, { nextAttemptAt: t.clock.now() + 3000 });
  const { net } = flusher(t, { args: { intervalMs: 60000 } });
  await t.clock.advance(2999);
  assert.equal(net.calls.length, 0);
  await t.clock.advance(1);
  assert.equal(net.calls.length, 1, 'fired at nextAttemptAt, not at the interval');
  assert.equal(t.store.outboxGet(id).status, 'sent');
  const later = queue(t.store);
  await t.clock.advance(59999 - 3000 + 1);
  assert.equal(t.store.outboxGet(later).status, 'sent', 'and the interval picks up the rest');
});

test('the flusher: a retry due is fired on its own, and the loop keeps going', async () => {
  const t = make();
  const id = queue(t.store);
  const { net } = flusher(t, { net: scripted([answer(503), answer(503), answer(200)]), args: { intervalMs: 5000 } });
  await t.clock.advance(5000);
  assert.equal(t.store.outboxGet(id).attempts, 1);
  const first = t.store.outboxGet(id).nextAttemptAt;
  await t.clock.advance(first - t.clock.now() - 1);
  assert.equal(net.calls.length, 1);
  await t.clock.advance(1);
  assert.equal(net.calls.length, 2, 'the second attempt fires when it is due');
  await t.clock.advance(4000);
  assert.equal(t.store.outboxGet(id).status, 'sent');
  assert.equal(t.store.outboxGet(id).attempts, 3);
});

test('the flusher is off under noTimers, and stops when the server closes', async () => {
  const off = make();
  queue(off.store);
  const dead = flusher(off, { args: { noTimers: true } });
  assert.equal(dead.f, null);
  assert.equal(off.clock.pending(), 0, 'not a timer');
  await off.clock.advance(3600 * 1000);
  assert.equal(dead.net.calls.length, 0, 'nothing is sent on its own');

  const t = make();
  const live = flusher(t);
  assert.equal(t.clock.pending(), 1, 'the interval (no waiting row, so no one-shot)');
  queue(t.store);
  live.f.arm();
  assert.equal(t.clock.pending(), 1);
  t.store.outboxUpdate(1, { nextAttemptAt: t.clock.now() + 500 });
  live.f.arm();
  assert.equal(t.clock.pending(), 2, 'the interval and the one-shot');
  live.server.emit('close');
  assert.equal(t.clock.pending(), 0);
  await t.clock.advance(3600 * 1000);
  assert.equal(live.net.calls.length, 0);
});

test('the flusher does not overlap itself, survives a failing flush, and stays stopped once stopped', async () => {
  const t = make();
  queue(t.store);
  let release;
  const gate = new Promise((r) => { release = r; });
  const net = scripted(() => gate.then(() => answer(200)));
  const { f, events } = flusher(t, { net, args: { intervalMs: 1000 } });
  const step = t.clock.advance(1000);
  await Promise.resolve();
  assert.equal(net.calls.length, 1);
  const later = queue(t.store);
  t.store.outboxUpdate(later, { nextAttemptAt: t.clock.now() + 10 });
  f.arm();
  await t.clock.advance(10);
  assert.equal(net.calls.length, 1, 'woken while a flush is running: it does not start another');
  const distant = queue(t.store);
  t.store.outboxUpdate(distant, { nextAttemptAt: t.clock.now() + 5000 });
  f.stop();
  release();
  await step;
  assert.equal(t.clock.pending(), 0, 'stopped while busy: nothing is armed again, though a retry is still waiting');
  assert.equal(t.store.outboxGet(later).status, 'queued');

  const broken = make();
  const bad = flusher(broken, { args: { intervalMs: 1000, store: { outboxDue() { throw new Error('db gone'); }, outboxNextDue: () => null } } });
  await broken.clock.advance(2000);
  assert.deepEqual(bad.events.map((e) => [e.kind, e.message]), [['error', 'db gone'], ['error', 'db gone']], 'traced, and it tries again on the next tick');
  assert.deepEqual(events.map((e) => e.kind), ['delivery'], 'the delivery in flight finished and was traced; nothing failed');
});

test('an old database is upgraded in place: the new columns and the breaker table appear, and a row without a key gets the key it would have had', async () => {
  const file = path.join(tmpDir('rel-'), 'old.sqlite');
  const old = open(file);
  old.exec(`CREATE TABLE "_outbox" (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, connector TEXT, target TEXT, payload TEXT,
    status TEXT, code INTEGER, error TEXT, attempts INTEGER DEFAULT 0, at TEXT, updatedAt TEXT, claimedAt INTEGER, op TEXT, response TEXT, result TEXT, drift INTEGER)`);
  old.run(`INSERT INTO "_outbox" (kind, connector, target, payload, status, attempts, at, op) VALUES ('pay','p','https://api.test/x','{}','queued',0,'2026-01-01T00:00:00.000Z','get')`);
  old.close();
  const s = new Store(graph, file);
  assert.deepEqual(s.breakers(), []);
  assert.deepEqual([s.outboxGet(1).nextAttemptAt, s.outboxGet(1).idemKey], [null, null]);
  const t = { store: s, graph, clock: fakeClock(), registry: registerDescriptor(createRegistry(), structuredClone(D), 'pay.json') };
  const net = scripted([answer(200)]);
  assert.deepEqual(await flush(s, graph, opts(t, { fetchImpl: net.fetchImpl })), ['sent']);
  assert.equal(net.calls[0].init.headers['Idempotency-Key'], idemKeyOf('r', 'p', 1, '2026-01-01T00:00:00.000Z'));
  const id = s.enqueue({ kind: 'pay', connector: 'p', target: 't', payload: 1, op: 'get' });
  assert.match(s.outboxGet(id).idemKey, /^[0-9a-f]{32}$/);
  assert.equal(new Store(graph, file).outboxGet(id).idemKey, s.outboxGet(id).idemKey, 'a second boot changes nothing');
  s.drv.close();
});

test('descriptor: retry, breaker and idempotency are checked, and everything else is still refused', () => {
  const bad = (patch) => checkDescriptor({ ...structuredClone(D), ...patch }).map(([p, m]) => `${p}: ${m}`);
  assert.deepEqual(checkDescriptor(D), []);
  assert.deepEqual(bad({ retry: { max: 0 } }), ['/retry/max: "max" is a whole number from 1 to 20']);
  assert.deepEqual(bad({ breaker: { threshold: 'many' } }), ['/breaker/threshold: "threshold" is a whole number from 1 to 1000']);
  assert.deepEqual(bad({ retry: { baseMs: 9000, capMs: 10 } }), ['/retry: "capMs" may not be below "baseMs"']);
  assert.deepEqual(bad({ idempotency: 'Idempotency-Key' }), ['/idempotency: "idempotency" is an object']);
  assert.deepEqual(bad({ idempotency: {} }), ['/idempotency/header: "header" names the request header that carries the key']);
  assert.deepEqual(bad({ idempotency: { header: 'bad name' } }), ['/idempotency/header: "header" names the request header that carries the key']);
  assert.deepEqual(bad({ idempotency: { header: 'X-Key', body: 1 } }), ['/idempotency/body: unknown key "body"']);
  assert.deepEqual(bad({ auth: {} }), ['/auth: unknown key "auth"']);
});

test('the engine: the key goes into the descriptor\'s header only, Retry-After is read from failures only, and a thrown request says why', async () => {
  const d = structuredClone(D);
  const withKey = buildRequest(d, {}, 'get', {}, { idemKey: 'abc' });
  assert.equal(withKey.headers['Idempotency-Key'], 'abc');
  assert.deepEqual(buildRequest(d, {}, 'get', {}).headers, {}, 'no key, no header');
  assert.deepEqual(buildRequest({ ...d, idempotency: undefined }, {}, 'get', {}, { idemKey: 'abc' }).headers, {}, 'a descriptor without one sends none');
  assert.equal(buildRequest(d, { timeout: 99999 }, 'get', {}, { timeoutCapMs: 1234 }).timeout, 1234);
  assert.equal(buildRequest(d, { timeout: 99999 }, 'get', {}).timeout, 30000, 'the default cap is half the default lease');

  const op = d.operations.get;
  assert.deepEqual((await mapResponse(op, answer(503, { 'retry-after': '9' }))).patch, { code: 503, status: 'failed', error: 'HTTP 503', retryAfter: '9' });
  assert.deepEqual((await mapResponse(op, answer(503))).patch, { code: 503, status: 'failed', error: 'HTTP 503' });
  assert.deepEqual((await mapResponse(op, answer(200, { 'retry-after': '9' }))).patch, { code: 200, status: 'sent', error: null });

  const row = { id: 1, op: 'get', payload: {} };
  const clock = fakeClock();
  await assert.rejects(deliverRow(d, row, {}, { fetchImpl: scripted([refused()]).fetchImpl, clock }), (e) => e.fault === 'unsent' && e.message === 'fetch failed' && e.cause instanceof TypeError);
  const slow = deliverRow(d, row, {}, { fetchImpl: hang(), clock });
  await clock.advance(2000);
  await assert.rejects(slow, (e) => e.fault === 'timeout' && /no answer within 2000 ms/.test(e.message));
  await assert.rejects(deliverRow(d, { ...row, op: 'nope' }, {}, { clock }), (e) => e.fault === undefined && /no operation "nope"/.test(e.message));
  await assert.rejects(deliverRow(d, row, {}, { fetchImpl: async () => { throw undefined; }, clock }), (e) => e.fault === 'net');
});

test('the outbox screen: unknown offers "Mark sent" and "Retry", failed offers Retry, a waiting retry shows its time, breakers are listed', () => {
  const r = (id, status, extra = {}) => ({ id, kind: 'pay', connector: 'p', target: 't', status, payload: null, updatedAt: 'u', attempts: 1, ...extra });
  const html = outboxView(graph, [r(1, 'unknown', { error: 'no answer' }), r(2, 'failed'), r(3, 'queued', { nextAttemptAt: Date.UTC(2026, 8, 29, 12, 0, 0), attempts: 2 }), r(4, 'sent'), r(5, 'queued')], null, undefined,
    [{ connector: 'p', mode: 'live', state: 'open', failures: 5, openUntil: Date.UTC(2026, 8, 29, 12, 5, 0) }, { connector: 'q', mode: 'sandbox', state: 'closed', failures: 2, openUntil: 0 }]);
  const cells = rows(html).map((x) => x);
  assert.match(cells[0], /action="\/outbox\/1\/sent"[\s\S]*Mark sent[\s\S]*action="\/outbox\/1\/retry"/);
  assert.match(cells[1], /action="\/outbox\/2\/retry"/);
  assert.doesNotMatch(cells[1], /Mark sent/);
  assert.match(cells[2], /attempt 3 at 2026-09-29T12:00:00.000Z/);
  assert.doesNotMatch(cells[3] + cells[4], /retry|attempt|Mark sent/);
  assert.match(html, /Circuit breakers/);
  assert.match(cells[5], /<td>p<\/td><td>live<\/td><td><span class="status">open<\/span><\/td>\s*<td>5<\/td><td>2026-09-29T12:05:00.000Z<\/td>/);
  assert.match(cells[6], /<td>q<\/td><td>sandbox<\/td><td><span class="status">closed<\/span><\/td>\s*<td>2<\/td><td><\/td>/);
  assert.doesNotMatch(outboxView(graph, [], null), /Circuit breakers/, 'no breakers, no table');
});

const APP = { app: 'rel', data: { A: { n: 'text' } }, connectors: { hook: { kind: 'http', url: 'http://sink.test/h' } },
  actions: [{ name: 'ping', after: '/', do: [{ block: 'http.send', connector: 'hook', body: { a: 1 } }] }] };

test('an outage and its recovery on the server, with a fake clock: retries on their own, the breaker opens, the operator retries, it closes', async () => {
  const clock = fakeClock();
  const s = await boot(tmpGraph(APP), { clock });
  try {
    assert.ok(s.app.flusher, 'the flusher runs on the injected clock');
    s.net.state.throwWith = 'connect ECONNREFUSED 127.0.0.1:9';
    assert.equal((await s.post('/action/ping')).status, 303);
    const store = s.app.store;
    let row = store.outbox()[0];
    assert.deepEqual([row.status, row.attempts], ['queued', 1]);
    assert.ok(row.nextAttemptAt > clock.now() + 799 && row.nextAttemptAt <= clock.now() + 1000, 'first wait: 1 s less jitter');
    await clock.advance(20000);
    row = store.outbox()[0];
    assert.deepEqual([row.status, row.attempts, row.nextAttemptAt], ['failed', 5, null], 'five attempts, all on their own');
    assert.match(row.error, /connect ECONNREFUSED 127.0.0.1:9 \(gave up after 5 attempts\)/);
    assert.equal(s.net.calls.length, 5);
    const b = store.breakerGet('hook', 'live');
    assert.deepEqual([b.state, b.failures], ['open', 5]);
    assert.match((await s.get('/outbox')).html, /Circuit breakers[\s\S]*<td>hook<\/td><td>live<\/td><td><span class="status">open<\/span>/);
    assert.equal(s.trace().filter((e) => e.kind === 'breaker').length, 1);

    s.net.state.throwWith = null;
    const retry = await s.post(`/outbox/${row.id}/retry`);
    assert.match(decodeURIComponent(retry.location), /retried: queued/, 'the breaker still spares the provider');
    row = store.outboxGet(row.id);
    assert.deepEqual([row.status, row.attempts, row.nextAttemptAt], ['queued', 0, store.breakerGet('hook', 'live').openUntil]);
    assert.equal(s.net.calls.length, 5, 'nothing was sent while it cools');
    await clock.advance(30000);
    row = store.outboxGet(row.id);
    assert.deepEqual([row.status, row.attempts, row.nextAttemptAt], ['sent', 1, null]);
    assert.equal(store.breakerGet('hook', 'live').state, 'closed');
    assert.match((await s.get('/outbox')).html, /<span class="status">closed<\/span>/);
  } finally {
    const closed = once(s.app.server, 'close');
    s.close();
    await closed;
  }
  assert.equal(clock.pending(), 0, 'closing the server stopped the flusher');
});

test('the server has no flusher under noTimers, so nothing is retried on its own', async () => {
  const clock = fakeClock();
  const s = await boot(tmpGraph(APP), { clock, noTimers: true });
  try {
    assert.equal(s.app.flusher, null);
    s.net.state.throwWith = 'connect ECONNREFUSED';
    await s.post('/action/ping');
    await clock.advance(3600 * 1000);
    assert.equal(s.net.calls.length, 1);
    assert.equal(clock.pending(), 0);
  } finally { s.close(); }
});

test('the operator: "mark sent" settles only an unknown delivery, and Retry starts one over', async () => {
  const s = await boot(tmpGraph(APP), { clock: fakeClock(), noTimers: true });
  try {
    const store = s.app.store;
    const mk = (patch) => { const id = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/h', payload: 1 }); store.outboxUpdate(id, patch); return id; };
    const unknown = mk({ status: 'unknown', attempts: 1, error: 'no answer' });
    const failed = mk({ status: 'failed', attempts: 3, error: 'HTTP 500' });
    assert.match(decodeURIComponent((await s.post(`/outbox/${unknown}/sent`)).location), /marked as sent/);
    assert.deepEqual([store.outboxGet(unknown).status, store.outboxGet(unknown).error], ['sent', null]);
    assert.match(decodeURIComponent((await s.post(`/outbox/${unknown}/sent`)).location), /not waiting for a decision/);
    assert.match(decodeURIComponent((await s.post(`/outbox/${failed}/sent`)).location), /not waiting for a decision/);
    assert.equal(store.outboxGet(failed).status, 'failed', 'a failure is not a decision to make');
    assert.equal((await s.post('/outbox/999/sent')).status, 404);
    assert.equal(s.net.calls.length, 0, 'marking sent sends nothing');

    const waiting = mk({ status: 'unknown', attempts: 2, nextAttemptAt: clock2() });
    assert.match(decodeURIComponent((await s.post(`/outbox/${waiting}/retry`)).location), /retried: sent/);
    assert.deepEqual([store.outboxGet(waiting).attempts, store.outboxGet(waiting).nextAttemptAt], [1, null], 'attempts start over and the schedule is cleared');
    const queued = mk({ status: 'queued', attempts: 4, nextAttemptAt: clock2() });
    await s.post(`/outbox/${queued}/retry`);
    assert.equal(store.outboxGet(queued).status, 'sent', 'a scheduled wait does not hold back a manual retry');
    assert.match((await s.get('/outbox')).html, /<span class="status">sent<\/span> 200/);
    const un = mk({ status: 'unknown', attempts: 1, error: 'no answer' });
    const page = rows((await s.get('/outbox')).html).find((r) => r.includes(`/outbox/${un}/sent`));
    assert.match(page, /Mark sent[\s\S]*Retry/);
  } finally { s.close(); }
});
const clock2 = () => Date.now() + 10 * 3600 * 1000;

test('deliver takes a claim and a clock: what it writes is the settled patch', async () => {
  const t = make();
  const id = queue(t.store);
  const row = t.store.outboxGet(id);
  t.store.outboxClaim(id, t.clock.now(), LEASE_MS);
  const events = [];
  assert.equal(await deliver(t.store, t.graph, row, { ...opts(t, { fetchImpl: scripted([answer(503)]).fetchImpl, trace: (e) => events.push(e), claimedAt: t.clock.now() }) }), 'queued');
  assert.deepEqual(events.map((e) => [e.kind, e.status, e.nextAttemptAt]), [['delivery', 'queued', t.clock.now() + 1000]]);
});
