import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { deliver, flush } from '../runtime/outbox.mjs';
import { fakeFetch } from './helpers.mjs';

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
