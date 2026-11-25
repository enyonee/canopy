// SEC3: a one-hop `own` ("order.customer") scopes writes the way it scopes reads. A create, an edit
// and a related add may only leave a row the writer owns: a reference to another user's parent is a
// 403, by the same denial every other refused operation takes — HTML and JSON alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.mjs';
import { Store } from '../runtime/store.mjs';
import { permissions } from '../runtime/auth.mjs';
import fs from 'node:fs';

const FIXTURE = 'tests/fixtures/ownhop.json';
const JSON_H = { accept: 'application/json' };

async function asB() {
  const app = await boot(FIXTURE, { noTimers: true });
  await app.login('b@x.test', 'pw-b');
  return app;
}
const itemCount = async (app) => (await app.app.store.listRaw('OrderItem')).length;

test('SEC3: create of a one-hop owned row on another user\'s parent is refused, on your own parent it goes through', async (t) => {
  const app = await asB(); t.after(app.close);
  const before = await itemCount(app);
  assert.equal((await app.post('/OrderItem', { name: 'sneak', order: '1' })).status, 403, 'HTML: into A\'s order');
  const j = await app.post('/OrderItem', { name: 'sneak', order: '1' }, JSON_H);
  assert.equal(j.status, 403);
  assert.deepEqual(JSON.parse(j.html), { ok: false, status: 403, errors: ['You are not allowed to do this.'] });
  assert.equal(await itemCount(app), before, 'nothing was written into A\'s order');
  assert.equal((await app.post('/OrderItem', { name: 'orphan' })).status, 403, 'a row with no parent is owned by nobody, so not by the writer');
  assert.equal(app.trace().filter((e) => e.kind === 'denied').length, 3, 'each refusal is traced like every other denial');
  assert.equal((await app.post('/OrderItem', { name: 'mine', order: '2' })).status, 303, 'into B\'s own order');
  const ok = JSON.parse((await app.post('/OrderItem', { name: 'mine too', order: '2' }, JSON_H)).html);
  assert.equal(ok.ok, true);
  assert.equal(await itemCount(app), before + 2);
});

test('SEC3: an edit may not move a one-hop owned row onto another user\'s parent', async (t) => {
  const app = await asB(); t.after(app.close);
  assert.equal((await app.post('/OrderItem/2', { name: 'moved', order: '1' })).status, 403, 'HTML');
  assert.equal((await app.post('/OrderItem/2', { name: 'moved', order: '1' }, JSON_H)).status, 403, 'JSON');
  assert.deepEqual({ ...await app.app.store.raw('OrderItem', 2) }, { id: 2, name: 'item of B', order: '2' }, 'the row is untouched');
  assert.equal((await app.post('/OrderItem/2', { name: 'renamed' })).status, 303, 'an edit that keeps the parent goes through');
  assert.equal((await app.post('/OrderItem/2', { name: 'renamed again', order: '2' }, JSON_H)).status, 200);
  assert.equal((await app.app.store.raw('OrderItem', 2)).name, 'renamed again');
  assert.equal((await app.post('/OrderItem/1', { name: 'theirs' })).status, 403, 'another user\'s row stays closed, as before');
});

test('SEC3: a related add under another user\'s parent is refused even when that parent is visible to all', async (t) => {
  const app = await asB(); t.after(app.close);
  assert.equal((await app.get('/Order/1')).status, 200, 'Order is "all": ["view"], so B sees A\'s order');
  const before = await itemCount(app);
  assert.equal((await app.post('/Order/1/add/OrderItem', { name: 'sneak' })).status, 403, 'HTML');
  assert.equal((await app.post('/Order/1/add/OrderItem', { name: 'sneak' }, JSON_H)).status, 403, 'JSON');
  assert.equal(await itemCount(app), before);
  assert.equal((await app.post('/Order/2/add/OrderItem', { name: 'mine' })).status, 303);
  assert.equal(JSON.parse((await app.post('/Order/2/add/OrderItem', { name: 'mine too' }, JSON_H)).html).ok, true);
  assert.equal(await itemCount(app), before + 2);
});

test('SEC3: an own array owns the new row by any of its paths; a direct own still fills and still writes', async (t) => {
  const app = await asB(); t.after(app.close);
  assert.equal((await app.post('/Note', { text: 'x', order: '1' })).status, 403, 'neither path is B');
  assert.equal((await app.post('/Note', { text: 'x', order: '1' }, JSON_H)).status, 403);
  assert.equal((await app.post('/Note', { text: 'helping', order: '1', helper: '2' })).status, 303, 'owned through "helper"');
  assert.equal((await app.post('/Note', { text: 'mine', order: '2' }, JSON_H)).status, 200, 'owned through "order.customer"');
  const note = (await app.app.store.listRaw('Note')).find((n) => n.text === 'helping');
  assert.equal((await app.post(`/Note/${note.id}`, { helper: '1' })).status, 403, 'giving the row away to someone else is not an owned write');
  const order = JSON.parse((await app.post('/Order', { title: 'new', customer: '1' }, JSON_H)).html);
  assert.equal(order.ok, true, 'direct own: the fillable field is filled with the writer');
  assert.equal(String((await app.app.store.raw('Order', order.id)).customer), '2');
  assert.equal((await app.post(`/Order/${order.id}`, { title: 'renamed' }, JSON_H)).status, 200);
});

test('SEC3: the write check reads each parent in one query, and nothing for a direct own or an admin', async () => {
  const graph = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const store = new Store(graph, ':memory:');
  await store.insert('User', { email: 'a', password: 'x', role: 'customer' });
  await store.insert('User', { email: 'b', password: 'x', role: 'customer' });
  await store.insert('User', { email: 'c', password: 'x', role: 'admin' });
  await store.insert('Order', { title: 'A', customer: 1 });
  const perms = permissions(graph, store);
  const [a, b, admin] = [await store.get('User', 1), await store.get('User', 2), await store.get('User', 3)];
  const count = async (fn) => { const q = []; store.drv.onQuery = (sql) => q.push(sql); const v = await fn(); store.drv.onQuery = null; return [v, q.length]; };
  assert.deepEqual(await count(() => perms.mayWrite(a, 'Note', 'create', { text: 't', order: '1' })), [true, 1], 'two paths over one reference: one query');
  assert.deepEqual(await count(() => perms.mayWrite(b, 'Note', 'create', { text: 't', order: '1' })), [false, 1]);
  assert.deepEqual(await count(() => perms.mayWrite(b, 'OrderItem', 'edit', { id: 9, name: 'n', order: 1 })), [false, 1]);
  assert.deepEqual(await count(() => perms.mayWrite(b, 'Order', 'create', { title: 't', customer: 2 })), [true, 0], 'a direct own reads nothing');
  assert.deepEqual(await count(() => perms.mayWrite(admin, 'OrderItem', 'create', { name: 'n', order: 1 })), [true, 0], 'no own grant, no check');
  assert.equal(await permissions(graph, store).mayWrite(b, 'Order', 'create', { title: 't', customer: 1 }), false, 'a direct own that names someone else is not owned');
  assert.equal(await permissions({ app: 'x', data: {} }).mayWrite(null, 'X', 'create', {}), true, 'without /roles every write is allowed');
});
