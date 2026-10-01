// Shard selection for the mutation gate, kept apart from tests/mutate.mjs: importing that file runs mutations.

// "i/n", 1-based i. Returns { i, n } or throws on anything else (the gate fails closed).
export function parseShard(value) {
  const m = /^(\d+)\/(\d+)$/.exec(String(value ?? ''));
  if (!m) throw new Error(`MUTATE_SHARD must look like "i/n" (1 <= i <= n), got "${value}"`);
  const i = Number(m[1]), n = Number(m[2]);
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(n) || n < 1 || i < 1 || i > n) {
    throw new Error(`MUTATE_SHARD "${value}" is out of range: need 1 <= i <= n`);
  }
  return { i, n };
}

// Does the mutation at `index` of the full list belong to shard `shard` ({ i, n })? No shard: all of them.
export const inShard = (index, shard) => !shard || index % shard.n === shard.i - 1;
