// Index migration, attached to Store.prototype by store.mjs (so it runs with
// `this` bound to the Store instance — `this.drv`, `this.fields`,
// `this.graph`). Split out only to keep store.mjs under the size budget.
//
// The plain-index derivation for one entity (item: "indexes derived from the
// graph"): every `ref` column (this subsumes an "own" field too — checkOwnPath
// in check/roles.mjs requires it to already be a `ref:<roles.entity>` field),
// every `rules.unique` (single field or compound), the `states` status field,
// and — best effort, only top-level where-keys that are cheap to collect —
// fields named in a saved list's or a dashboard's `where`. Deduplicated by the
// exact column tuple, so a field indexed for two reasons gets one index.
function desiredIndexes(store, entity) {
  const table = entity.toLowerCase();
  const specs = new Map();
  const add = (cols) => {
    const key = cols.join(',');
    if (!specs.has(key)) specs.set(key, { name: store.drv.dialect.indexName(table, cols), cols });
  };
  for (const f of store.fields[entity] || []) if (f.kind === 'ref') add([f.name]);
  for (const r of store.graph.rules?.[entity] || []) if (r.unique !== undefined) add(Array.isArray(r.unique) ? r.unique : [r.unique]);
  const statusField = store.graph.states?.[entity]?.field;
  if (statusField) add([statusField]);
  for (const cols of whereFieldsFor(store, entity)) add(cols);
  return [...specs.values()];
}

// Top-level keys of a `where` object naming a stored field of `entity`, out of
// every saved list and every dashboard card/table/chart in the graph — the
// value never matters (a range, "@me", a literal), only which column it filters.
function whereFieldsFor(store, entity) {
  const cols = new Set();
  const consider = (ent, where) => {
    if (ent !== entity || !where || typeof where !== 'object') return;
    for (const k of Object.keys(where)) {
      const f = k !== 'id' && store.field(entity, k);
      if (f && !f.derive) cols.add(k);
    }
  };
  for (const l of store.graph.lists || []) consider(l.entity, l.where);
  for (const d of store.graph.dashboards || []) for (const s of [...(d.cards || []), ...(d.tables || []), ...(d.charts || [])]) consider(s.entity, s.where);
  return [...cols].map((c) => [c]);
}

// Indexes are never destructive (dropping one loses no data), so — unlike an
// orphan column — a no-longer-desired one is dropped unconditionally: created
// and dropped exactly like a column, idempotent, reported the same way
// (`this.migrations.push('index …')`, printed as `migration: index …`).
export function migrateIndexes(entity) {
  const table = entity.toLowerCase();
  const desired = desiredIndexes(this, entity);
  const existing = this.drv.indexes(table, 'idx_');
  for (const { name, cols } of desired) {
    if (existing.includes(name)) continue;
    this.drv.createIndex(name, table, cols);
    this.migrations.push(`index ${table}.${name} (${cols.join(', ')})`);
  }
  const keep = new Set(desired.map((d) => d.name));
  for (const name of existing) {
    if (keep.has(name)) continue;
    this.drv.dropIndex(name);
    this.migrations.push(`dropped index ${name} on ${table}`);
  }
}

// The outbox: every effect that leaves the process is a row here first.
// "claimedAt" (epoch ms) is the lease of a row in `sending`; "op" is the descriptor operation
// the row calls, "response" the (capped) answer text, "result" the fields the operation maps out
// of it, "drift" 1 when the answer did not fit its schema. A database made before any of these
// existed is upgraded in place, one column at a time. "nextAttemptAt" (epoch ms) holds a queued row back until a retry is
// due, "idemKey" is the idempotency key fixed at enqueue. `_breaker` is the circuit breaker of each connector and mode.
const OUTBOX_LATER = [['claimedAt', 'INTEGER'], ['op', 'TEXT'], ['response', 'TEXT'], ['result', 'TEXT'], ['drift', 'INTEGER'],
  ['nextAttemptAt', 'INTEGER'], ['idemKey', 'TEXT']];
export function migrateOutbox() {
  this.drv.createTable('_outbox', [['kind', 'TEXT'], ['connector', 'TEXT'], ['target', 'TEXT'], ['payload', 'TEXT'],
    ['status', 'TEXT'], ['code', 'INTEGER'], ['error', 'TEXT'], ['attempts', 'INTEGER DEFAULT 0'], ['at', 'TEXT'],
    ['updatedAt', 'TEXT'], ...OUTBOX_LATER], { ifNotExists: true });
  const live = this.drv.columns('_outbox').map((r) => r.name);
  for (const [name, type] of OUTBOX_LATER) if (!live.includes(name)) this.drv.addColumn('_outbox', name, type);
  this.drv.createTable('_breaker', [['key', 'TEXT PRIMARY KEY'], ['connector', 'TEXT'], ['mode', 'TEXT'], ['state', 'TEXT'], ['failures', 'INTEGER DEFAULT 0'],
    ['openUntil', 'INTEGER DEFAULT 0'], ['cooldownMs', 'INTEGER DEFAULT 0'], ['probeClaimedAt', 'INTEGER DEFAULT 0']], { ifNotExists: true, serial: false });
}
