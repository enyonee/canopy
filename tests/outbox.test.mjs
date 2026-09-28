import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { open } from '../runtime/driver.mjs';
import { deliver, flush, LEASE_MS } from '../runtime/outbox.mjs';
import { DEFAULT } from '../runtime/registry.mjs';
import { outboxView } from '../runtime/render/pages.mjs';
import { fakeFetch, tmpDir } from './helpers.mjs';

const graph = {
  app: 'o', data: { A: { n: 'text' } },
  connectors: { hook: { kind: 'http', url: 'http://sink.test/h', method: 'PUT', headers: { 'x-k': '1' }, timeout: 50 }, mail: { kind: 'mail', from: 'a@b' } },
};
const fresh = () => new Store(graph, ':memory:');

test('an http delivery carries method, headers and JSON body, and records the answer', async () => {
  const store = fresh();
  const net = fakeFetch();
  const events = [];
  const id = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/h/x', payload: { a: 1 } });
  assert.equal(store.outboxGet(id).status, 'queued');
  assert.equal(await deliver(store, graph, store.outboxGet(id), { fetchImpl: net.fetchImpl, trace: (e) => events.push(e) }), 'sent');
  const call = net.calls[0];
  assert.equal(call.url, 'http://sink.test/h/x');
  assert.equal(call.method, 'PUT');
  assert.equal(call.headers['x-k'], '1');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(call.body, { a: 1 });
  const row = store.outboxGet(id);
  assert.equal(row.status, 'sent');
  assert.equal(row.code, 200);
  assert.equal(row.attempts, 1);
  assert.equal(row.error, null);
  assert.deepEqual(row.payload, { a: 1 });
  assert.equal(events[0].kind, 'delivery');
  assert.equal(events[0].status, 'sent');
});

test('a non-2xx answer and a thrown request are both failures with a reason', async () => {
  const store = fresh();
  const net = fakeFetch();
  net.state.status = 503;
  const a = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/h', payload: null });
  assert.equal(await deliver(store, graph, store.outboxGet(a), { fetchImpl: net.fetchImpl }), 'failed');
  assert.equal(store.outboxGet(a).error, 'HTTP 503');
  assert.equal(store.outboxGet(a).code, 503);
  net.state.throwWith = 'connect ECONNREFUSED';
  const b = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/h', payload: {} });
  assert.equal(await deliver(store, graph, store.outboxGet(b), { fetchImpl: net.fetchImpl }), 'failed');
  assert.equal(store.outboxGet(b).error, 'connect ECONNREFUSED');
  assert.equal(store.outboxGet(b).code, null, 'no code when nothing answered');
  net.state.throwWith = null; net.state.status = 200;
  store.outboxUpdate(b, { status: 'queued' });
  assert.equal(await deliver(store, graph, store.outboxGet(b), { fetchImpl: net.fetchImpl }), 'sent');
  assert.equal(store.outboxGet(b).attempts, 2, 'a retry counts');
});

test('mail is recorded by the stand transport; an unknown kind fails loudly', async () => {
  const store = fresh();
  const m = store.enqueue({ kind: 'mail', connector: 'mail', target: 'x@y', payload: { subject: 's' } });
  assert.equal(await deliver(store, graph, store.outboxGet(m), { fetchImpl: () => { throw new Error('must not be called'); } }), 'sent');
  assert.equal(store.outboxGet(m).code, null);
  const u = store.enqueue({ kind: 'pigeon', connector: 'mail', target: 'x', payload: null });
  assert.equal(await deliver(store, graph, store.outboxGet(u), {}), 'failed');
  assert.match(store.outboxGet(u).error, /unknown delivery kind "pigeon"/);
  const orphan = store.enqueue({ kind: 'http', connector: 'gone', target: 'http://sink.test', payload: null });
  const net = fakeFetch();
  assert.equal(await deliver(store, graph, store.outboxGet(orphan), { fetchImpl: net.fetchImpl }), 'sent', 'a missing connector still delivers with defaults');
  assert.equal(net.calls[0].method, 'POST');
});

