// Index migration, attached to Store.prototype by store.mjs (so it runs with
// `this` bound to the Store instance — `this.db`, `this.prepare`, `this.fields`,
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
    if (!specs.has(key)) specs.set(key, { name: `idx_${table}_${cols.join('_')}`, cols });
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
  const existing = this.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE 'idx\\_%' ESCAPE '\\'`).all(table).map((r) => r.name);
  for (const { name, cols } of desired) {
    if (existing.includes(name)) continue;
    this.db.exec(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${cols.map((c) => `"${c}"`).join(', ')})`);
    this.migrations.push(`index ${table}.${name} (${cols.join(', ')})`);
  }
  const keep = new Set(desired.map((d) => d.name));
  for (const name of existing) {
    if (keep.has(name)) continue;
    this.db.exec(`DROP INDEX IF EXISTS "${name}"`);
    this.migrations.push(`dropped index ${name} on ${table}`);
  }
}

// The outbox: every effect that leaves the process is a row here first.
// "claimedAt" (epoch ms) is the lease of a row in `sending`; a database made
// before it existed is upgraded in place.
export function migrateOutbox() {
  this.db.exec(`CREATE TABLE IF NOT EXISTS "_outbox" (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, connector TEXT,
    target TEXT, payload TEXT, status TEXT, code INTEGER, error TEXT, attempts INTEGER DEFAULT 0, at TEXT, updatedAt TEXT, claimedAt INTEGER)`);
  const live = this.prepare(`PRAGMA table_info("_outbox")`).all().map((r) => r.name);
  if (!live.includes('claimedAt')) this.db.exec(`ALTER TABLE "_outbox" ADD COLUMN "claimedAt" INTEGER`);
}
