// F1: the OpenAPI 3.1 document of /api, derived from the graph (runtime/contract.mjs) — its shapes, its paths, its
// determinism, and the `--openapi` command that writes the same bytes the server sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openapi, openapiText } from '../runtime/contract.mjs';
import { DEFAULT, loadPlugins } from '../runtime/registry.mjs';
import { FIELDS } from '../runtime/fields.mjs';
import { main } from '../runtime/cli.mjs';
import { tmpDir, tmpGraph } from './helpers.mjs';

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const docOf = async (file) => {
  const graph = read(file);
  const { registry } = await loadPlugins(graph, path.dirname(path.resolve(file)));
  return { graph, registry, doc: openapi(graph, registry) };
};

// Every "$ref" names a component that exists.
function refs(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === '$ref') out.push(x); else refs(x, out); }
  return out;
}
const resolves = (doc, r) => r.slice(2).split('/').reduce((o, k) => o?.[k], doc) !== undefined;

test('F1: contract: the shop document names every route /api serves, and every $ref resolves', async () => {
  const { doc } = await docOf('apps/shop/app.json');
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.title, 'shop');
  for (const p of ['/api/Product', '/api/Product/{id}', '/api/Product/{id}/delete', '/api/Product/{id}/action/addToCart', '/api/Order/{id}/go/place',
    '/api/Order/{id}/add/OrderItem', '/api/list/cart', '/api/dashboard/sales', '/api/login', '/api/logout', '/api/register', '/api/me', '/api/openapi.json']) {
    assert.ok(doc.paths[p], p);
  }
  assert.equal(doc.paths['/api/search'], undefined, 'shop declares no search');
  assert.equal(doc.paths['/api/Product'].get.operationId, 'listProduct');
  assert.equal(doc.paths['/api/Product'].post.operationId, 'createProduct');
  assert.deepEqual(Object.keys(doc.paths['/api/Order/{id}/go/place'].post.responses), ['200', '400', '403', '404', '409', '413', '415']);
  assert.deepEqual(Object.keys(doc.paths['/api/Product/{id}'].get.responses), ['200', '403', '404']);
  assert.deepEqual(Object.keys(doc.paths['/api/login'].post.responses), ['200', '400', '401', '403', '413', '415']);
  const bad = refs(doc).filter((r) => !resolves(doc, r));
  assert.deepEqual(bad, []);
  assert.deepEqual(doc.components.securitySchemes, { session: { in: 'cookie', name: 'ag_session', type: 'apiKey' } });
});

test('F1: contract: a row reads as the JSON answers write it — money a number, a reference its id, no secret, derived read-only', async () => {
  const { doc } = await docOf('apps/shop/app.json');
  const s = doc.components.schemas;
  assert.deepEqual(s.Product.properties.price, { type: ['number', 'null'], 'x-canopy-kind': 'money' });
  assert.deepEqual(s.Product.properties.category, { type: ['string', 'null'], 'x-canopy-kind': 'ref', 'x-canopy-ref': 'Category' });
  assert.deepEqual(s.Product.properties.active, { type: ['boolean', 'null'], 'x-canopy-kind': 'bool' });
  assert.deepEqual(s.Product.properties.id, { readOnly: true, type: 'integer' });
  assert.deepEqual(s.Order.properties.status.enum, ['cart', 'placed', 'paid', 'shipped', 'delivered', 'cancelled']);
  assert.deepEqual(s.Order.properties.createdAt, { format: 'date-time', type: ['string', 'null'], 'x-canopy-kind': 'time' });
  assert.equal(s.Order.properties.total.readOnly, true);
  assert.equal(s.User.properties.password, undefined, 'a secret is never in a row');
  assert.deepEqual(s.User.properties.discount, { type: ['integer', 'null'], 'x-canopy-kind': 'percent' }, 'a plugin kind reads by its storage');
  assert.deepEqual(s.Product.required, ['id', 'name', 'category', 'price', 'stock', 'about', 'active']);
  assert.equal(s.Product.additionalProperties, false);
  assert.deepEqual(s['Product.page'].properties.rows, { items: { $ref: '#/components/schemas/Product' }, type: 'array' });
});

