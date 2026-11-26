// --base: an app behind a reverse proxy that keeps a path prefix answers only under it, and every link, form
// target and redirect it sends carries the prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { boot, tmpDir } from './helpers.mjs';
import { main } from '../runtime/cli.mjs';

const BASE = '/apps/k';

test('base: pages, forms, redirects and /api answer under the base; links leave with it', async () => {
  const s = await boot('tests/fixtures/kitchen.json', { base: BASE });
  try {
    const list = await s.get(`${BASE}/Topic`);
    assert.equal(list.status, 200);
    assert.match(list.html, /href="\/apps\/k\/Topic\/new"/);
    assert.doesNotMatch(list.html, /(?:href|action|src)="\/(?!apps\/k[/?"])/, 'no root link escapes the base');
    const home = await s.get(BASE);
    assert.equal(home.status, 303);
    assert.equal(home.location, `${BASE}/page/home`, 'the home redirect gets the base');
    const made = await s.post(`${BASE}/Topic`, { name: 'Cats' });
    assert.equal(made.status, 303);
    assert.match(made.location, /^\/apps\/k\/Topic/, 'the redirect after a write gets the base');
    const api = await s.json(`${BASE}/api/Topic`, { name: 'Dogs' });
    assert.equal(api.status, 200);
    assert.equal(api.body.row.name, 'Dogs');
    const rows = await s.get(`${BASE}/api/Topic`);
    assert.ok(JSON.parse(rows.html).rows.some((r) => r.name === 'Cats'));
  } finally { s.close(); }
});

test('base: a path outside the base is not the app, and a longer segment is not the base', async () => {
  const s = await boot('tests/fixtures/kitchen.json', { base: BASE });
  try {
    for (const p of ['/Topic', '/apps/kx/Topic', '/apps']) {
      const r = await s.get(p);
      assert.equal(r.status, 404, p);
      assert.match(r.html, /answers under \/apps\/k/);
    }
  } finally { s.close(); }
});

test('--base serves the app under the base; a malformed base or one with a built front is refused', async () => {
  const out = [], errs = [];
  const sink = { log: (m) => out.push(m), err: (m) => errs.push(m) };
  const dir = tmpDir('ag-base-');
  for (const bad of ['apps', '/apps/', '/apps/../x', '/a b', '/a"b'])
    assert.equal((await main(['tests/fixtures/kitchen.json', '--port', '0', '--db', path.join(dir, 'x.sqlite'), '--base', bad], sink)).code, 2, bad);
  assert.match(errs.join('\n'), /a base path is \/segment/);
  const web = JSON.parse(fs.readFileSync('tests/fixtures/web/app.json', 'utf8'));
  const webFile = path.join('tests/fixtures/web', 'base-refused.json');
  fs.writeFileSync(webFile, JSON.stringify(web));
  try {
    assert.equal((await main([webFile, '--port', '0', '--db', path.join(dir, 'w.sqlite'), '--base', BASE], sink)).code, 2);
  } finally { fs.rmSync(webFile); }
  assert.match(errs.join('\n'), /built front \("web"\) answers at the root/);
  const { app } = await main(['tests/fixtures/kitchen.json', '--port', '0', '--db', path.join(dir, 'y.sqlite'), '--trace', path.join(dir, 't.jsonl'), '--base', BASE], sink);
  await once(app.server, 'listening');
  try {
    const port = app.server.address().port;
    const inside = await fetch(`http://127.0.0.1:${port}${BASE}/Topic`);
    assert.equal(inside.status, 200);
    await inside.text();
    const outside = await fetch(`http://127.0.0.1:${port}/Topic`);
    assert.equal(outside.status, 404);
    await outside.text();
  } finally { app.server.closeAllConnections(); app.server.close(); }
});
