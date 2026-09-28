#!/usr/bin/env node
// `npm run bench` — informational, not gating (tests/perf.test.mjs is the
// gate; this prints wall-clock numbers for round 7's before/after in
// TESTS.md). Boots the bench graph (Customer/Order/Item, docs/ARCHITECTURE.md's
// layering unchanged), bulk-inserts 500 customers / 2000 orders / 10000 items
// directly through the store (one transaction — this script measures the HTTP
// path, not insert speed), then times real HTTP requests against the running
// server: boot ms, RSS before/after loading, and p50/p95 of /Order, /Customer,
// a detail page and a create.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../runtime/server.mjs';

const CUSTOMERS = 500, ORDERS_PER_CUSTOMER = 4, ITEMS_PER_ORDER = 5; // 2000 orders, 10000 items

function seed(store) {
  store.transaction(() => {
    for (let c = 1; c <= CUSTOMERS; c++) {
      const cid = store.insert('Customer', { name: `Customer ${c}` });
      for (let o = 0; o < ORDERS_PER_CUSTOMER; o++) {
        const oid = store.insert('Order', { customer: cid, status: o % 3 === 0 ? 'paid' : 'new' });
        for (let i = 0; i < ITEMS_PER_ORDER; i++) store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + (i % 3), price: (5 + i * 2.5).toFixed(2) });
      }
    }
  });
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function timeRequests(url, options, n) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const res = await fetch(url, options);
    await res.arrayBuffer();
    ms.push(performance.now() - start);
  }
  ms.sort((a, b) => a - b);
  return { p50: percentile(ms, 50), p95: percentile(ms, 95) };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-bench-'));
  const graphFile = path.join(dir, 'app.json');
  fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'app.json'), graphFile);
  const dbFile = path.join(dir, 'data.sqlite');
  const port = 8000 + Math.floor(Math.random() * 1000);

  const rssBoot = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
  const bootStart = performance.now();
  const app = serve({ graphFile, dbFile, traceFile: undefined, port, noTimers: true });
  const bootMs = performance.now() - bootStart;
  const rssEmpty = rssBoot();

  seed(app.store);
  const rssLoaded = rssBoot();

  const base = `http://127.0.0.1:${port}`;
  const orderIds = app.store.listRaw('Order', {}).map((r) => r.id);
  const detailUrl = `${base}/Order/${orderIds[Math.floor(orderIds.length / 2)]}`;
  const customerIds = app.store.listRaw('Customer', {}).map((r) => r.id);

  const N = 30;
  const results = {};
  results['/Order'] = await timeRequests(`${base}/Order`, {}, N);
  results['/Order?sort=total'] = await timeRequests(`${base}/Order?sort=total`, {}, N);
  results['/Order?status=paid'] = await timeRequests(`${base}/Order?status=paid`, {}, N);
  results['/Order.csv'] = await timeRequests(`${base}/Order.csv`, {}, N);
  results['/Customer'] = await timeRequests(`${base}/Customer`, {}, N);
  results['/dashboard/sales'] = await timeRequests(`${base}/dashboard/sales`, {}, N);
  results['detail'] = await timeRequests(detailUrl, {}, N);
  results['create'] = await timeRequests(`${base}/Order`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `customer=${customerIds[0]}&status=new`,
  }, N);

  console.log(`boot: ${bootMs.toFixed(1)} ms`);
  console.log(`RSS: ${rssEmpty} MB empty / ${rssLoaded} MB loaded (${CUSTOMERS} customers, ${CUSTOMERS * ORDERS_PER_CUSTOMER} orders, ${CUSTOMERS * ORDERS_PER_CUSTOMER * ITEMS_PER_ORDER} items)`);
  console.log('');
  console.log('route                p50 (ms)   p95 (ms)');
  for (const [route, { p50, p95 }] of Object.entries(results)) console.log(`${route.padEnd(20)}  ${p50.toFixed(1).padStart(8)}   ${p95.toFixed(1).padStart(8)}`);

  app.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
