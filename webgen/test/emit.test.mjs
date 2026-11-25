// What the generator writes for the shop: the typed endpoints follow the contract, the routes follow the graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../lib/generate.mjs';
import { shopGraph, shopOpenapi } from './helpers.mjs';

const { files } = await generate(shopGraph(), shopOpenapi());
const endpoints = files.get('src/gen/endpoints.ts');
const routes = files.get('src/gen/routes.tsx');

test('every route of the contract the screens use is bound, typed against api.d.ts', () => {
  for (const p of ['/api/Product', '/api/Product/{id}', '/api/Product/{id}/action/addToCart', '/api/Order/{id}/go/place', '/api/Order/{id}/go/cancel',
    '/api/Order/{id}/related/OrderItem', '/api/list/cart', '/api/list/all-products', '/api/dashboard/sales', '/api/login', '/api/logout', '/api/register', '/api/me']) {
    assert.ok(endpoints.includes(`"${p}"`) || endpoints.includes(`'${p}'`), `${p} is not bound`);
  }
  assert.match(endpoints, /body as B<"\/api\/Order\/\{id\}\/go\/place">/);
  assert.match(files.get('src/gen/api.d.ts'), /"\/api\/Order\/\{id\}\/go\/place": \{/);
});

test('a route the contract lacks is not bound: the screen says so instead of calling it', async () => {
  const doc = shopOpenapi();
  delete doc.paths['/api/Order/{id}/related/OrderItem'];
  const { files: f } = await generate(shopGraph(), doc);
  assert.ok(!f.get('src/gen/endpoints.ts').includes('/related/OrderItem'));
});

test('routes: list, new, detail and edit per entity; saved lists, dashboards, sign-in; / goes home', () => {
  for (const p of ['/Product', '/Product/new', '/Product/$id', '/Product/$id/edit', '/Order/$id', '/list/cart', '/dashboard/sales', '/login', '/register']) {
    assert.ok(routes.includes(`path: "${p}"`), `no route ${p}`);
  }
  assert.match(routes, /throw redirect\(\{ to: "\/Product"/);
  assert.ok(!routes.includes('PageScreen'), 'no pages in the shop, no page screen imported');
});

test('the theme of the graph is the palette of the front end', () => {
  assert.match(files.get('src/gen/theme.css'), /--brand-bg: seashell;\n  --brand: darkslateblue;/);
  assert.match(files.get('index.html'), /<meta name="theme-color" content="darkslateblue" \/>/);
  assert.match(files.get('index.html'), /<title>Shop<\/title>/);
});

test('the project: template and generated files, a manifest, pinned versions, a check:contract script', () => {
  for (const f of ['src/main.tsx', 'src/components/ui/button.tsx', 'src/screens/list-screen.tsx', 'vite.config.ts', 'openapi.json', '.webgen.json']) assert.ok(files.has(f), `${f} missing`);
  const manifest = JSON.parse(files.get('.webgen.json'));
  assert.deepEqual(manifest.files, [...files.keys()].filter((k) => k !== '.webgen.json'));
  const pkg = JSON.parse(files.get('package.json'));
  assert.equal(pkg.name, 'shop-web');
  assert.ok(Object.values({ ...pkg.dependencies, ...pkg.devDependencies }).every((v) => /^\d+\.\d+\.\d+$/.test(v)), 'every version is exact');
  assert.equal(pkg.scripts['check:contract'], 'node ../../../webgen/check-contract.mjs ../app.json');
});
