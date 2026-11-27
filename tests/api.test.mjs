// F1: /api/* — the JSON routes under one prefix (runtime/routes/api.mjs). The same route runs (permissions, own scoping,
// validation, effects); the answer is always JSON; a POST must come from this site with a JSON body.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, tmpGraph } from './helpers.mjs';
import { openapiText } from '../runtime/contract.mjs';
import { loadPlugins } from '../runtime/registry.mjs';

const J = { accept: 'application/json' };
// An /api answer less the reference captions only /api adds: the Accept-mode answer.
const unlabel = (v) => (Array.isArray(v) ? v.map(unlabel) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== '_labels').map(([k, x]) => [k, unlabel(x)])) : v);
const same = (api, old) => assert.deepEqual(unlabel(JSON.parse(api)), JSON.parse(old));
let s;
before(async () => { s = await boot('apps/shop/app.json'); });
after(() => s.close());

test('F1: api: a read under /api is the Accept-mode answer plus reference captions, JSON without asking', async () => {
  s.asGuest();
  for (const p of ['/Product', '/Product/1', '/Product?q=mug', '/Product?category=2&sort=price&dir=desc']) {
    const old = await s.get(p, J), now = await s.get(`/api${p}`);
    assert.equal(now.status, 200, p);
    same(now.html, old.html);
    assert.match(now.headers.get('content-type'), /^application\/json/);
  }
  assert.deepEqual(JSON.parse((await s.get('/api/Product/1')).html)._labels, { category: 'Mugs' });
  const missing = await s.get('/api/Product/99');
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.html), { ok: false, status: 404, errors: ['no Product #99'] });
});

test('F1: api: a refusal is a JSON 403, never the login redirect the old path gives a guest', async () => {
  s.asGuest();
  const old = await s.get('/Order');
  assert.equal(old.status, 303, 'the form path is unchanged');
  const r = await s.get('/api/Order');
  assert.equal(r.status, 403);
  assert.deepEqual(JSON.parse(r.html), { ok: false, status: 403, errors: ['You are not allowed to do this.'] });
});

test('F1: api: only the JSON routes are under the prefix; everything else is a JSON 404', async () => {
  await s.login('admin@shop.test', 'admin123');
  for (const p of ['/api', '/api/', '/api/Product/new', '/api/Product/1/edit', '/api/Product.csv', '/api/outbox', '/api/settings', '/api/page/x',
    '/api/login', '/api/widget/_api.mjs', '/api/file/Product/1/x', '/api/Ghost', '/api/action/x', '/api/Product/1/go/x/y']) {
    const r = await s.get(p);
    assert.equal(r.status, 404, p);
    assert.equal(JSON.parse(r.html).ok, false, p);
  }
  const put = await fetch(`${s.base}/api/Product`, { method: 'PUT' });
  assert.equal(put.status, 404);
  for (const p of ['/api/Product/1/edit', '/api/dashboard/sales/x', '/api/me', '/api/search', '/api/Product/1/nope/x']) assert.equal((await s.json(p, {})).status, 404, p);
});

