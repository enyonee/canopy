// node bench/dependencies.mjs <checkout> <stripe|uploads>
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [root, scenario] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(path.resolve(root, file)).href);

async function stripe() {
  const { loadPlugins } = await load('runtime/registry.mjs');
  const { registry, errors } = await loadPlugins({ plugins: ['connectors/stripe/descriptor.json'] }, path.resolve(root));
  assert.deepEqual(errors, []);
  const row = { op: 'retrievePaymentIntent', payload: { id: 'pi_bench' } };
  const raw = '{"id":"pi_bench","status":"succeeded","amount":100,"currency":"usd"}';
  const opts = { secret: () => 'sk_test_fixture', idemKey: 'fixture', fetchImpl: async () => new Response(raw) };
  return { count: 150, run: async () => {
    const result = await registry.transports.stripe.deliver(row, {}, opts);
    assert.equal(result.response, raw);
    assert.equal(result.result, '{"id":"pi_bench","status":"succeeded"}');
  } };
}

async function uploads(dir) {
  const { createContext } = await load('runtime/routes/context.mjs');
  const chunk = Buffer.alloc(64 * 1024, 'a'), count = 64;
  const start = Buffer.from('--bench\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\nContent-Type: text/plain\r\n\r\n');
  const end = Buffer.from('\r\n--bench--\r\n');
  const inputs = [start, ...Array(count).fill(chunk), end];
  return { count: 15, run: async () => {
    const req = Object.assign(Readable.from(inputs, { objectMode: false }), {
      headers: { 'content-type': 'multipart/form-data; boundary=bench' },
    });
    const ctx = await createContext({ req, url: new URL('http://localhost/Doc'), filesDir: dir, graph: {},
      interp: { resolve: () => null }, perms: { enabled: false } });
    const { file } = await ctx.body();
    const target = path.join(dir, file);
    assert.equal((await fs.stat(target)).size, chunk.length * count);
    await fs.unlink(target);
  } };
}

const factories = { stripe, uploads };
assert.ok(Object.hasOwn(factories, scenario), 'choose stripe or uploads');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-sdk-bench-'));
try {
  const { count, run } = await factories[scenario](dir);
  for (let i = 0; i < 5; i++) await run();
  const samples = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const percentile = (p) => samples[Math.ceil(p * samples.length) - 1];
  console.log(JSON.stringify({ scenario, p50Ms: percentile(0.5), p95Ms: percentile(0.95), peakMiB: process.resourceUsage().maxRSS / 1024 }));
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
