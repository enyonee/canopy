// The SQLite driver: the only module that touches `node:sqlite`. Everything above
// it (runtime/store*) speaks this small contract — `all/get/run/exec/transaction`
// plus schema helpers — so PRAGMA, sqlite_master and AUTOINCREMENT stay in here
// and another engine can implement the same object later. Synchronous today; the
// contract says results "may be awaited", and no caller in this repo awaits.
import { DatabaseSync } from 'node:sqlite';
import { sqlite as dialect } from './dialects.mjs';

// A prepared statement is reusable SQL text away from being re-parsed and
// re-planned by SQLite; bounded so a long-lived process with many distinct ad-hoc
// queries (a where clause per shape) never grows the cache without limit. A plain
// Map iterates in insertion order; re-inserting on a hit moves an entry to the
// end, so the entry evicted first is really the least recently used.
export const CACHE_MAX = 200;

/**
 * @param {string} file a path, or ':memory:'
 * @returns {import('../types.d.ts').Driver}
 */
export function openSqlite(file) {
  const db = new DatabaseSync(file);
  const cache = new Map();
  // `cache: false` skips the cache: the SQL text of an IN-list chunk rarely repeats,
  // and caching it would only evict statements that do.
  const stmt = (sql, opts) => {
    if (drv.onQuery) drv.onQuery(sql, opts);
    if (opts?.cache === false) return db.prepare(sql);
    const hit = cache.get(sql);
    if (hit) { cache.delete(sql); cache.set(sql, hit); return hit; }
    const st = db.prepare(sql);
    cache.set(sql, st);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return st;
  };
  const drv = {
    dialect,
    cache,
    onQuery: null,
    all: (sql, params = [], opts) => stmt(sql, opts).all(...params),
    get: (sql, params = [], opts) => stmt(sql, opts).get(...params),
    run(sql, params = [], opts) {
      const r = stmt(sql, opts).run(...params);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    exec(sql) {
      if (drv.onQuery) drv.onQuery(sql);
      db.exec(sql);
    },
    transaction(fn) {
      drv.exec('BEGIN');
      try { const out = fn(); drv.exec('COMMIT'); return out; }
      catch (e) { drv.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },

    // --- schema helpers: the SQL text is the dialect's, the driver only runs it -------
    tables: () => { const q = dialect.tablesSql(); return drv.all(q.sql, q.params).map((r) => String(r.name)); },
    columns(table) {
      const q = dialect.columnsSql(table);
      return drv.all(q.sql, q.params).map((r) => ({ name: String(r.name), type: String(r.type) }));
    },
    indexes(table, prefix = '') {
      const q = dialect.indexesSql(table, prefix);
      return drv.all(q.sql, q.params).map((r) => String(r.name));
    },
    // `cols` is [name, type][]; `serial` puts an auto-numbered integer `id` first.
    createTable: (table, cols, opts) => drv.exec(dialect.createTable(table, cols, opts)),
    addColumn: (table, name, type) => drv.exec(dialect.addColumn(table, name, type)),
    createIndex: (name, table, cols) => drv.exec(dialect.createIndex(name, table, cols)),
    dropIndex: (name) => drv.exec(dialect.dropIndex(name)),
  };
  return drv;
}