test('F1: api: a POST needs this site\'s Origin (else Referer) and a JSON object; nothing is written otherwise', async () => {
  await s.login('admin@shop.test', 'admin123');
  const before = (await s.get('/api/Product')).html;
  const refused = [
    [{ origin: '' }, 403], [{ origin: 'http://evil.test' }, 403], [{ origin: 'null' }, 403],
    [{ origin: undefined }, 403], [{ origin: undefined, referer: 'http://evil.test/x' }, 403], [{ origin: undefined, referer: 'not a url' }, 403], [{ 'content-type': 'application/x-www-form-urlencoded' }, 415],
    [{ 'content-type': 'text/plain' }, 415],
  ];
  for (const [h, code] of refused) {
    const r = await s.json('/api/Product', { name: 'X', price: 1 }, h);
    assert.equal(r.status, code, JSON.stringify(h));
    assert.equal(r.body.ok, false);
  }
  assert.equal((await s.json('/api/Product', null, {}, { raw: '{"name":' })).body.errors[0], 'the body is not JSON');
  assert.equal((await s.json('/api/Product', [1])).body.errors[0], 'the body must be a JSON object');
  assert.equal((await s.json('/api/Product', null)).status, 400);
  assert.match((await s.json('/api/Product', { name: { a: 1 } })).body.errors[0], /"name" must be a string/);
  const big = await s.json('/api/Product', null, {}, { raw: JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 10) }) });
  assert.equal(big.status, 413);
  assert.equal((await s.get('/api/Product')).html, before, 'no refused POST wrote anything');
  assert.ok(s.trace().some((e) => e.kind === 'denied' && e.path === '/api/Product'));
  const viaReferer = await s.json('/api/Category', { name: 'Cards' }, { origin: undefined, referer: `${s.base}/shop` });
  assert.equal(viaReferer.status, 200, 'the Referer stands in for a missing Origin');
  const charset = await s.json('/api/Category', { name: 'Pins' }, { 'content-type': 'Application/JSON; charset=utf-8' });
  assert.equal(charset.status, 200);
});

