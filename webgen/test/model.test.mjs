// The graph → screens mapping, on the shop: what each node of app.json becomes in the front end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel } from '../lib/model.mjs';
import { shopGraph, shopOpenapi } from './helpers.mjs';

const m = buildModel(shopGraph(), shopOpenapi());

test('data: every entity is a list, a form and a detail; field kinds come from the contract', () => {
  assert.deepEqual(Object.keys(m.entities), ['User', 'Category', 'Product', 'Order', 'OrderItem']);
  const price = m.entities.Product.fields.find((f) => f.name === 'price');
  assert.deepEqual([price.kind, price.type, price.required], ['money', 'number', true]);
  assert.deepEqual(price.bounds, [{ op: '>=', value: 0, message: 'Price cannot be negative' }]);
  const discount = m.entities.User.fields.find((f) => f.name === 'discount');
  assert.equal(discount.kind, 'percent', 'a plugin field kind is read from x-canopy-kind');
  assert.equal(m.entities.User.fields.find((f) => f.name === 'password').secret, true);
  assert.equal(m.entities.Order.fields.find((f) => f.name === 'total').derived, true);
  assert.equal(m.entities.Product.fields.find((f) => f.name === 'category').target, 'Category');
  assert.equal(m.entities.User.fields.find((f) => f.name === 'email').unique, true);
});

test('override: list, form and detail shapes follow the graph', () => {
  const p = m.entities.Product.list;
  assert.equal(p.title, 'Shop');
  assert.deepEqual(p.columns, ['name', 'category', 'price', 'stock']);
  assert.deepEqual(p.search, ['name', 'about']);
  assert.deepEqual(p.filters, [{ name: 'Category', field: 'category', range: false }]);
  assert.deepEqual(p.rowActions, ['view', 'addToCart', 'edit', 'delete']);
  assert.equal(m.entities.Order.list.create, false);
  assert.equal(m.entities.Category.list.hidden, true);
  assert.deepEqual(m.entities.User.list.rowActions, ['edit', 'delete'], 'the runtime\'s default row actions');
  assert.deepEqual(m.entities.OrderItem.form.fields, ['qty']);
  assert.equal(m.entities.OrderItem.form.afterEdit, '/Order/{order}');
  assert.deepEqual(m.entities.Order.form.fields, ['customer', 'address', 'paymentMethod'], 'not the status, not derived, not the time');
  const rel = m.entities.Order.detail.related[0];
  assert.deepEqual([rel.entity, rel.via, rel.title, rel.form], ['OrderItem', 'order', 'Items', false]);
  assert.deepEqual(m.entities.Product.detail.actions, ['addToCart']);
});

test('states: transitions with from, by, fields; a cancel is destructive', () => {
  const st = m.entities.Order.states;
  assert.equal(st.field, 'status');
  const place = st.transitions.find((t) => t.name === 'place');
  assert.deepEqual([place.title, place.from, place.to, place.fields], ['Place order', ['cart'], 'placed', ['address', 'paymentMethod']]);
  assert.deepEqual(st.transitions.find((t) => t.name === 'ship').by, ['admin']);
  assert.equal(st.transitions.find((t) => t.name === 'cancel').destructive, true);
  assert.equal(place.destructive, false);
});

test('actions: a row action belongs to its entity, with its after path', () => {
  assert.deepEqual(m.entities.Product.actions, [{ name: 'addToCart', title: 'Add to cart', by: null, after: '/list/cart', fields: [] }]);
  assert.deepEqual(m.globalActions, []);
});

test('roles: matrix, admins, and a registration that asks only for what has no default', () => {
  assert.deepEqual(m.roles.admins, ['admin']);
  assert.deepEqual(m.roles.registerFields, ['email', 'password', 'name']);
  assert.equal(m.roles.register, 'customer');
  assert.equal(m.roles.anonymous, 'guest');
  assert.deepEqual(m.roles.can.customer.Order, { own: 'customer', can: ['view', 'go:place', 'go:pay', 'go:cancel'] });
});

test('navigation: home first, hidden lists out, saved lists and dashboards with their roles', () => {
  assert.deepEqual(m.nav.map((n) => [n.to, n.title, n.icon, n.roles]), [
    ['/Product', 'Shop', 'package', null],
    ['/User', 'Customers', 'users', null],
    ['/Order', 'Orders', 'receipt', null],
    ['/list/cart', 'Cart', 'shopping-cart', ['customer']],
    ['/list/all-products', 'All products', 'package', ['admin']],
    ['/dashboard/sales', 'Sales', 'chart', ['admin']],
  ]);
});

test('dashboards: cards and tables know which numbers are money and how groups read', () => {
  const d = m.dashboards[0];
  assert.equal(d.period, true);
  assert.deepEqual(d.cards.map((c) => [c.title, c.money]), [['Orders placed', false], ['Revenue (paid)', true], ['Products', false]]);
  const [byStatus, byProduct, byMonth] = d.tables;
  assert.deepEqual(byStatus.group, { field: 'status', kind: 'enum', target: null, options: ['cart', 'placed', 'paid', 'shipped', 'delivered', 'cancelled'], unit: null });
  assert.deepEqual(byStatus.metrics.map((x) => x.money), [false, true]);
  assert.deepEqual([byProduct.group.kind, byProduct.group.target], ['ref', 'Product']);
  assert.deepEqual(byProduct.metrics.map((x) => [x.as, x.money]), [['units', false], ['amount', true]]);
  assert.deepEqual([byMonth.group.kind, byMonth.group.unit], ['time', 'month']);
});

test('theme and the rest of the top level', () => {
  assert.deepEqual(m.theme, { background: 'seashell', accent: 'darkslateblue' });
  assert.equal(m.home, '/Product');
  assert.equal(m.title, 'Shop');
  assert.deepEqual(m.lists.map((l) => [l.id, l.entity, l.create]), [['cart', 'Order', false], ['all-products', 'Product', true]]);
  assert.equal(m.search, null);
  assert.deepEqual(m.pages, []);
});

test('a graph without roles, with pages, search and global actions', () => {
  const g = { app: 'notes', data: { Note: { title: 'text!', done: 'bool=false' } }, views: 'auto',
    pages: [{ id: 'about', title: 'About', body: 'Hello', actions: ['ping'] }], search: { entities: ['Note'] },
    actions: [{ name: 'ping', title: 'Ping', do: [] }] };
  const n = buildModel(g, { paths: {}, components: { schemas: {} } });
  assert.equal(n.roles, null);
  assert.deepEqual(n.pages[0].body, ['Hello']);
  assert.deepEqual(n.search, { entities: ['Note'], title: 'Search' });
  assert.deepEqual(n.globalActions.map((a) => a.name), ['ping']);
  assert.deepEqual(n.nav.map((x) => x.to), ['/Note', '/page/about']);
  assert.equal(n.entities.Note.fields[1].type, 'boolean', 'without a contract the kind decides the JSON type');
});
