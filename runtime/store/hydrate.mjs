// Batched aggregate hydration (round 7's item 3, round 8's item 1/2),
// attached to Store.prototype by store.mjs (`this.db`, `this.field(...)`,
// `this.fields[...]`, `this.childVia`, `this.listRawIn`, `this.hydrate` —
// query.mjs's own listing functions, a sibling on the same prototype).
// Split out of store/query.mjs only to keep that module under the line
// budget; this is exactly as much "the query engine" as anything there.
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
export function buildAggCache(entity, ids, cache = { groups: new Map(), scalars: new Map() }, seen = new Set()) {
  if (seen.has(entity) || !ids.length) return cache;
  seen.add(entity);
  for (const f of this.fields[entity] || []) {
    if (!f.derive) continue;
    for (const agg of topAggs(f.derive)) {
      const compiled = compileAgg(this, entity, agg);
      if (compiled) {
        const key = aggKey(compiled);
        if (!cache.scalars.has(key)) cache.scalars.set(key, runAggBatch(this, compiled, ids));
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
export function aggValue(entity, row, node, cache) {
  const compiled = compileAgg(this, entity, node);
  if (!compiled) return undefined;
  const batch = cache?.scalars?.get(aggKey(compiled));
  const hit = batch?.get(String(row.id));
  return hit !== undefined ? hit : runAggOne(this, compiled, row.id);
}

// How many parents' worth of aggregate cache to build and hydrate at once.
// Item 2's memory fix: a page of thousands of rows (a full CSV export, an
// in-memory dashboard aggregate) no longer holds every batched child of
// every one of them for the whole request — only one chunk's worth, which
// buildAggCache's own cache (and every raw child row it fetched) is free to
// be garbage-collected the moment hydratePageChunk returns. Most aggregates
// compile to SQL now (buildAggCache above) and never fetch a child row at
// all; this chunking is for what is left — a correlated or nested aggregate
// still batched the old way.
const HYDRATE_CHUNK = 500;

function hydratePageChunk(entity, rows) {
  const cache = this.buildAggCache(entity, rows.map((r) => r.id));
  return rows.map((r) => this.hydrate(entity, r, cache));
}

// Hydrates a whole page of rows of the same entity in a bounded number of
// queries instead of one per row per aggregate derived field: one query per
// distinct (child, via) pair reached from `entity`, at every depth, however
// many rows are on the page — chunked (above) so memory stays bounded by the
// chunk, not by the page.
export function hydratePage(entity, rows) {
  if (!rows.length) return [];
  if (rows.length <= HYDRATE_CHUNK) return hydratePageChunk.call(this, entity, rows);
  const out = [];
  for (let i = 0; i < rows.length; i += HYDRATE_CHUNK) out.push(...hydratePageChunk.call(this, entity, rows.slice(i, i + HYDRATE_CHUNK)));
  return out;
}
