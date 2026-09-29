// The reliability policy (runtime/connectors/backoff.mjs) and what a delivery settles to
// (runtime/settle.mjs): pure functions, tested as tables. No storage, no network, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, faultOf, decide, delayFor, retryAfterMs, checkPolicy, breakerStep, breakerEvent, idemKeyOf, CLOSED, DEFAULT_RETRY, DEFAULT_BREAKER } from '../runtime/connectors/backoff.mjs';
import { settle, policyOf } from '../runtime/settle.mjs';
import { resolveClock, systemClock } from '../runtime/clock.mjs';

test('classify: network, timeout, 429 and 5xx are retryable, other 4xx is final, 2xx is sent', () => {
  const kinds = (statuses) => statuses.map((status) => classify({ status }).kind);
  assert.deepEqual(kinds([200, 201, 204, 299]), ['sent', 'sent', 'sent', 'sent']);
  assert.deepEqual(kinds([429, 500, 502, 503, 599]), ['retry', 'retry', 'retry', 'retry', 'retry']);
  assert.deepEqual(kinds([301, 400, 401, 403, 404, 409, 422]), ['permanent', 'permanent', 'permanent', 'permanent', 'permanent', 'permanent', 'permanent']);
  assert.deepEqual(classify({ status: 503 }), { kind: 'retry' }, 'an answer is never ambiguous');
  assert.deepEqual(classify({ fault: 'timeout' }), { kind: 'retry', ambiguous: true, unsent: false });
  assert.deepEqual(classify({ fault: 'net' }), { kind: 'retry', ambiguous: true, unsent: false });
  assert.deepEqual(classify({ fault: 'unsent' }), { kind: 'retry', ambiguous: false, unsent: true });
});

test('faultOf tells a timeout, a request that never left and one that may have arrived', () => {
  const named = (name) => Object.assign(new Error('x'), { name });
  assert.equal(faultOf(named('TimeoutError')), 'timeout');
  assert.equal(faultOf(named('AbortError')), 'timeout');
  assert.equal(faultOf(new TypeError('fetch failed', { cause: Object.assign(new Error('c'), { code: 'ECONNREFUSED' }) })), 'unsent');
  assert.equal(faultOf(new TypeError('fetch failed', { cause: Object.assign(new Error('c'), { code: 'ENOTFOUND' }) })), 'unsent');
  assert.equal(faultOf(Object.assign(new Error('x'), { code: 'EAI_AGAIN' })), 'unsent');
  assert.equal(faultOf(new Error('connect ECONNREFUSED 127.0.0.1:1')), 'unsent');
  assert.equal(faultOf(new Error('connect EHOSTUNREACH')), 'unsent');
  assert.equal(faultOf(new Error('connect ENETUNREACH')), 'unsent');
  assert.equal(faultOf(new TypeError('fetch failed', { cause: Object.assign(new Error('c'), { code: 'ECONNRESET' }) })), 'net');
  assert.equal(faultOf(new Error('boom')), 'net');
  assert.equal(faultOf(null), 'net');
});

