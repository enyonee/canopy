import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { main } from '../runtime/cli.mjs';

const capture = () => { const out = []; return { sink: { log: (m) => out.push(String(m)), err: (m) => out.push(String(m)) }, out }; };

test('--check passes a valid graph and fails a broken one', () => {
  const a = capture();
  assert.equal(main(['apps/todo/app.json', '--check'], a.sink).code, 0);
  assert.match(a.out.join('\n'), /✓ apps\/todo\/app.json is valid/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'b', data: { A: { x: 'text!' } }, override: { 'A.list': { columns: ['y'] } } }));
  const b = capture();
  assert.equal(main([file, '--check'], b.sink).code, 1);
  assert.match(b.out.join('\n'), /field "y" does not exist on A/);
});

test('without a file it explains itself', () => {
  const c = capture();
  assert.equal(main(['--check'], c.sink).code, 2);
  assert.match(c.out.join('\n'), /usage: run.mjs/);
});

test('it boots an app on the port it was given, with the db and trace it was given', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-'));
  const db = path.join(dir, 'x.sqlite');
  const trace = path.join(dir, 'x.jsonl');
  const c = capture();
  const { app } = main(['tests/fixtures/kitchen.json', '--port', '0', '--db', db, '--trace', trace], c.sink);
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/Topic`);
  assert.equal(r.status, 200);
  await r.text();
  assert.ok(fs.existsSync(db), 'the database went where it was told');
  assert.ok(fs.readFileSync(trace, 'utf8').includes('"kind":"query"'), 'the trace went where it was told');
  assert.match(c.out.join('\n'), /app running at/);
  app.server.closeAllConnections(); app.server.close();
});

test('an invalid graph is reported and still served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cli-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'b', data: { A: { x: 'date!' } } }));
  const c = capture();
  const { app } = main([file, '--port', '0', '--db', path.join(dir, 'd.sqlite')], c.sink);
  await once(app.server, 'listening');
  assert.match(c.out.join('\n'), /invalid graph served at/);
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/`);
  assert.equal(r.status, 500);
  await r.text();
  app.server.closeAllConnections(); app.server.close();
});
