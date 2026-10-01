#!/usr/bin/env node
// `npm run bench` — informational, not gating (tests/perf.test.mjs and
// tests/aggsql.test.mjs are the gates; this prints wall-clock and RSS
// numbers). Three scenarios, each its own Store/server so one does not warm
// the next: (1) round 7's original latency table (Customer/Order/Item,
// 500/2000/10000); (2) round 8 item 1's own case — a single wide Order (many
// Items) and a single Customer with many Orders — GET /Order/<id> before vs
// after SQL-compiled aggregates; (3) round 8 item 2 — RSS after /dashboard
// and /Order.csv at three sizes, before and after a forced GC (needs
// `--expose-gc`, which the "bench" npm script already passes); (4) round 9 items 1-3 —
// aggregates over derived fields, derived aggregates and dates on a customer with
// 5000 orders (bench/app2.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../runtime/server.mjs';

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

const rssMB = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

// Several scenarios each start their own server in the same process — a
// random port (wide range, and never reused: `used` below) avoids the
// EADDRINUSE a narrow fixed range risked once bench grew past one server.
const usedPorts = new Set();
function freshPort() {
  let port;
  do { port = 8000 + Math.floor(Math.random() * 40_000); } while (usedPorts.has(port));
  usedPorts.add(port);
  return port;
}

async function withServer(fn, graph = 'app.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-bench-'));
  const graphFile = path.join(dir, 'app.json');
  fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), graph), graphFile);
  const dbFile = path.join(dir, 'data.sqlite');
  const port = freshPort();
  const bootStart = performance.now();
  const app = serve({ graphFile, dbFile, traceFile: undefined, port, noTimers: true });
  await app.ready;
  const bootMs = performance.now() - bootStart;
  try { await fn(app, `http://127.0.0.1:${port}`, bootMs); }
  finally { await new Promise((resolve) => app.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- scenario 1: round 7's original latency table ---------------------------
const CUSTOMERS = 500, ORDERS_PER_CUSTOMER = 4, ITEMS_PER_ORDER = 5; // 2000 orders, 10000 items

async function seedMain(store) {
  await store.transaction(async () => {
    for (let c = 1; c <= CUSTOMERS; c++) {
      const cid = await store.insert('Customer', { name: `Customer ${c}` });
      for (let o = 0; o < ORDERS_PER_CUSTOMER; o++) {
        const oid = await store.insert('Order', { customer: cid, status: o % 3 === 0 ? 'paid' : 'new' });
        for (let i = 0; i < ITEMS_PER_ORDER; i++) await store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + (i % 3), price: (5 + i * 2.5).toFixed(2) });
      }
    }
  });
}

async function benchMain() {
  await withServer(async (app, base, bootMs) => {
    const rssEmpty = rssMB();
    await seedMain(app.store);
    const rssLoaded = rssMB();
    const orderIds = (await app.store.listRaw('Order', {})).map((r) => r.id);
    const detailUrl = `${base}/Order/${orderIds[Math.floor(orderIds.length / 2)]}`;
    const customerIds = (await app.store.listRaw('Customer', {})).map((r) => r.id);
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

    console.log('=== scenario 1: latency table (round 7) ===');
    console.log(`boot: ${bootMs.toFixed(1)} ms`);
    console.log(`RSS: ${rssEmpty} MB empty / ${rssLoaded} MB loaded (${CUSTOMERS} customers, ${CUSTOMERS * ORDERS_PER_CUSTOMER} orders, ${CUSTOMERS * ORDERS_PER_CUSTOMER * ITEMS_PER_ORDER} items)`);
    console.log('');
    console.log('route                p50 (ms)   p95 (ms)');
    for (const [route, { p50, p95 }] of Object.entries(results)) console.log(`${route.padEnd(20)}  ${p50.toFixed(1).padStart(8)}   ${p95.toFixed(1).padStart(8)}`);
    console.log('');
  });
}

// --- scenario 2: R8 item 1's own case — a wide Order, a wide Customer -------
async function benchWide() {
  await withServer(async (app, base) => {
    const store = app.store;
    let wideOrder;
    await store.transaction(async () => {
      const c = await store.insert('Customer', { name: 'Solo' });
      wideOrder = await store.insert('Order', { customer: c, status: 'new' });
      for (let i = 0; i < 20_000; i++) await store.insert('Item', { order: wideOrder, title: `Item ${i}`, qty: 1 + (i % 5), price: (1 + (i % 997) * 0.13).toFixed(2) });
    });
    let wideCustomer;
    await store.transaction(async () => {
      wideCustomer = await store.insert('Customer', { name: 'BigSpender' });
      for (let o = 0; o < 5000; o++) {
        const oid = await store.insert('Order', { customer: wideCustomer, status: o % 2 ? 'paid' : 'new' });
        for (let i = 0; i < 2; i++) await store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + i, price: 10 + i });
      }
    });

    const N = 30;
    const orderResult = await timeRequests(`${base}/Order/${wideOrder}`, {}, N);
    const custResult = await timeRequests(`${base}/Customer/${wideCustomer}`, {}, N);
    console.log("=== scenario 2: R8 item 1 — GET /Order/<one order, 20 000 items> and /Customer/<one customer, 5000 orders> ===");
    console.log(`GET /Order/<wide>     p50 ${orderResult.p50.toFixed(1)} ms   p95 ${orderResult.p95.toFixed(1)} ms`);
    console.log(`GET /Customer/<wide>  p50 ${custResult.p50.toFixed(1)} ms   p95 ${custResult.p95.toFixed(1)} ms`);
    console.log('');
  });
}

