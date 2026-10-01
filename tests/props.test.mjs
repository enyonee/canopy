// Properties, not examples: statements that must hold for any graph the format accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { validate } from '../runtime/validate.mjs';
import { Store } from '../runtime/store.mjs';
import { parseField, coerce, defaultValue } from '../runtime/spec.mjs';
import { serve } from '../runtime/server.mjs';
import { tmpDir } from './helpers.mjs';

// A tiny deterministic generator: the same seed always produces the same graphs.
let seed = 20260822;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (xs) => xs[Math.floor(rnd() * xs.length) % xs.length];
const KINDS = ['text!', 'text', 'longtext', 'int=0', 'bool=false', 'bool=true', 'time=now', 'enum[a,b]=a'];

function randomGraph(i) {
  const entities = {};
  const names = ['Alpha', 'Beta', 'Gamma'].slice(0, 1 + Math.floor(rnd() * 3));
  names.forEach((n, j) => {
    const fields = { name: 'text!' };
    for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) fields[`f${k}`] = pick(KINDS);
    if (j > 0 && rnd() > 0.4) fields.parent = `ref:${names[0]}`;
    entities[n] = fields;
  });
  return { app: `gen${i}`, data: entities, views: 'auto' };
}

test('any graph the checker accepts also boots, migrates and serves', async () => {
  for (let i = 0; i < 25; i++) {
    const graph = randomGraph(i);
    assert.deepEqual(validate(graph), [], `generated graph ${i} must be valid by construction`);
    const dir = tmpDir('ag-prop-');
    const file = path.join(dir, 'app.json');
    fs.writeFileSync(file, JSON.stringify(graph));
    const app = serve({ graphFile: file, dbFile: path.join(dir, 'd.sqlite'), traceFile: null, port: 0 });
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    try {
      for (const entity of Object.keys(graph.data)) {
        for (const p of [`/${entity}`, `/${entity}/new`]) {
          const r = await fetch(base + p);
          assert.equal(r.status, 200, `${p} of graph ${i} did not render`);
          await r.text();
        }
      }
    } finally { app.server.closeAllConnections(); app.server.close(); }
  }
});

test('migration is idempotent for any generated graph', () => {
  for (let i = 0; i < 25; i++) {
    const graph = randomGraph(i);
    const file = path.join(tmpDir('ag-mig-'), 'd.sqlite');
    new Store(graph, file);
    assert.deepEqual(new Store(graph, file).migrations, [], `graph ${i} migrated twice`);
    assert.deepEqual(new Store(graph, file).migrations, []);
  }
});

test('growing a graph never loses rows and always fills the new default', async () => {
  for (let i = 0; i < 15; i++) {
    const graph = randomGraph(i);
    const entity = Object.keys(graph.data)[0];
    const file = path.join(tmpDir('ag-grow-'), 'd.sqlite');
    const before = new Store(graph, file);
    // "text!" fields with no default are required: give every one a value, or the
    // store's own required check (correctly) refuses the row.
    const required = Object.entries(graph.data[entity]).filter(([n, spec]) => n !== 'name' && spec === 'text!').map(([n]) => n);
    for (let k = 0; k < 3; k++) await before.insert(entity, { name: `row ${k}`, ...Object.fromEntries(required.map((n) => [n, `v${k}`])) });
    const grown = { ...graph, data: { ...graph.data, [entity]: { ...graph.data[entity], added: 'enum[x,y]=x' } } };
    const after = new Store(grown, file);
    const rows = await after.list(entity, {});
    assert.equal(rows.length, 3, 'rows survive the migration');
    assert.ok(rows.every((r) => r.added === 'x'), 'every old row gets the declared default');
  }
});

test('what a form sends and what a block sends land on the same value', () => {
  const cases = [['bool=false', ['on', 'true', true, 1, '1'], 1], ['bool=false', ['', 'false', false, 0, undefined], 0],
    ['int=0', ['42', 42], 42], ['text', ['x', 'x'], 'x']];
  for (const [spec, inputs, expected] of cases) {
    const f = parseField('f', spec);
    for (const v of inputs) assert.equal(coerce(f, v), expected, `${spec} must read ${JSON.stringify(v)} as ${expected}`);
  }
});

test('a stored row reads back exactly what was declared or sent, for every kind', async () => {
  const data = { A: {} };
  KINDS.forEach((k, i) => { data.A[`f${i}`] = k; });
  const store = new Store({ app: 'x', data }, ':memory:');
  // "text!" has no default and is required: the store refuses to fill it in
  // silently, so the round trip is of a given value, not of a default.
  const given = {};
  KINDS.forEach((k, i) => { if (k === 'text!') given[`f${i}`] = `required ${i}`; });
  const id = await store.insert('A', given);
  const row = await store.get('A', id);
  KINDS.forEach((k, i) => {
    const f = parseField(`f${i}`, k);
    const expected = k === 'text!' ? given[`f${i}`] : defaultValue(f);
    if (f.kind === 'time') assert.match(row[`f${i}`], /^\d{4}-/);
    else assert.equal(row[`f${i}`], expected, `${k} did not round-trip`);
  });
});

test('the trace of a run replays to the same state', async () => {
  const dir = tmpDir('ag-replay-');
  const run = async (folder) => {
    const app = serve({ graphFile: 'tests/fixtures/kitchen.json', dbFile: path.join(folder, 'd.sqlite'),
      traceFile: path.join(folder, 't.jsonl'), port: 0 });
    await once(app.server, 'listening');
    try {
      const base = `http://127.0.0.1:${app.server.address().port}`;
      const post = (p, b) => fetch(base + p, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b).toString() }).then((r) => r.text());
      await post('/Post', { title: 'one', topic: '1', rank: '2', mood: 'calm' });
      await post('/Post', { title: 'two', topic: '2', rank: '1', mood: 'loud' });
      await post('/Post/1/action/pin', {});
      const rows = (await app.store.list('Post', { sort: { field: 'title', dir: 'asc' } }))
        .map((r) => ({ title: r.title, topic: r.topic, pinned: r.pinned, rank: r.rank }));
      const kinds = fs.readFileSync(path.join(folder, 't.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
      return { rows, kinds };
    } finally { app.server.closeAllConnections(); app.server.close(); }
  };
  const a = await run(fs.mkdtempSync(path.join(dir, 'a-')));
  const b = await run(fs.mkdtempSync(path.join(dir, 'b-')));
  assert.deepEqual(a.rows, b.rows, 'the same inputs must produce the same state');
  assert.deepEqual(a.kinds, b.kinds, 'the same inputs must produce the same trace');
});