test('the delay doubles from the base, is capped, and has no jitter when jitter is 0', () => {
  const retry = { baseMs: 1000, capMs: 8000, jitter: 0 };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map((n) => delayFor(retry, n, 'k')), [1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  assert.deepEqual([1, 2, 3].map((n) => delayFor({}, n, 'k') <= DEFAULT_RETRY.baseMs * 2 ** (n - 1)), [true, true, true], 'defaults apply');
  assert.equal(delayFor({ jitter: 0 }, 30, 'k'), DEFAULT_RETRY.capMs);
});

test('jitter is deterministic from the key and the attempt, only ever takes time away, and never uses Math.random', (t) => {
  t.mock.method(Math, 'random', () => { throw new Error('Math.random must not be used'); });
  const retry = { baseMs: 1000, capMs: 60000, jitter: 0.5 };
  const seen = new Set();
  for (let n = 1; n <= 6; n++) {
    const d = delayFor(retry, n, 'key-a');
    assert.equal(d, delayFor(retry, n, 'key-a'), 'same key and attempt, same delay');
    const raw = Math.min(60000, 1000 * 2 ** (n - 1));
    assert.ok(d <= raw && d >= raw * 0.5, `attempt ${n}: ${d} within [${raw / 2}, ${raw}]`);
    seen.add(d / raw);
  }
  assert.ok(seen.size > 1, 'the spread differs from one attempt to the next');
  const keys = Array.from({ length: 20 }, (_, i) => delayFor(retry, 3, `key-${i}`));
  assert.ok(new Set(keys).size > 5, 'and from one row to the next');
  assert.ok(keys.every((d) => d <= 4000 && d >= 2000));
});

test('Retry-After: seconds or a date, from the answer, raised over the schedule but capped', () => {
  assert.equal(retryAfterMs('7', 0), 7000);
  assert.equal(retryAfterMs(' 120 ', 0), 120000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 10000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:29:00 GMT')), 0, 'a date in the past');
  assert.equal(retryAfterMs('soon', 0), 0);
  assert.equal(retryAfterMs('0', 0), 0);
  assert.equal(retryAfterMs(undefined, 0), 0);
  assert.equal(retryAfterMs(null, 0), 0);
  const retry = { baseMs: 1000, capMs: 8000, jitter: 0 };
  assert.equal(delayFor(retry, 1, 'k', 5000), 5000, 'raised to what the provider asked');
  assert.equal(delayFor(retry, 3, 'k', 2000), 4000, 'never lowered');
  assert.equal(delayFor(retry, 1, 'k', 600000), 8000, 'the ask is capped');
});

test('decide: only an idempotent operation is retried after an answer or a lost request; a request that never left may always be', () => {
  const at = (attempts, extra = {}) => ({ idempotent: true, attempts, retry: { max: 3, baseMs: 1000, capMs: 8000, jitter: 0 }, idemKey: 'k', ...extra });
  assert.deepEqual(decide({ kind: 'sent' }, at(1)), { action: 'sent' });
  assert.deepEqual(decide({ kind: 'permanent' }, at(1)), { action: 'failed' });
  assert.deepEqual(decide({ kind: 'retry' }, at(1)), { action: 'retry', delayMs: 1000 });
  assert.deepEqual(decide({ kind: 'retry' }, at(2)), { action: 'retry', delayMs: 2000 });
  assert.deepEqual(decide({ kind: 'retry' }, at(3)), { action: 'failed', reason: 'gave up after 3 attempts' }, 'max counts the first attempt');
  assert.deepEqual(decide({ kind: 'retry' }, at(1, { retry: { max: 1 } })), { action: 'failed', reason: 'gave up after 1 attempts' });
  assert.deepEqual(decide({ kind: 'retry' }, at(1, { retryAfter: 4000 })), { action: 'retry', delayMs: 4000 });
  const post = { idempotent: false };
  assert.deepEqual(decide(classify({ fault: 'timeout' }), at(1, post)), { action: 'unknown' }, 'it may have landed');
  assert.deepEqual(decide(classify({ fault: 'net' }), at(1, post)), { action: 'unknown' });
  assert.deepEqual(decide(classify({ status: 503 }), at(1, post)), { action: 'failed' }, 'answered: not repeated');
  assert.deepEqual(decide(classify({ status: 429 }), at(1, post)), { action: 'failed' });
  assert.deepEqual(decide(classify({ fault: 'unsent' }), at(1, post)), { action: 'retry', delayMs: 1000 }, 'nothing left the machine');
  assert.deepEqual(decide(classify({ fault: 'unsent' }), at(3, post)), { action: 'failed', reason: 'gave up after 3 attempts' });
  assert.deepEqual(decide(classify({ fault: 'timeout' }), at(9, { idempotent: true })), { action: 'failed', reason: 'gave up after 9 attempts' });
  assert.equal(DEFAULT_RETRY.max, 5);
});

test('checkPolicy says what is wrong with a retry or breaker block', () => {
  assert.deepEqual(checkPolicy('retry', { max: 3, baseMs: 500, capMs: 5000, jitter: 0.1 }, '/retry'), []);
  assert.deepEqual(checkPolicy('breaker', { threshold: 3, cooldownMs: 100, maxCooldownMs: 100 }, '/breaker'), []);
  assert.deepEqual(checkPolicy('retry', {}, '/retry'), []);
  const msg = (kind, v) => checkPolicy(kind, v, `/${kind}`).map(([p, m]) => `${p}: ${m}`);
  assert.deepEqual(msg('retry', 3), ['/retry: "retry" is an object']);
  assert.deepEqual(msg('retry', [1]), ['/retry: "retry" is an object']);
  assert.deepEqual(msg('retry', null), ['/retry: "retry" is an object']);
  assert.deepEqual(msg('retry', { tries: 1 }), ['/retry/tries: unknown key "tries"']);
  assert.deepEqual(msg('retry', { max: 0 }), ['/retry/max: "max" is a whole number from 1 to 20']);
  assert.deepEqual(msg('retry', { max: 21 }), ['/retry/max: "max" is a whole number from 1 to 20']);
  assert.deepEqual(msg('retry', { max: 2.5 }), ['/retry/max: "max" is a whole number from 1 to 20']);
  assert.deepEqual(msg('retry', { max: '3' }), ['/retry/max: "max" is a whole number from 1 to 20']);
  assert.deepEqual(msg('retry', { baseMs: 0 }), ['/retry/baseMs: "baseMs" is a whole number from 1 to 3600000']);
  assert.deepEqual(msg('retry', { jitter: 1.5 }), ['/retry/jitter: "jitter" is a number from 0 to 1']);
  assert.deepEqual(msg('retry', { jitter: -0.1 }), ['/retry/jitter: "jitter" is a number from 0 to 1']);
  assert.deepEqual(msg('retry', { jitter: 0.25 }), []);
  assert.deepEqual(msg('retry', { baseMs: 5000, capMs: 1000 }), ['/retry: "capMs" may not be below "baseMs"']);
  assert.deepEqual(msg('retry', { baseMs: 999999 }), ['/retry: "capMs" may not be below "baseMs"'], 'the default cap counts too');
  assert.deepEqual(msg('breaker', { threshold: 0 }), ['/breaker/threshold: "threshold" is a whole number from 1 to 1000']);
  assert.deepEqual(msg('breaker', { cooldownMs: 9000, maxCooldownMs: 100 }), ['/breaker: "maxCooldownMs" may not be below "cooldownMs"']);
});

test('the idempotency key is a pure function of app, connector, row id and creation time', () => {
  const k = idemKeyOf('shop', 'pay', 7, '2026-09-29T10:00:00.000Z');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(k, idemKeyOf('shop', 'pay', 7, '2026-09-29T10:00:00.000Z'));
  for (const other of [idemKeyOf('shop2', 'pay', 7, '2026-09-29T10:00:00.000Z'), idemKeyOf('shop', 'pay2', 7, '2026-09-29T10:00:00.000Z'),
    idemKeyOf('shop', 'pay', 8, '2026-09-29T10:00:00.000Z'), idemKeyOf('shop', 'pay', 7, '2026-09-29T10:00:00.001Z')]) assert.notEqual(other, k);
});

const CFG = { threshold: 3, cooldownMs: 10000, maxCooldownMs: 40000, probeLeaseMs: 60000 };
const fail = (b, now) => breakerStep(b, 'failure', now, CFG);

test('breakerStep: closed opens after N consecutive failures, and a success resets the count', () => {
  let b = { ...CLOSED };
  b = fail(b, 100); b = fail(b, 100);
  assert.deepEqual([b.state, b.failures], ['closed', 2]);
  b = breakerStep(b, 'success', 100, CFG);
  assert.deepEqual(b, CLOSED, 'a success in the middle starts the count again');
  b = fail(fail(b, 100), 100);
  assert.equal(b.state, 'closed');
  b = fail(b, 500);
  assert.deepEqual(b, { state: 'open', failures: 3, openUntil: 10500, cooldownMs: 10000, probeClaimedAt: 0 });
  assert.deepEqual(breakerStep(CLOSED, 'failure', 0, { threshold: 1, cooldownMs: 5 }), { state: 'open', failures: 1, openUntil: 5, cooldownMs: 5, probeClaimedAt: 0 });
  assert.equal(DEFAULT_BREAKER.threshold, 5);
  assert.deepEqual(breakerStep(CLOSED, 'failure', 0), { ...CLOSED, failures: 1 }, 'defaults apply');
});

test('breakerStep: the probe is given once the cooldown is over, once, and again only if it went unanswered', () => {
  const open = { state: 'open', failures: 3, openUntil: 10500, cooldownMs: 10000, probeClaimedAt: 0 };
  assert.equal(breakerStep(open, 'probe', 10499, CFG), open, 'still cooling: the same object, nothing to give');
  const half = breakerStep(open, 'probe', 10500, CFG);
  assert.deepEqual(half, { ...open, state: 'half', probeClaimedAt: 10500 });
  assert.equal(breakerStep(half, 'probe', 10500, CFG), half, 'the probe is out: no second one');
  assert.equal(breakerStep(half, 'probe', 10500 + 59999, CFG), half);
  assert.deepEqual(breakerStep(half, 'probe', 10500 + 60000, CFG), { ...half, probeClaimedAt: 70500 }, 'an unanswered probe is replaced after its lease');
  assert.equal(breakerStep(CLOSED, 'probe', 5, CFG), CLOSED, 'a closed breaker has no probe to give');
  assert.deepEqual(breakerStep(half, 'success', 11000, CFG), CLOSED);
});

test('breakerStep: a failed probe reopens with the cooldown doubled up to the maximum; a late failure while open only counts', () => {
  let b = fail(fail(fail({ ...CLOSED }, 0), 0), 0);
  const cooldowns = [];
  for (let i = 0; i < 4; i++) {
    cooldowns.push(b.cooldownMs);
    b = fail(breakerStep(b, 'probe', b.openUntil, CFG), b.openUntil);
    assert.equal(b.state, 'open');
    assert.equal(b.probeClaimedAt, 0);
  }
  assert.deepEqual(cooldowns, [10000, 20000, 40000, 40000], 'doubled, then held at the maximum');
  const late = fail(b, b.openUntil - 1);
  assert.deepEqual(late, { ...b, failures: b.failures + 1 }, 'the cooldown is not restarted by a straggler');
  const closed = breakerStep(breakerStep(b, 'probe', b.openUntil, CFG), 'success', b.openUntil, CFG);
  assert.equal(fail(fail(fail(closed, 9), 9), 9).cooldownMs, 10000, 'after a recovery the cooldown starts over');
});

test('breakerStep property: over random event sequences at most one probe is out at a time, and the state stays consistent', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  for (let run = 0; run < 200; run++) {
    let b = { ...CLOSED }, now = 0;
    for (let i = 0; i < 60; i++) {
      now += rnd(4000);
      const ev = ['failure', 'failure', 'success', 'probe', 'probe'][rnd(5)];
      const next = breakerStep(b, ev, now, CFG);
      if (ev === 'probe') {
        if (next !== b) {
          assert.equal(next.state, 'half');
          assert.ok(b.state === 'open' ? now >= b.openUntil : now - b.probeClaimedAt >= CFG.probeLeaseMs, 'a probe is only given after the cooldown or the lease');
        } else if (b.state === 'half') assert.ok(now - b.probeClaimedAt < CFG.probeLeaseMs, 'while one is out there is none to give');
        else assert.ok(b.state === 'closed' || now < b.openUntil);
      }
      assert.ok(['closed', 'open', 'half'].includes(next.state));
      assert.ok(next.state !== 'open' || next.openUntil > 0);
      assert.ok(next.state !== 'closed' || next.probeClaimedAt === 0);
      assert.ok(next.cooldownMs <= CFG.maxCooldownMs);
      b = next;
    }
  }
});

test('breakerEvent: a retryable failure counts, anything else the provider answered is a sign of life', () => {
  assert.equal(breakerEvent({ kind: 'retry' }), 'failure');
  assert.equal(breakerEvent({ kind: 'sent' }), 'success');
  assert.equal(breakerEvent({ kind: 'permanent' }), 'success', 'a 4xx never trips the breaker');
});

const POLICY = { idempotent: true, retry: { max: 3, baseMs: 1000, capMs: 8000, jitter: 0 } };
const ctx = (extra = {}) => ({ policy: POLICY, now: 50000, idemKey: 'k', ...extra });
const fault = (kind, message = 'x') => Object.assign(new Error(message), { fault: kind });

test('settle: what a delivery came to, as the patch to write and the breaker event', () => {
  const row = { attempts: 0 };
  assert.deepEqual(settle(row, { status: 'sent', code: 200, error: null }, null, ctx()),
    { patch: { status: 'sent', code: 200, error: null, attempts: 1, nextAttemptAt: null }, event: 'success' });
  assert.deepEqual(settle(row, { status: 'failed', code: 503, error: 'HTTP 503', retryAfter: '5' }, null, ctx()),
    { patch: { status: 'queued', code: 503, error: 'HTTP 503', attempts: 1, nextAttemptAt: 55000 }, event: 'failure' }, 'Retry-After is used and never written');
  assert.deepEqual(settle({ attempts: 2 }, { status: 'failed', code: 500, error: 'HTTP 500' }, null, ctx()),
    { patch: { status: 'failed', code: 500, error: 'HTTP 500 (gave up after 3 attempts)', attempts: 3, nextAttemptAt: null }, event: 'failure' });
  assert.deepEqual(settle(row, { status: 'failed', code: 404, error: 'HTTP 404' }, null, ctx()),
    { patch: { status: 'failed', code: 404, error: 'HTTP 404', attempts: 1, nextAttemptAt: null }, event: 'success' });
  assert.deepEqual(settle(row, {}, fault('timeout', 'no answer within 3000 ms'), ctx({ policy: { ...POLICY, idempotent: false } })),
    { patch: { status: 'unknown', code: null, error: 'no answer within 3000 ms; the request may have landed, so it is not retried', attempts: 1, nextAttemptAt: null }, event: 'failure' });
  assert.deepEqual(settle(row, {}, fault('unsent', 'connect ECONNREFUSED'), ctx({ policy: { ...POLICY, idempotent: false } })),
    { patch: { status: 'queued', code: null, error: 'connect ECONNREFUSED', attempts: 1, nextAttemptAt: 51000 }, event: 'failure' });
});

test('settle: a failure that is not the provider\'s answer is final and tells the breaker nothing', () => {
  const row = { attempts: 0 };
  assert.deepEqual(settle(row, {}, new Error('the request url must start with http://'), ctx()),
    { patch: { status: 'failed', code: null, error: 'the request url must start with http://', attempts: 1, nextAttemptAt: null }, event: null });
  assert.deepEqual(settle(row, { status: 'failed', code: null, error: 'smtp down' }, null, ctx()),
    { patch: { status: 'failed', code: null, error: 'smtp down', attempts: 1, nextAttemptAt: null }, event: null });
});

test('policyOf reads idempotence and the overrides from the descriptor of the row\'s kind', () => {
  const registry = { descriptors: { d: { retry: { max: 2 }, breaker: { threshold: 1 }, legacy: 'send', operations: { send: { idempotent: false }, get: { idempotent: true } } } } };
  assert.deepEqual(policyOf(registry, { kind: 'd', op: 'get' }), { idempotent: true, retry: { max: 2 }, breaker: { threshold: 1 } });
  assert.equal(policyOf(registry, { kind: 'd', op: null }).idempotent, false, 'a legacy row is the legacy operation');
  assert.equal(policyOf(registry, { kind: 'd', op: 'missing' }).idempotent, false);
  assert.deepEqual(policyOf(registry, { kind: 'mail' }), { idempotent: false });
});

test('the clock: the system one is real, and an options bag may override only `now`', () => {
  assert.ok(Math.abs(systemClock.now() - Date.now()) < 1000);
  let fired = 0;
  const h = systemClock.setTimer(() => { fired++; }, 1);
  assert.equal(typeof h.unref, 'function');
  systemClock.clear(systemClock.setTimer(() => { fired++; }, 1));
  assert.equal(resolveClock().now, systemClock.now);
  assert.equal(resolveClock({ now: () => 5 }).now(), 5);
  assert.equal(resolveClock({ now: () => 5 }).setTimer, systemClock.setTimer);
  const own = { now: () => 9 };
  assert.equal(resolveClock({ clock: own, now: () => 5 }), own);
  return new Promise((r) => setTimeout(() => { assert.equal(fired, 1, 'the cleared timer never fires'); r(); }, 30));
});
