// Hydration: the load phase of S3a. A derived field is never evaluated against the database.
// Before evaluate() runs, `loadSnapshot` fetches everything the expression tree can touch — the
// read-set runtime/store/plan.mjs computes from the graph — level by level: the rows a reference
// hop points at (one `WHERE id IN (…)` per hop per level), the SQL-compiled aggregates of every
// row (aggsql's batch), the child rows of the others (one `listRawIn` per level, then the child
// entity's own plan). The query count is bounded by the size of the plan, not by the number of
// rows. Then evaluate() runs over a Snapshot (runtime/store/snapshot.mjs) whose reads are Map
// lookups and whose miss throws.
//
// Attached to Store.prototype by store.mjs (`this` is the Store). The old lazy path (lazy.mjs)
// stays behind the test-only switch `store.lazyEval`; rules and step values still use it.
import { compileAgg, runAggBatch, aggKey } from './aggsql.mjs';
import { planFor, planFallback } from './plan.mjs';
import { Snapshot, refKey } from './snapshot.mjs';

// The aggregate an `agg` node of a plan stands for, over `rows` of the plan node's entity.
function loadAgg(store, snap, node, entry, rows) {
  if (entry.compiled) {
    const key = aggKey(entry.compiled);
    if (!snap.declined.has(key)) {
      const missing = rows.filter((r) => !snap.hasScalar(key, r.id)).map((r) => r.id);
      if (missing.length) {
        const batch = runAggBatch(store, entry.compiled, missing, snap.clock);
        if (batch === undefined) snap.declined.add(key); else snap.addScalars(key, batch);
      }
    }
    // Integers past what SQLite holds: this aggregate is answered by evaluate() over child rows.
    if (!snap.declined.has(key)) return;
    planFallback(store, node, entry);
  }
  if (entry.via === null) {
    if (!snap.all.has(entry.child)) snap.all.set(entry.child, store.listRaw(entry.child));
    loadNode(store, snap, entry.sub, snap.all.get(entry.child));
    return;
  }
  const key = `${entry.child}|${entry.via}`;
  const missing = rows.filter((r) => !snap.hasGroup(key, r.id)).map((r) => r.id);
  if (missing.length) snap.addGroups(key, missing, store.listRawIn(entry.child, entry.via, missing));
  loadNode(store, snap, entry.sub, rows.flatMap((r) => snap.group(key, r.id)));
}

// Everything plan node `node` needs for `rows` (raw rows of its entity, already in the snapshot).
function loadNode(store, snap, node, rows) {
  if (!rows.length) return;
  for (const [field, sub] of node.hops) {
    const target = store.field(node.entity, field).target;
    const keys = [...new Set(rows.map((r) => refKey(r[field])).filter((k) => k !== null))];
    snap.putRows(target, store.listRawByIds(target, keys.filter((k) => !snap.hasRow(target, k))), keys);
    loadNode(store, snap, sub, keys.map((k) => snap.row(target, k)).filter(Boolean));
  }
  for (const entry of node.aggs.values()) loadAgg(store, snap, node, entry, rows);
}

// A snapshot able to evaluate the derived fields `fields` (all of them when null) of `rows`
// of `entity`; `clock` is the evaluation's one clock.
export function loadSnapshot(entity, rows, fields = null, clock = new Date()) {
  const snap = new Snapshot(this, clock);
  snap.putRows(entity, rows, rows.map((r) => String(r.id)));
  loadNode(this, snap, planFor(this, entity, fields), rows);
  return snap;
}

// The compiled form of an aggregate node read in `entity` — or null. A method so a test can
// switch the SQL compiler off for both paths (the JS reference of tests/aggfuzz.test.mjs).
export function compileAggIn(entity, node) { return compileAgg(this, entity, node); }

// The derived field `f` of one raw row (labelOf: a label never needs the row's other fields).
export function deriveOne(entity, row, f) {
  if (this.lazyEval) return this.derived(entity, row, f);
  return this.loadSnapshot(entity, [row], [f.name]).derived(entity, row, f);
}

// How many rows to load and hydrate at once. A page of thousands of rows (a full CSV export,
// an in-memory dashboard aggregate) never holds every child it needed for the whole request,
// only one chunk's worth: the snapshot of a chunk is garbage the moment the chunk is hydrated.
const HYDRATE_CHUNK = 500;

function hydrateChunk(entity, rows, clock) {
  if (this.lazyEval) return this.hydratePageLazy(entity, rows);
  const snap = this.loadSnapshot(entity, rows, null, clock);
  return rows.map((row) => {
    const out = { ...row };
    for (const f of this.fields[entity]) if (f.derive) out[f.name] = snap.derived(entity, row, f);
    return out;
  });
}

// Hydrates a page of rows of one entity in a bounded number of queries, chunked (above).
export function hydratePage(entity, rows) {
  if (!rows.length) return [];
  const clock = new Date();
  const out = [];
  for (let i = 0; i < rows.length; i += HYDRATE_CHUNK) out.push(...hydrateChunk.call(this, entity, rows.slice(i, i + HYDRATE_CHUNK), clock));
  return out;
}
