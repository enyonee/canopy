// S4: await-first. The store and the driver stay synchronous; what changes is that every caller awaits them,
// so S5 can make them Promises without touching a caller. These tests pin what S4 added on the way: the
// transaction view, a transaction whose callback awaits, and a server that listens only when it is ready.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../runtime/store.mjs';
import { serve } from '../runtime/server.mjs';
import { tmpDir } from './helpers.mjs';

const GRAPH = { app: 't', data: { Item: { title: 'text!' } } };

test('S4: a transaction hands its callback the transaction view, which with the synchronous driver is the store itself', () => {
  const store = new Store(GRAPH, ':memory:');
  let seen = null;
  const out = store.transaction((tx) => { seen = tx; return tx.insert('Item', { title: 'a' }); });
  assert.equal(seen, store);
  assert.equal(store.within(store.drv), store, 'within(tx) is where S5 binds the driver handle; here it is the identity');
  assert.equal(out, 1, 'a synchronous callback is still answered with its plain value');
  assert.equal(store.count('Item'), 1);
});

test('S4: a transaction whose callback awaits commits after the work, and rolls back a failure that comes after an await', async () => {
  const store = new Store(GRAPH, ':memory:');
  const sql = [];
  store.drv.onQuery = (q) => sql.push(q.trim().split(/\s+/)[0]);
  const id = await store.transaction(async (tx) => { await null; await new Promise((r) => setImmediate(r)); return await tx.insert('Item', { title: 'late' }); });
  store.drv.onQuery = null;
  assert.deepEqual(sql.filter((q) => ['BEGIN', 'INSERT', 'COMMIT'].includes(q)), ['BEGIN', 'INSERT', 'COMMIT'], 'the commit waits for the callback');
  assert.equal(id, 1);
  await assert.rejects(store.transaction(async (tx) => { await tx.insert('Item', { title: 'gone' }); await null; throw new Error('after an await'); }), /after an await/);
  assert.equal(store.count('Item'), 1, 'what an async callback wrote before it threw is rolled back');
  assert.deepEqual(store.list('Item', {}).map((r) => r.title), ['late']);
});

test('S4: serve() listens only when it is ready: the store is migrated and seeded before the first request can arrive', async (t) => {
  const dir = tmpDir('ag-ready-', t);
  const graphFile = path.join(dir, 'app.json');
  fs.writeFileSync(graphFile, JSON.stringify({ app: 'r', data: { Item: { title: 'text!' } }, seed: { Item: [{ title: 'one' }, { title: 'two' }] } }));
  // A store that answers a macrotask late, like a driver that really is asynchronous.
  const insert = Store.prototype.insert;
  Store.prototype.insert = function slow(...a) { const r = insert.apply(this, a); return new Promise((res) => setImmediate(() => res(r))); };
  let app;
  try {
    app = serve({ graphFile, dbFile: path.join(dir, 'd.sqlite'), traceFile: null, port: 0, noTimers: true });
    assert.equal(app.server.listening, false, 'nothing listens before ready');
    await once(app.server, 'listening');
    assert.equal(app.store.count('Item'), 2, 'the seed was in before the server started listening');
    assert.equal(await app.ready, app, 'ready resolves to the app');
    assert.equal(app.invalid, false);
  } finally {
    Store.prototype.insert = insert;
    app?.server.close();
  }
});