test('flush delivers everything queued, oldest first, and leaves the rest alone', async () => {
  const store = fresh();
  const net = fakeFetch();
  const first = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/1', payload: 1 });
  const second = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/2', payload: 2 });
  store.outboxUpdate(first, { status: 'sent' });
  const done = store.enqueue({ kind: 'mail', connector: 'mail', target: 'a', payload: null });
  const third = store.enqueue({ kind: 'http', connector: 'hook', target: 'http://sink.test/3', payload: 3 });
  assert.deepEqual(await flush(store, graph, { fetchImpl: net.fetchImpl }), ['sent', 'sent', 'sent']);
  assert.deepEqual(net.calls.map((c) => c.url), ['http://sink.test/2', 'http://sink.test/3'], 'already sent rows are not resent');
  assert.equal(store.outboxGet(second).status, 'sent');
  assert.equal(store.outboxGet(done).status, 'sent');
  assert.equal(store.outboxGet(third).status, 'sent');
  assert.deepEqual(await flush(store, graph, { fetchImpl: net.fetchImpl }), [], 'nothing left');
  assert.equal(store.outbox().length, 4);
  assert.equal(store.outbox({ status: 'queued' }).length, 0);
  assert.equal(store.outboxGet(999), null);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slowRegistry = (calls, ms = 15) => ({ ...DEFAULT, transports: { ...DEFAULT.transports, http: { deliver: async (row) => { calls.push(row.id); await sleep(ms); return { status: 'sent', code: 200, error: null }; } } } });
const queue = (store, n) => Array.from({ length: n }, (_, i) => store.enqueue({ kind: 'http', connector: 'hook', target: `http://sink.test/${i}`, payload: i }));

test('two overlapping flushes deliver every row exactly once', async () => {
  const store = fresh();
  const ids = queue(store, 4);
  const calls = [];
  const registry = slowRegistry(calls);
  const [a, b] = await Promise.all([flush(store, graph, { registry }), flush(store, graph, { registry })]);
  assert.deepEqual(calls.slice().sort(), ids.slice().sort(), 'each row was delivered once');
  assert.equal(a.length + b.length, 4, 'and reported by exactly one of the flushes');
  assert.ok(a.length > 0 && b.length > 0, 'the work was shared, not serialised');
  assert.deepEqual(store.outbox().map((r) => [r.status, r.attempts]), ids.map(() => ['sent', 1]));
});

test('a claim goes to one caller only, and never to a row that is not queued', () => {
  const store = fresh();
  const [id] = queue(store, 1);
  assert.equal(store.outboxClaim(id, 1000, LEASE_MS), true);
  assert.equal(store.outboxClaim(id, 1000, LEASE_MS), false, 'already sending');
  assert.equal(store.outboxGet(id).status, 'sending');
  assert.equal(store.outboxGet(id).claimedAt, 1000);
  store.outboxUpdate(id, { status: 'sent' });
  assert.equal(store.outboxClaim(id, 1000 + 10 * LEASE_MS, LEASE_MS), false, 'sent is never claimable');
  assert.equal(store.outboxClaim(999, 0, LEASE_MS), false, 'no such row');
});

test('a stale sending row is delivered again after the lease and not before', async () => {
  const store = fresh();
  const [id] = queue(store, 1);
  assert.equal(store.outboxClaim(id, 1000, LEASE_MS), true, 'a process claims it, then dies');
  const calls = [];
  const registry = slowRegistry(calls, 0);
  assert.deepEqual(await flush(store, graph, { registry, now: () => 1000 + LEASE_MS - 1 }), []);
  assert.deepEqual(calls, [], 'the lease has not run out');
  assert.deepEqual(await flush(store, graph, { registry, now: () => 1000 + LEASE_MS }), ['sent']);
  assert.deepEqual(calls, [id]);
  assert.equal(store.outboxGet(id).attempts, 1);
  assert.deepEqual(await flush(store, graph, { registry, now: () => 1000 + 5 * LEASE_MS }), [], 'and then it is done');
});

test('a slow delivery whose lease ran out and was re-claimed cannot overwrite the new owner', async () => {
  const store = fresh();
  const [id] = queue(store, 1);
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const registry = { ...DEFAULT, transports: { ...DEFAULT.transports, http: { deliver: async () => {
    const mine = ++n;
    if (mine === 1) await gate;
    return { status: mine === 1 ? 'failed' : 'sent', code: mine === 1 ? 500 : 200, error: mine === 1 ? 'slow' : null };
  } } } };
  const events = [];
  const first = flush(store, graph, { registry, now: () => 1000, trace: (e) => events.push(e) });
  await sleep(5);
  assert.deepEqual(await flush(store, graph, { registry, now: () => 1000 + LEASE_MS, trace: (e) => events.push(e) }), ['sent']);
  release();
  assert.deepEqual(await first, ['stale'], 'the late delivery reports that it lost the claim');
  const row = store.outboxGet(id);
  assert.deepEqual([row.status, row.code, row.error, row.claimedAt, row.attempts], ['sent', 200, null, 1000 + LEASE_MS, 1]);
  assert.deepEqual(events.filter((e) => e.stale).map((e) => [e.kind, e.id]), [['delivery', id]]);
  assert.equal(events.filter((e) => !e.stale).length, 1, 'only the winner is traced as a result');
});

test('outboxFinish writes only while the claim is the caller\'s', () => {
  const store = fresh();
  const [id] = queue(store, 1);
  assert.equal(store.outboxFinish(id, 1000, { status: 'sent' }), false, 'not claimed yet');
  store.outboxClaim(id, 1000, LEASE_MS);
  assert.equal(store.outboxFinish(id, 999, { status: 'sent' }), false, 'someone else\'s claim time');
  assert.equal(store.outboxGet(id).status, 'sending');
  assert.equal(store.outboxFinish(id, 1000, { status: 'sent' }), true);
  assert.equal(store.outboxFinish(id, 1000, { status: 'failed' }), false, 'already finished');
  assert.equal(store.outboxGet(id).status, 'sent');
});

test('a database made before "claimedAt" existed is upgraded in place, rows kept', () => {
  const file = path.join(tmpDir('outbox-'), 'old.sqlite');
  const old = open(file);
  old.exec(`CREATE TABLE "_outbox" (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, connector TEXT,
    target TEXT, payload TEXT, status TEXT, code INTEGER, error TEXT, attempts INTEGER DEFAULT 0, at TEXT, updatedAt TEXT)`);
  old.run(`INSERT INTO "_outbox" (kind, connector, target, payload, status, attempts) VALUES ('http','hook','http://sink.test/o','1','queued',0)`);
  old.close();
  const store = new Store(graph, file);
  assert.equal(store.outboxGet(1).claimedAt, null);
  assert.equal(store.outboxClaim(1, 5, LEASE_MS), true);
  assert.equal(new Store(graph, file).outboxGet(1).claimedAt, 5, 'a second boot finds the column and changes nothing');
  store.drv.close();
});

test('the outbox screen shows a sending row and offers no retry for it', () => {
  const rows = [{ id: 1, kind: 'http', connector: 'hook', target: 't', status: 'sending', payload: null, updatedAt: 'x' }];
  const html = outboxView(graph, rows, null);
  assert.match(html, /<span class="status">sending<\/span>/);
  assert.doesNotMatch(html, /retry/);
});
