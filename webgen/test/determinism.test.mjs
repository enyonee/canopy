// Two runs write the same bytes: in memory, and through the CLI onto disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generate } from '../lib/generate.mjs';
import { shopGraph, shopOpenapi, ROOT } from './helpers.mjs';

test('generate() twice: byte-identical file maps, also when the document\'s keys come in another order', async () => {
  const a = await generate(shopGraph(), shopOpenapi());
  const shuffled = JSON.parse(JSON.stringify(shopOpenapi(), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  const b = await generate(shopGraph(), shuffled);
  assert.deepEqual([...a.files.keys()], [...b.files.keys()]);
  for (const [k, v] of a.files) assert.equal(b.files.get(k), v, `${k} differs`);
});

test('the CLI twice into two directories: the same bytes, and --check finds nothing to change', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webgen-det-'));
  try {
    const run = (out, ...extra) => execFileSync(process.execPath, [path.join(ROOT, 'webgen/gen.mjs'), path.join(ROOT, 'apps/shop/app.json'),
      '--openapi', path.join(ROOT, 'apps/shop/web/openapi.json'), '--out', out, ...extra], { encoding: 'utf8' });
    run(path.join(tmp, 'a')); run(path.join(tmp, 'b'));
    const list = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();
    assert.deepEqual(list(path.join(tmp, 'a')), list(path.join(tmp, 'b')));
    for (const f of list(path.join(tmp, 'a'))) assert.ok(fs.readFileSync(path.join(tmp, 'a', f)).equals(fs.readFileSync(path.join(tmp, 'b', f))), `${f} differs`);
    assert.match(run(path.join(tmp, 'a'), '--check'), /up to date/);
    assert.match(run(path.join(tmp, 'a')), /0 written, 0 removed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the committed project is what the generator makes of the committed snapshot', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'webgen/gen.mjs'), path.join(ROOT, 'apps/shop/app.json'),
    '--openapi', path.join(ROOT, 'apps/shop/web/openapi.json'), '--out', path.join(ROOT, 'apps/shop/web'), '--check'], { encoding: 'utf8' });
  assert.match(out, /up to date/);
});
