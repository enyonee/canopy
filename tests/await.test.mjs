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
import { createRegistry, register, loadPlugins } from '../runtime/registry.mjs';
import { validate } from '../runtime/validate.mjs';
import { openSqlite } from '../runtime/driver/sqlite.mjs';
import { createInterpreter } from '../runtime/interp.mjs';
import { DEFAULT } from '../runtime/registry.mjs';
import { tmpDir } from './helpers.mjs';

const GRAPH = { app: 't', data: { Item: { title: 'text!' } } };

test('S4: a transaction hands its callback the transaction view, which with the synchronous driver is the store itself', async () => {
  const store = new Store(GRAPH, ':memory:');
  let seen = null;
  const out = await store.transaction(async (tx) => { seen = tx; return await tx.insert('Item', { title: 'a' }); });
  assert.equal(seen, store);
  assert.equal(store.within(store.drv), store, 'within(tx) is where S5 binds the driver handle; here it is the identity');
  assert.equal(out, 1, 'a synchronous callback is still answered with its plain value');
  assert.equal(await store.count('Item'), 1);
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
  assert.equal(await store.count('Item'), 1, 'what an async callback wrote before it threw is rolled back');
  assert.deepEqual((await store.list('Item', {})).map((r) => r.title), ['late']);
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
    assert.equal(await app.store.count('Item'), 2, 'the seed was in before the server started listening');
    assert.equal(await app.ready, app, 'ready resolves to the app');
    assert.equal(app.invalid, false);
  } finally {
    Store.prototype.insert = insert;
    app?.server.close();
  }
});

// --- the plugin marker ------------------------------------------------------------------------------------------------
const BLOCK = { summary: 'x', effects: ['db.write'], requires: [], run: async () => ({}) };

test('S4: a plugin with blocks is legacy until it exports async: true (or api: 2); one without blocks never is', () => {
  const r = createRegistry();
  assert.deepEqual(r.legacy, []);
  register(r, { blocks: { 'a.one': BLOCK } }, 'old.mjs');
  register(r, { async: true, blocks: { 'b.one': BLOCK } }, 'new.mjs');
  register(r, { api: 2, blocks: { 'c.one': BLOCK } }, 'v2.mjs');
  register(r, { async: false, blocks: { 'd.one': BLOCK } }, 'no.mjs');
  register(r, { functions: { inc: { arity: 1, kind: () => 'number', run: ([n]) => n + 1 } } }, 'pure.mjs');
  assert.deepEqual(r.legacy, ['old.mjs', 'no.mjs'], 'only a plugin with blocks and no marker');
});

test('S4: an asynchronous driver refuses a plugin that is not marked, naming it; the synchronous one does not', async (t) => {
  const dir = tmpDir('ag-marker-', t);
  const write = (name, source) => { fs.writeFileSync(path.join(dir, name), source); return `./${name}`; };
  const legacy = write('legacy.mjs', `export default { blocks: { 'legacy.noop': { summary: 'x', effects: [], requires: [], run: () => ({}) } } };`);
  const marked = write('marked.mjs', `export default { async: true, blocks: { 'marked.noop': { summary: 'x', effects: [], requires: [], run: async () => ({}) } } };`);
  const graph = { app: 'm', data: { Item: { title: 'text!' } }, plugins: [marked, legacy] };
  const { registry, errors } = await loadPlugins(graph, dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(validate(graph, registry), [], 'SQLite answers plain values: an unmarked plugin still works');
  assert.deepEqual(validate(graph, registry, { asyncDriver: false }), []);
  const refused = validate(graph, registry, { asyncDriver: true });
  assert.equal(refused.length, 1);
  assert.equal(refused[0].path, '/plugins/1', 'it names the entry of /plugins');
  assert.match(refused[0].message, /plugin ".\/legacy\.mjs" is written for a synchronous store/);
  assert.match(refused[0].hint, /export `async: true`/);
  assert.deepEqual(validate({ ...graph, plugins: [marked] }, (await loadPlugins({ ...graph, plugins: [marked] }, dir)).registry, { asyncDriver: true }), [], 'a marked plugin passes');
  assert.equal(validate({ ...graph, plugins: { not: 'a list' } }, registry, { asyncDriver: true })[0].path, '/plugins', 'a bad /plugins is the checker\'s own error');
  assert.equal(openSqlite(':memory:').async, false, 'the SQLite driver says it is synchronous');
  const stray = createRegistry();
  stray.legacy.push('elsewhere.mjs');
  assert.equal(validate({ app: 'm', data: { Item: { title: 'text!' } } }, stray, { asyncDriver: true })[0].path, '/plugins', 'a legacy plugin the graph does not list is still reported');
});

test('S4: resolve answers a promise per value and keeps the order of a list and of an object; text and afterPath load before they format', async () => {
  const graph = { app: 'r', data: { Item: { title: 'text!', qty: 'int=1' } } };
  const store = new Store(graph, ':memory:');
  const id = await store.insert('Item', { title: 'one', qty: 2 });
  const interp = createInterpreter({ graph, store, registry: DEFAULT, perms: {}, meId: 1 });
  const ctx = { rowEntity: 'Item', id, row: await store.get('Item', id), values: { a: 5 }, user: null };
  const pending = interp.resolve(ctx)(['@row.title', '= qty + 1', '@values.a', 'lit', { t: '@row.title', n: '= qty * 10' }]);
  assert.ok(pending instanceof Promise, 'resolving may load, so it answers a promise');
  assert.deepEqual(await pending, ['one', 3, 5, 'lit', { t: 'one', n: 20 }], 'in the order they were written');
  assert.equal(await interp.interpolate('{row.title} x{row.qty}', ctx), 'one x2');
  const sql = [];
  store.drv.onQuery = (q) => sql.push(q);
  assert.equal(await interp.afterPath('/Item/{id}?t={title}&n={qty}&c={created}', 'Item', id, { created: 9 }), `/Item/${id}?t=one&n=2&c=9`);
  assert.equal(sql.length, 1, 'the row is read once, before the replace');
  assert.equal(await interp.afterPath('/Item/{id}', 'Item', id), `/Item/${id}`);
  assert.equal(sql.length, 1, 'and not at all when no placeholder needs it');
  store.drv.onQuery = null;
});
