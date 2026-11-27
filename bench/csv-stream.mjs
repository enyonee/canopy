// node bench/csv-stream.mjs <checkout> [rows]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '.';
const count = Number(process.argv[3] ?? 12000);
const { serve } = await import(pathToFileURL(path.resolve(root, 'runtime/server.mjs')).href);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-csv-bench-'));
const graphFile = path.join(dir, 'app.json');
await fs.writeFile(graphFile, JSON.stringify({ app: 'bench', data: {
  Group: { name: 'text' }, Item: { name: 'text', group: 'ref:Group', rank: 'int', doubled: 'int := rank * 2' },
} }));
const app = serve({ graphFile, dbFile: path.join(dir, 'data.sqlite'), port: 0, noTimers: true });
try {
  await Promise.all([app.ready, once(app.server, 'listening')]);
  const base = 'http://127.0.0.1:' + app.server.address().port;
  await app.store.transaction(async (tx) => {
    const group = await tx.insert('Group', { name: 'Bench group' });
    for (let i = 0; i < count; i++) await tx.insert('Item', { name: `Item ${i}, ` + 'x'.repeat(256), group, rank: i });
  });
  global.gc?.();
  const rssBefore = process.resourceUsage().maxRSS;
  const json = await (await fetch(base + '/Item?sort=rank&dir=asc', { headers: { accept: 'application/json' } })).text();
  const start = performance.now();
  const csv = await fetch(base + '/Item.csv?sort=rank&dir=asc');
  assert.equal(csv.status, 200);
  const msToHeaders = performance.now() - start;
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of csv.body) { digest.update(chunk); bytes += chunk.length; }
  console.log(JSON.stringify({ count, bytes, csv: digest.digest('hex'),
    json: createHash('sha256').update(json).digest('hex'), msToHeaders, msTotal: performance.now() - start,
    peakMiB: process.resourceUsage().maxRSS / 1024, rssIncreaseMiB: (process.resourceUsage().maxRSS - rssBefore) / 1024 }));
} finally {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
  await fs.rm(dir, { recursive: true, force: true });
}
