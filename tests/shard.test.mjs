import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShard, inShard } from './shard.mjs';

test('parseShard accepts i/n and rejects everything else', () => {
  assert.deepEqual(parseShard('3/8'), { i: 3, n: 8 });
  assert.deepEqual(parseShard('1/1'), { i: 1, n: 1 });
  for (const bad of ['', undefined, '3', '0/8', '9/8', '1/0', 'a/b', '1/8/2', '-1/8', '1.5/8', ' 1/8', '1/8 ']) {
    assert.throws(() => parseShard(bad), /MUTATE_SHARD/, String(bad));
  }
});

test('shards are disjoint and their union is every index', () => {
  for (const [total, n] of [[0, 8], [5, 8], [8, 8], [410, 8], [411, 1], [97, 7]]) {
    const seen = new Map();
    for (let i = 1; i <= n; i++) {
      for (let idx = 0; idx < total; idx++) {
        if (inShard(idx, { i, n })) {
          assert.ok(!seen.has(idx), `index ${idx} is in shards ${seen.get(idx)} and ${i}`);
          seen.set(idx, i);
        }
      }
    }
    assert.equal(seen.size, total, `${total} mutations over ${n} shards`);
  }
});

test('shard sizes differ by at most one; no shard means everything', () => {
  const sizes = Array.from({ length: 8 }, (_, k) => Array.from({ length: 410 }, (_, idx) => idx).filter((idx) => inShard(idx, { i: k + 1, n: 8 })).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  assert.equal(inShard(123, null), true);
});