test('F1: api: sign in, who am I, sign out — the session cookie is the form path\'s, the answers are JSON', async () => {
  s.asGuest();
  assert.deepEqual(JSON.parse((await s.get('/api/me')).html), { user: null, role: 'guest' });
  const wrong = await s.json('/api/login', { login: 'admin@shop.test', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, { ok: false, status: 401, errors: ['Wrong login or password'] });
  assert.equal(wrong.headers.get('set-cookie'), null);
  const r = await s.json('/api/login', { login: 'admin@shop.test', password: 'admin123' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^ag_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.equal(r.body.flash, 'Welcome, admin@shop.test');
  assert.equal(r.body.role, 'admin');
  assert.deepEqual(r.body.user, { id: 1, email: 'admin@shop.test', name: 'Admin', role: 'admin', discount: 0, points: 0, _labels: {} }, 'never the password');
  const me = JSON.parse((await s.get('/api/me')).html);
  assert.deepEqual(me, { user: r.body.user, role: 'admin' });
  const out = await s.json('/api/logout', {});
  assert.deepEqual(out.body, { ok: true, flash: 'Signed out', user: null, role: 'guest' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(JSON.parse((await s.get('/api/me')).html).user, null);
});

test('F1: api: register is the form path — the role is the graph\'s, a taken login is a 400', async () => {
  s.asGuest();
  const r = await s.json('/api/register', { email: 'ann@shop.test', password: 'pw', name: 'Ann', role: 'admin' });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'customer', 'a body cannot choose its role');
  assert.equal(r.body.user.email, 'ann@shop.test');
  assert.match(r.headers.get('set-cookie'), /^ag_session=/);
  s.asGuest();
  const again = await s.json('/api/register', { email: 'ann@shop.test', password: 'pw', name: 'Ann' });
  assert.equal(again.status, 400);
  assert.deepEqual(again.body.errors, ['email is already taken']);
  const blank = await s.json('/api/register', { email: 'bob@shop.test', password: 'pw', name: null });
  assert.deepEqual(blank.body.errors, ['name is required'], 'null is the empty value');
});

test('F1: api: a customer\'s cart, checkout and refusals go through the same actions, transitions and own scoping', async () => {
  s.asGuest();
  await s.json('/api/register', { email: 'cat@shop.test', password: 'pw', name: 'Cat' });
  const add = await s.json('/api/Product/1/action/addToCart', { qty: 2 });
  assert.equal(add.status, 200);
  assert.equal(add.body.flash, 'Blue mug added to your cart');
  assert.equal(add.body.row.id, 1);
  const cart = JSON.parse((await s.get('/api/list/cart')).html);
  assert.equal(cart.rows.length, 1);
  const order = cart.rows[0];
  assert.deepEqual([order.items, order.total, order.status], [2, 25, 'cart']);
  const missing = await s.json(`/api/Order/${order.id}/go/place`, {});
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.body.errors, ['address is required', 'paymentMethod is required']);
  const placed = await s.json(`/api/Order/${order.id}/go/place`, { address: '1 Main St', paymentMethod: 'cash' });
  assert.equal(placed.status, 200);
  assert.equal(placed.body.row.status, 'placed');
  assert.equal(placed.body.flash, `Order #${order.id} placed, total 25.00, to pay 25.00`);
  assert.equal(JSON.parse((await s.get('/api/Product/1')).html).stock, 8, 'the transition\'s steps ran');
  const twice = await s.json(`/api/Order/${order.id}/go/place`, { address: 'x', paymentMethod: 'cash' });
  assert.equal(twice.status, 409);
  const ship = await s.json(`/api/Order/${order.id}/go/ship`, {});
  assert.equal(ship.status, 403, 'ship is the admin\'s');
  const dash = await s.get('/api/dashboard/sales');
  assert.equal(dash.status, 403);
  s.asGuest();
  await s.json('/api/register', { email: 'dog@shop.test', password: 'pw', name: 'Dog' });
  assert.equal((await s.get(`/api/Order/${order.id}`)).status, 403, 'another customer\'s order is not theirs');
  assert.equal((await s.json(`/api/Order/${order.id}/go/cancel`, {})).status, 403);
  assert.equal((await s.json('/api/Order/999/go/cancel', {})).status, 404);
});

test('F1: api: an admin writes rows; an absent key is absent (no unchecked-box false), numbers arrive as the form\'s text', async () => {
  await s.login('admin@shop.test', 'admin123');
  const made = await s.json('/api/Product', { name: 'Green mug', price: 9.99, stock: 3, category: 1 });
  assert.equal(made.status, 200);
  assert.deepEqual(made.body.row, { id: made.body.id, name: 'Green mug', category: '1', price: 9.99, stock: 3, about: null, active: true, _labels: { category: 'Mugs' } });
  assert.equal(made.body.created, made.body.id);
  const id = made.body.id;
  const edited = await s.json(`/api/Product/${id}`, { stock: 5 });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.row.stock, edited.body.row.active, edited.body.row.price], [5, true, 9.99], 'a partial edit keeps the rest');
  const off = await s.json(`/api/Product/${id}`, { active: false });
  assert.equal(off.body.row.active, false);
  const bad = await s.json(`/api/Product/${id}`, { price: 'abc' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors, ['price must be a number']);
  const neg = await s.json('/api/Product', { name: 'Bad', price: -1 });
  assert.deepEqual(neg.body, { ok: false, status: 400, errors: ['Price cannot be negative'] });
  const orders = JSON.parse((await s.get('/api/Order')).html).rows;
  const none = await s.json(`/api/Order/${orders[0].id}/add/OrderItem`, { product: 2, qty: 1, price: 14 });
  assert.equal(none.status, 404, 'a related table declared with form: false has no add, under /api as on the form path');
  const gone = await s.json(`/api/Product/${id}/delete`, {});
  assert.deepEqual(gone.body, { ok: true, id, flash: 'Product deleted' });
  assert.equal((await s.get(`/api/Product/${id}`)).status, 404);
  const old = await s.get('/dashboard/sales', J), now = await s.get('/api/dashboard/sales');
  same(now.html, old.html);
  same((await s.get('/api/list/all-products')).html, (await s.get('/list/all-products', J)).html);
});

test('F1: api: GET /api/openapi.json is the --openapi document, for a signed-in user only', async () => {
  s.asGuest();
  const guest = await s.get('/api/openapi.json');
  assert.equal(guest.status, 403, 'a guest role reads no contract: it names User.role, admin lists and dashboards');
  assert.deepEqual(JSON.parse(guest.html), { ok: false, status: 403, errors: ['Sign in to read the contract.'] });
  await s.json('/api/register', { email: 'oas@shop.test', password: 'pw', name: 'Oas' });
  const r = await s.get('/api/openapi.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/json/);
  const { registry } = await loadPlugins(s.app.graph, 'apps/shop');
  assert.equal(r.html, openapiText(s.app.graph, registry));
  assert.equal(r.html, (await s.get('/api/openapi.json')).html, 'the same bytes every time');
  const graph = JSON.parse(fs.readFileSync('tests/fixtures/v2.json', 'utf8'));
  delete graph.roles.anonymous;
  delete graph.roles.can.guest;
  const closed = await boot(tmpGraph(graph));
  try {
    const gated = await closed.get('/api/openapi.json');
    assert.equal(gated.status, 403, 'a signed-out visitor of an app without guests reads nothing');
    assert.deepEqual(JSON.parse((await closed.get('/api/me')).html), { user: null, role: null });
    assert.equal((await closed.json('/api/login', { login: 'root@v2', password: 'root' })).status, 200);
    assert.equal((await closed.get('/api/openapi.json')).status, 200);
  } finally { closed.close(); }
});

test('F1: api: a JSON body cannot name a stored file; a crash is a JSON 500', async () => {
  const v2 = await boot('tests/fixtures/v2.json');
  try {
    await v2.json('/api/login', { login: 'root@v2', password: 'root' });
    const r = await v2.json('/api/Project', { name: 'P', attachment: '../../etc/passwd' });
    assert.equal(r.status, 200);
    assert.equal(r.body.row.attachment, null, 'the upload field is dropped, not stored');
    const kid = await v2.json(`/api/Project/${r.body.id}/add/Expense`, { amount: 5, note: 'paint' });
    assert.equal(kid.status, 200, 'a related table with a form takes an add');
    assert.deepEqual([kid.body.row.project, kid.body.row.amount, kid.body.row.note, kid.body.row._labels.project], [String(r.body.id), 5, 'paint', 'P']);
    assert.equal((await v2.json('/api/action/ping', {})).status, 200, 'a global action');
    const { store } = v2.app;
    const real = store.listPage;
    store.listPage = () => { throw new Error('disk gone'); };
    try {
      const crash = await v2.get('/api/Project');
      assert.equal(crash.status, 500);
      assert.deepEqual(JSON.parse(crash.html), { ok: false, status: 500, errors: ['Internal server error'] });
      assert.equal((await v2.get('/Project')).status, 500, 'the HTML path is still its error page');
    } finally { store.listPage = real; }
  } finally { v2.close(); }
});

test('F1: api: search and a role-free app (no session routes)', async () => {
  const file = tmpGraph({ app: 'notes', data: { Note: { title: 'text!', done: 'bool=false' } }, views: 'auto',
    override: { 'Note.list': { search: ['title'] } }, search: { entities: ['Note'] }, seed: { Note: [{ title: 'milk' }, { title: 'bread' }] } });
  const n = await boot(file);
  try {
    const r = await n.get('/api/search?q=milk');
    same(r.html, (await n.get('/search?q=milk', J)).html);
    assert.equal(JSON.parse(r.html).results[0].rows[0].title, 'milk');
    assert.equal((await n.json('/api/login', {})).status, 404);
    assert.equal((await n.json('/api/logout', {})).status, 404);
    assert.equal((await n.json('/api/register', {})).status, 404);
    assert.deepEqual(JSON.parse((await n.get('/api/me')).html), { user: null, role: null });
    assert.equal((await n.get('/api/openapi.json')).status, 200, 'an app without roles has no one to sign in: the contract is open');
    const made = await n.json('/api/Note', { title: 'eggs' });
    assert.equal(made.body.row.done, false, 'the declared default, not an unchecked box');
    assert.equal((await n.json('/api/Note/1', { title: 'oat milk' })).body.row.done, false);
  } finally { n.close(); }
  const r = await boot(tmpGraph({ app: 'closed', data: { User: { email: 'text!', password: 'password!', role: 'enum[admin]=admin' } }, views: 'auto',
    roles: { entity: 'User', login: 'email', password: 'password', role: 'role', can: { admin: '*' } } }));
  try { assert.equal((await r.json('/api/register', {})).status, 404, 'no self-registration declared'); } finally { r.close(); }
});

test('F1: api: captions — a customer reads the label of a user it may not view, the related table of its own order, the dashboard group', async () => {
  s.asGuest();
  await s.json('/api/register', { email: 'eve@shop.test', password: 'pw', name: 'Eve' });
  await s.json('/api/Product/2/action/addToCart', { qty: 1 });
  const order = JSON.parse((await s.get('/api/list/cart')).html).rows[0];
  assert.deepEqual(order._labels, { customer: 'eve@shop.test' });
  assert.equal((await s.get(`/api/User/${order.customer}`)).status, 403, 'the user row itself stays closed');
  const kids = await s.get(`/api/Order/${order.id}/related/OrderItem`);
  assert.equal(kids.status, 200);
  const page = JSON.parse(kids.html);
  assert.deepEqual([page.total, page.page, page.pages], [1, 1, 1]);
  assert.equal(page.rows[0]._labels.product, 'Red mug');
  assert.deepEqual(Object.keys(page.rows[0]._labels), ['order', 'product']);
  assert.equal(page.rows[0].product, '2');
  assert.equal((await s.get(`/api/order/${order.id}/related/orderitem`)).status, 200, 'any case, like every entity path');
  assert.equal((await s.get(`/api/Order/${order.id}/related/Nope`)).status, 404);
  assert.equal((await s.get('/api/Order/999/related/OrderItem')).status, 404);
  assert.equal((await s.get(`/Order/${order.id}/related/OrderItem`, J)).status, 404, 'only under /api');
  s.asGuest();
  assert.equal((await s.get(`/api/Order/${order.id}/related/OrderItem`)).status, 403);
  await s.json('/api/register', { email: 'fox@shop.test', password: 'pw', name: 'Fox' });
  assert.equal((await s.get(`/api/Order/${order.id}/related/OrderItem`)).status, 403, 'not their order');
  await s.login('admin@shop.test', 'admin123');
  await s.json(`/api/Order/${order.id}/go/place`, { address: 'x', paymentMethod: 'card' });
  const dash = JSON.parse((await s.get('/api/dashboard/sales')).html);
  const units = dash.tables.find((t) => t.title === 'Units by product').rows;
  assert.ok(units.length && units.every((r) => typeof r._labels.grp === 'string' && r._labels.grp.length), JSON.stringify(units));
  assert.ok(dash.tables.find((t) => t.title === 'Orders by status').rows.every((r) => r._labels === undefined), 'an enum group has no caption');
  assert.ok(!(await s.get('/dashboard/sales', J)).html.includes('_labels'), 'the Accept-mode dashboard has no captions');
});

const CARDS = {
  app: 'cards', views: 'auto',
  data: { User: { email: 'text!', password: 'password!', role: 'enum[admin,member]=member' }, Tag: { name: 'text!' },
    Card: { title: 'text!', owner: 'ref:User', tag: 'ref:Tag', extra: 'ref:Tag' }, Odd: { _labels: 'text', tag: 'ref:Tag' },
    Note: { card: 'ref:Card!', body: 'text', tag: 'ref:Tag', topic: 'ref:Tag' }, Page: { title: 'text!' } },
  roles: { entity: 'User', login: 'email', password: 'password', role: 'role',
    can: { admin: '*', member: { Card: ['view'], Tag: ['view'], Odd: ['view'] } } },
  override: { 'Card.detail': { fields: ['title', 'owner', 'tag'], private: { tag: 'owner' }, related: [{ entity: 'Note', via: 'card', columns: ['body'] }] },
    'Card.list': { columns: ['title', 'tag'] }, 'Note.detail': { fields: ['body'] }, 'Note.list': { columns: ['body'] } },
  lists: [{ id: 'notes', entity: 'Note', title: 'Notes', columns: ['body', 'topic'] }],
  pages: [{ id: 'about', title: 'About', text: 'hi' }],
  seed: { User: [{ email: 'a@x', password: 'a', role: 'member' }, { email: 'b@x', password: 'b', role: 'member' }, { email: 'c@x', password: 'c', role: 'admin' }], Tag: [{ name: 'red' }],
    Card: [{ title: 'one', owner: 1, tag: 1, extra: 1 }], Odd: [{ _labels: 'mine', tag: 1 }], Note: [{ card: 1, body: 'hi', tag: 1, topic: 1 }], Page: [{ title: 'p' }] },
};

test('F1: api: a caption is never more than the stand shows — a private reference, a field it never shows, an own _labels field', async () => {
  const c = await boot(tmpGraph(CARDS));
  try {
    await c.json('/api/login', { login: 'b@x', password: 'b' });
    const other = JSON.parse((await c.get('/api/Card/1')).html);
    assert.equal(other.tag, null, 'private to its owner');
    assert.deepEqual(other._labels, { owner: 'a@x' }, 'no caption for the hidden tag, none for "extra", which no screen shows');
    assert.equal(other.extra, '1');
    assert.equal((await c.get('/api/Card/1/related/Note')).status, 403, 'the child is not viewable: the detail page shows no table');
    await c.json('/api/login', { login: 'a@x', password: 'a' });
    assert.deepEqual(JSON.parse((await c.get('/api/Card/1')).html)._labels, { owner: 'a@x', tag: 'red' });
    const odd = JSON.parse((await c.get('/api/Odd/1')).html);
    assert.equal(odd._labels, 'mine', 'the field wins; no captions are added');
    assert.deepEqual(JSON.parse((await c.get('/Odd/1', J)).html), odd);
    await c.json('/api/login', { login: 'c@x', password: 'c' });
    const note = JSON.parse((await c.get('/api/list/notes')).html).rows[0];
    assert.deepEqual(note._labels, { topic: 'red' }, 'the saved list shows topic; no screen shows tag, the related table only the body');
    const page = await c.get('/api/page/1');
    assert.equal(page.status, 404, 'a path a route module claims is never read as the entity of the same name');
    assert.equal(JSON.parse(page.html).ok, false);
    assert.equal(JSON.parse((await c.get('/api/Page/1')).html).title, 'p', 'the entity itself, by its name');
  } finally { c.close(); }
});

test('F1: api: captions and a related page cost the same number of queries for 6 rows and for 40', async () => {
  const graph = { app: 'q', views: 'auto', data: { Owner: { name: 'text!' }, Box: { owner: 'ref:Owner!', label: 'text!' }, Item: { box: 'ref:Box!', owner: 'ref:Owner', note: 'text' } },
    override: { 'Box.detail': { related: [{ entity: 'Item', via: 'box' }] } } };
  const count = async (n) => {
    const q = await boot(tmpGraph(graph), { noTimers: true }); // a flusher tick would be counted too
    try {
      const { store } = q.app;
      const box = await store.insert('Box', { owner: await store.insert('Owner', { name: 'o0' }), label: 'b' });
      for (let i = 0; i < n; i++) {
        const o = await store.insert('Owner', { name: `o${i + 1}` });
        await store.insert('Box', { owner: o, label: `b${i}` });
        await store.insert('Item', { box, owner: o, note: `n${i}` });
      }
      let k = 0;
      store.drv.onQuery = (sql, opts) => { if (opts?.cache !== false) k++; };
      const list = JSON.parse((await q.get('/api/Box')).html);
      const kids = JSON.parse((await q.get(`/api/Box/${box}/related/Item`)).html);
      store.drv.onQuery = null;
      assert.equal(list.rows.length, n + 1);
      assert.equal(kids.rows.length, n);
      assert.ok(kids.rows.every((r) => r._labels.owner.startsWith('o') && r._labels.box === 'b'));
      return k;
    } finally { q.close(); }
  };
  assert.equal(await count(6), await count(40));
});