test('F1: contract: a body names what a form may set — no status, no derived, no upload; a declared form list narrows it', async () => {
  const { doc } = await docOf('apps/shop/app.json');
  const s = doc.components.schemas;
  assert.deepEqual(Object.keys(s['Order.input'].properties), ['address', 'createdAt', 'customer', 'paymentMethod'], 'status belongs to the transitions');
  assert.deepEqual(Object.keys(s['OrderItem.input'].properties), ['qty'], 'OrderItem.form fields');
  assert.deepEqual(s['Order.input'].properties.customer, { type: ['string', 'integer', 'null'], 'x-canopy-kind': 'ref', 'x-canopy-ref': 'User' });
  assert.equal(s['User.input'].properties.password.writeOnly, true);
  assert.deepEqual(Object.keys(s['canopy.Register'].properties), ['discount', 'email', 'name', 'password', 'points'], 'never the role');
  const place = doc.paths['/api/Order/{id}/go/place'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(place.required, ['address', 'paymentMethod']);
  assert.equal(place.additionalProperties, true, 'the steps may read any values.<name>');
  const add = doc.paths['/api/Order/{id}/add/OrderItem'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(add.properties), ['price', 'product', 'qty'], 'never the via field');
  const v2 = (await docOf('tests/fixtures/v2.json')).doc;
  assert.equal(v2.components.schemas['Project.input'].properties.attachment, undefined, 'a JSON body carries no file');
  assert.match(v2.components.schemas.Project.properties.attachment.description, /\/file\/<Entity>\/<id>\/attachment/);
  assert.deepEqual(v2.components.schemas.Project.properties.start, { format: 'date', type: ['string', 'null'], 'x-canopy-kind': 'date' });
  const ping = v2.paths['/api/action/ping'].post;
  assert.equal(ping.operationId, 'action_ping');
  assert.deepEqual(v2.paths['/api/Expense/{id}/delete'].post.responses['200'].content['application/json'].schema, { $ref: '#/components/schemas/canopy.Deleted' });
  const list = v2.paths['/api/Project'].get.parameters.map((p) => p.name);
  assert.deepEqual(list, ['q', 'page', 'sort', 'dir', 'status', 'start_from', 'start_to', 'over', 'budget_from', 'budget_to']);
});

test('F1: contract: search, global action fields, no roles, and a plugin kind stored as REAL', () => {
  const graph = { app: 'tiny', data: { Note: { title: 'text!', score: 'ratio' } }, views: 'auto', search: { entities: ['Note'] },
    actions: [{ name: 'hello', fields: ['who'], do: [] }] };
  const registry = { fields: { ...FIELDS, ratio: { ...FIELDS.int, sql: 'REAL' } } };
  const doc = openapi(graph, registry);
  assert.deepEqual(doc.paths['/api/search'].get.parameters.map((p) => p.name), ['q']);
  assert.deepEqual(doc.paths['/api/Note'].get.parameters.map((p) => p.name), ['page', 'sort', 'dir'], 'no search fields, no q');
  assert.deepEqual(doc.components.schemas.Note.properties.score.type, ['number', 'null']);
  const hello = doc.paths['/api/action/hello'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(hello, { additionalProperties: true, properties: { who: { type: 'string' } }, required: ['who'], type: 'object' });
  assert.equal(doc.paths['/api/login'], undefined, 'no roles, no sign-in');
  assert.equal(doc.components.securitySchemes, undefined);
  assert.deepEqual(doc.components.schemas['canopy.Me'].properties.user, { oneOf: [{ type: 'null' }, { type: 'null' }] });
  assert.equal(openapi({ data: { A: { x: 'text' } } }, registry).info.title, 'app');
});

test('F1: contract: the document is deterministic — keys sorted at every depth, the same bytes every time', async () => {
  const { graph, registry } = await docOf('apps/shop/app.json');
  const a = openapiText(graph, registry), b = openapiText(JSON.parse(JSON.stringify(graph)), registry);
  assert.equal(a, b);
  assert.ok(a.endsWith('}\n'));
  const sorted = (v) => (Array.isArray(v) ? v.every(sorted) : v && typeof v === 'object'
    ? Object.keys(v).every((k, i, ks) => i === 0 || ks[i - 1] < k) && Object.values(v).every(sorted) : true);
  assert.ok(sorted(JSON.parse(a)));
  const doc = JSON.parse(a);
  assert.deepEqual(doc.components.schemas.Product.required.slice(0, 3), ['id', 'name', 'category'], 'arrays keep the graph order');
});

test('F1: contract: --openapi prints the document, --out writes it, an invalid graph has none', async (t) => {
  const out = [];
  const r = await main(['apps/shop/app.json', '--openapi'], { log: (m) => out.push(m), err: (m) => out.push(m) });
  assert.equal(r.code, 0);
  const { graph, registry } = await docOf('apps/shop/app.json');
  assert.equal(`${out.join('\n')}\n`, openapiText(graph, registry));
  const dir = tmpDir('ag-oas-', t);
  const file = path.join(dir, 'shop.json');
  const logged = [];
  assert.equal((await main(['apps/shop/app.json', '--openapi', '--out', file], { log: (m) => logged.push(m) })).code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), openapiText(graph, registry));
  assert.deepEqual(logged, [`✓ ${file}`]);
  const errs = [];
  const bad = tmpGraph({ app: 'x', data: { A: { b: 'ref:Nope' } }, views: 'auto' });
  assert.equal((await main([bad, '--openapi'], { log: () => {}, err: (m) => errs.push(m) })).code, 1);
  assert.match(errs.join('\n'), /✗/);
  assert.ok(DEFAULT.fields.text, 'the default registry is what an app without plugins reads');
});
