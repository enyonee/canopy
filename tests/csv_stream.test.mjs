import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmpGraph } from './helpers.mjs';

const graph = {
  app: 'csvstream',
  data: {
    Group: { name: 'text' },
    Item: { name: 'text', group: 'ref:Group', rank: 'int', doubled: 'int := rank * 2' },
  },
  override: { 'Item.list': { columns: ['name', 'group', 'rank', 'doubled'] } },
  seed: { Group: [{ name: 'Fixture' }] },
};

test('CSV streams fixed-size SQL pages, preserves row order and quotes single CR and LF', async () => {
  const s = await boot(tmpGraph(graph));
  try {
    await s.app.store.transaction(async (tx) => {
      for (let rank = 0; rank < 520; rank++)
        await tx.insert('Item', { name: rank === 256 ? 'x\ny\rz' : `Item ${rank}`, group: 1, rank });
    });
    const requested = [];
    const batch = s.app.store.exportBatch.bind(s.app.store);
    s.app.store.exportBatch = (...args) => { requested.push(args[2].length); return batch(...args); };
    const r = await s.get('/Item.csv?sort=rank&dir=asc');
    assert.equal(r.status, 200);
    const lines = Array.from({ length: 520 }, (_, i) => `${i === 256 ? '"x\ny\rz"' : `Item ${i}`},Fixture,${i},${i * 2}`);
    assert.equal(r.html, ['Name,Group,Rank,Doubled', ...lines, ''].join('\r\n'));
    assert.deepEqual(requested, [256, 256, 8]);
    requested.length = 0;
    const derived = await s.get('/Item.csv?sort=doubled&dir=desc');
    assert.equal(derived.html, ['Name,Group,Rank,Doubled', ...lines.reverse(), ''].join('\r\n'));
    assert.deepEqual(requested, []);
  } finally { s.close(); }
});

test('CSV failures after headers abort the download without writing a second response', async () => {
  const s = await boot(tmpGraph(graph));
  try {
    await s.app.store.insert('Item', { name: 'fixture', rank: 1 });
    s.app.store.exportBatch = () => { throw new Error('CSV export batch failed'); };
    await assert.rejects(s.get('/Item.csv'));
    assert.equal((await s.get('/Item')).status, 200);
    assert.ok(s.trace().some((e) => e.kind === 'error' && /CSV export batch failed/.test(e.message)));
  } finally { s.close(); }
});

test('CSV treats formula-like text as text but keeps signed numbers numeric', async () => {
  const s = await boot(tmpGraph({ ...graph, seed: { ...graph.seed, Item: [
    { name: '  =1+1', rank: -7 }, { name: '\uFF20name', rank: 2 }, { name: 'ordinary', rank: 3 },
  ] } }));
  try {
    const r = await s.get('/Item.csv?sort=rank&dir=asc');
    assert.equal(r.html, "Name,Group,Rank,Doubled\r\n'  =1+1,,-7,-14\r\n'\uFF20name,,2,4\r\nordinary,,3,6\r\n");
  } finally { s.close(); }
});
