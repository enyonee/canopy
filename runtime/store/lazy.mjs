// The lazy path — what hydration was before S3a: every read that is not in the page cache asks
// the store while evaluate() runs. Kept for one release behind the test-only switch
// `store.lazyEval = true` (tests/snapshot.test.mjs and tests/evaldiff.test.mjs diff it against the
// snapshot path over every app; rules and step values reach it through Store#evalCtx). Attached to
// Store.prototype by store.mjs like the other store/ modules (`this` is the Store).
import { compileAgg, runAggOne, runAggBatch, aggKey } from './aggsql.mjs';

// Every `agg` node directly in scope of the entity being hydrated — not one
// nested inside another aggregate's own body, which is scoped against the
// *child* entity instead and is exactly what the recursive prefetch below
// reaches on its own. `sum(x) + count(y)` yields both; `count(y)`'s own body
// is never descended into here.
function topAggs(node, out = []) {
  if (!node) return out;
  if (node.t === 'agg') { out.push(node); return out; }
  if (node.t === 'bin') { topAggs(node.a, out); topAggs(node.b, out); }
  else if (node.t === 'un') topAggs(node.a, out);
  else if (node.t === 'call') node.args.forEach((a) => topAggs(a, out));
  return out;
}

// Prefetches, for every plain child-aggregate declared directly on `entity`,
// either its SQL-computed value (runtime/store/aggsql.mjs's compileAgg — one
// grouped query, no child row ever reaches JS: `cache.scalars`) or, when the
// body is not representable in SQL, the children of all `ids` in one query —
// grouped by parent id — then recurses into the child entity with the ids
// just fetched, so a chain of aggregates (a customer's spend, over each
// order's own total, over each order's own items) batches at every level:
// the recursion reaches `Order.total` again from `Order`'s own side, where
// it compiles even though `Customer.spent := sum(Order: total)` itself does
// not (`total` is not a stored field). `cache` is purely additive:
// `Store#ctx()`'s `agg`/`rows` consult it first and, on a miss (no `via` —
// an aggregate over unrelated/sibling rows, one case left unbatched either
// way — or an entity already visited, `seen` guarding a derived-field cycle
// same as `Store#derived` does), run the exact query they always would.
// Correctness never depends on this cache existing.
export function buildAggCache(entity, ids, cache = { groups: new Map(), scalars: new Map(), clock: new Date() }, seen = new Set()) {
  if (seen.has(entity) || !ids.length) return cache;
  seen.add(entity);
  for (const f of this.fields[entity] || []) {
    if (!f.derive) continue;
    for (const agg of topAggs(f.derive)) {
      const compiled = compileAgg(this, entity, agg);
      if (compiled) {
        const key = aggKey(compiled);
        if (!cache.scalars.has(key)) {
          const batch = runAggBatch(this, compiled, ids, cache.clock);
          if (batch) cache.scalars.set(key, batch);
        }
        continue; // the aggregate itself is the answer — no child row, nothing to recurse into
      }
      const via = this.childVia(agg.entity, entity, agg.via);
      if (!via) continue; // no direct link back — the one case left unbatched
      const key = `${agg.entity}|${via}`;
      if (cache.groups.has(key)) continue;
      const rows = this.listRawIn(agg.entity, via, ids);
      // A `ref` column is stored as TEXT (runtime/fields.mjs's ref.sql), so a
      // child's raw via-value is a string even though the parent's own `id` is
      // a real number (the rowid) — grouped by the string form of both, or
      // every group would come up empty against a SQL-correct (and thus
      // type-coercing) equality that never noticed the mismatch.
      const grouped = new Map(ids.map((id) => [String(id), []]));
      for (const r of rows) grouped.get(String(r[via]))?.push(r);
      cache.groups.set(key, grouped);
      const childIds = rows.map((r) => r.id);
      if (childIds.length) this.buildAggCache(agg.entity, childIds, cache, seen);
    }
  }
  return cache;
}

// The single answer to one `agg` AST node for one row — `Store#ctx()`'s
// `agg` hook, consulted by runtime/expr.mjs's evaluate() before it ever asks
// `ctx.rows()` for anything. `undefined` means "not representable in SQL",
// the signal evaluate() reads as "compute it the old way". A page-level
// batch (`cache.scalars`, built above) is used when there is one; otherwise
// (a lone `Store#get()`, or a row this particular cache never batched) one
// small query answers just this row, still without fetching a single child.
export function aggValue(entity, row, node, cache, clock) {
  const compiled = compileAgg(this, entity, node);
  if (!compiled) return undefined;
  // A batch was bound to the page's one clock: another clock (there is none today —
  // ctx() hands the cache's own to evaluate()) would need its own query.
  const batch = compiled.params.length && clock !== cache?.clock ? undefined : cache?.scalars?.get(aggKey(compiled));
  const hit = batch?.get(String(row.id));
  return hit !== undefined ? hit : runAggOne(this, compiled, row.id, clock);
}

// One row, hydrated the lazy way: each derived field is evaluated over a RowCtx that queries on
// demand (or reads `cache`, when a page built one).
export function hydrateLazy(entity, row, cache = null) {
  if (!row) return row;
  const out = { ...row };
  for (const f of this.fields[entity]) if (f.derive) out[f.name] = this.derived(entity, row, f, [], cache);
  return out;
}

// A chunk of a page, the lazy way: one cache for the chunk (buildAggCache, above), then row by row.
export function hydratePageLazy(entity, rows) {
  const cache = this.buildAggCache(entity, rows.map((r) => r.id));
  return rows.map((r) => this.hydrateLazy(entity, r, cache));
}