// --- scenario 3: R8 item 2 — RSS after heavy requests, before/after GC -----
async function seedFlat(store, orders) {
  await store.transaction(async () => {
    const c = await store.insert('Customer', { name: 'Heavy' });
    for (let o = 0; o < orders; o++) {
      const oid = await store.insert('Order', { customer: c, status: o % 2 ? 'paid' : 'new' });
      for (let i = 0; i < 5; i++) await store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + (i % 3), price: (5 + i * 2.5).toFixed(2) });
    }
  });
}

async function benchMemoryAt(orders) {
  await withServer(async (app, base) => {
    await seedFlat(app.store, orders);
    if (global.gc) global.gc();
    const rssBefore = rssMB();
    await fetch(`${base}/dashboard/sales`).then((r) => r.arrayBuffer());
    await fetch(`${base}/Order.csv`).then((r) => r.arrayBuffer());
    const rssAfterNoGC = rssMB();
    if (global.gc) global.gc();
    const rssAfterGC = rssMB();
    console.log(`${String(orders).padStart(6)} orders (${orders * 5} items)   before ${String(rssBefore).padStart(4)} MB   after ${String(rssAfterNoGC).padStart(4)} MB   after GC ${global.gc ? String(rssAfterGC).padStart(4) + ' MB' : '(run with --expose-gc)'}`);
  });
}

async function benchMemory() {
  console.log('=== scenario 3: R8 item 2 — RSS after /dashboard/sales + /Order.csv, before/after a forced GC ===');
  if (!global.gc) console.log('(node was not started with --expose-gc — the "after GC" column will be blank; "npm run bench" already passes it)');
  for (const orders of [2000, 8000, 40_000]) await benchMemoryAt(orders);
  console.log('');
}

// --- scenario 4: R9 items 1-3 — derived fields and dates inside an aggregate body ---
// One customer with 5000 orders (2 items each) plus 200 small customers. Every
// Customer aggregate has a body the round-8 compiler could not push down: a derived
// aggregate (total), a derived scalar (line), a derived value in a condition, a date
// comparison, a max over a date, and `today`.
async function benchDerived() {
  await withServer(async (app, base) => {
    const store = app.store;
    let wide;
    await store.transaction(async () => {
      wide = await store.insert('Customer', { name: 'BigSpender' });
      for (let o = 0; o < 5000; o++) {
        const oid = await store.insert('Order', { customer: wide, status: o % 2 ? 'paid' : 'new', placed: `2025-${String(1 + (o % 12)).padStart(2, '0')}-15` });
        for (let i = 0; i < 2; i++) await store.insert('Item', { order: oid, title: `Item ${i}`, qty: 1 + i, price: 10 + i, shipped: `2026-0${1 + (o % 9)}-01` });
      }
      for (let c = 0; c < 200; c++) {
        const cid = await store.insert('Customer', { name: `Small ${c}` });
        for (let o = 0; o < 10; o++) {
          const oid = await store.insert('Order', { customer: cid, status: 'new', placed: `2026-0${1 + (o % 9)}-10` });
          await store.insert('Item', { order: oid, title: 'x', qty: 2, price: (5 + o).toFixed(2), shipped: '2026-03-01' });
        }
      }
    });
    const N = 20;
    const rows = [];
    for (const [label, url] of [['GET /Customer/<wide, 5000 orders>', `${base}/Customer/${wide}`], ['GET /Customer (201 rows)', `${base}/Customer`], ['GET /Customer.csv', `${base}/Customer.csv`], ['GET /Order (page)', `${base}/Order`]]) {
      const r = await timeRequests(url, {}, N);
      rows.push(`${label.padEnd(34)} p50 ${r.p50.toFixed(1).padStart(7)} ms   p95 ${r.p95.toFixed(1).padStart(7)} ms`);
    }
    console.log('=== scenario 4: R9 items 1-3 — derived fields and dates inside aggregate bodies ===');
    for (const r of rows) console.log(r);
    console.log('');
  }, 'app2.json');
}

async function main() {
  await benchMain();
  await benchWide();
  await benchMemory();
  await benchDerived();
}

main().catch((e) => { console.error(e); process.exit(1); });
