// Run against any checkout: node bench/hotpaths.mjs <checkout> <steps|connector>
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const load = (file) => import(pathToFileURL(resolve(root, file)).href);

async function stepFixture() {
  const { createInterpreter } = await load('runtime/interp.mjs');
  // An in-memory store context isolates the interpreter from SQLite and HTTP.
  const store = { evalCtx: (_entity, row) => ({ get: (p) => row[p[0]] }) };
  const interp = createInterpreter({ graph: {}, store, registry: { blocks: {} } });
  const total = 'qty * price + adjustment + tax + freight - discount';
  const batch = ['=' + total, '=' + total + ' + values.surcharge - values.credit'];
  const contexts = Array.from({ length: 16 }, (_, i) => ({
    rowEntity: 'Order', row: { qty: i + 1, price: 32, adjustment: 7, tax: 15, freight: 22, discount: 4 },
    values: { surcharge: 5, credit: i },
  }));
  return {
    run: (i) => interp.resolve(contexts[i % contexts.length])(batch),
    expected: (i) => {
      const { row, values } = contexts[i % contexts.length];
      const subtotal = row.qty * row.price + row.adjustment + row.tax + row.freight - row.discount;
      return [subtotal, subtotal + values.surcharge - values.credit];
    },
    size: 5000,
  };
}

async function connectorFixture() {
  const { mapResponse } = await load('runtime/connectors/engine.mjs');
  const properties = {
    id: { type: 'integer' }, title: { type: 'string' }, status: { type: 'string', enum: ['active', 'archived'] },
    amount: { type: 'number', minimum: 0 }, closed: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
  };
  const op = {
    output: { type: 'object', properties: { data: { type: 'array', items: {
      type: 'object', properties, required: ['id', 'title', 'amount'],
    } } } },
    result: { first: '$.data[0].id', last: '$.data[249].id' }, resultOnly: true,
  };
  const data = Array.from({ length: 250 }, (_, id) => ({
    id, title: `Deal ${id}`, status: 'active', amount: id * 25, closed: false, tags: ['new', 'retail'], providerOnly: id,
  }));
  const raw = JSON.stringify({ data });
  const reply = { status: 200, ok: true, text: async () => raw };
  return {
    run: () => mapResponse(op, reply),
    expected: () => ({ patch: { code: 200, status: 'sent', error: null, result: '{"first":0,"last":249}', drift: 0 }, drift: [] }),
    size: 100,
  };
}

const fixtures = { steps: stepFixture, connector: connectorFixture };
const scenario = process.argv[3];
if (!Object.hasOwn(fixtures, scenario)) throw new Error('choose steps or connector');
const { run, expected, size } = await fixtures[scenario]();
const hash = createHash('sha256');
for (let i = 0; i < size * 5; i++) {
  const result = JSON.stringify(await run(i));
  if (i < size) {
    if (result !== JSON.stringify(expected(i))) throw new Error(`unexpected ${scenario} output: ${result}`);
    hash.update(result + '\n');
  }
}
const samples = [];
for (let j = 0; j < 25; j++) {
  const start = performance.now();
  for (let i = 0; i < size; i++) await run(i);
  samples.push((performance.now() - start) * 1000 / size);
}
samples.sort((a, b) => a - b);
const mid = samples[12];
console.log(JSON.stringify({
  scenario, medianUs: mid, p95BatchUs: samples[23], opsPerSec: 1e6 / mid,
  peakRssMiB: process.resourceUsage().maxRSS / 1024, sha256: hash.digest('hex'),
}));
