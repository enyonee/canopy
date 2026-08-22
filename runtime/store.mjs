// Storage. The schema is derived from /data, never written by hand; a migration
// is the diff between the graph and the live table. Destructive steps need a marker.
import { DatabaseSync } from 'node:sqlite';
import { parseField, sqlType, defaultValue, coerce } from './spec.mjs';

export class Store {
  constructor(graph, file) {
    this.graph = graph;
    this.db = new DatabaseSync(file);
    this.fields = {};
    for (const [entity, spec] of Object.entries(graph.data)) {
      this.fields[entity] = Object.entries(spec).map(([n, s]) => parseField(n, s));
    }
    this.migrations = [];
    this.migrate();
  }

  migrate() {
    for (const [entity, fields] of Object.entries(this.fields)) {
      const table = entity.toLowerCase();
      const existing = this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
      if (!existing) {
        const cols = fields.map((f) => `"${f.name}" ${sqlType(f)}`).join(', ');
        this.db.exec(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT${cols ? ', ' + cols : ''})`);
        this.migrations.push(`create table ${table}`);
        continue;
      }
      const live = this.db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name);
      for (const f of fields) {
        if (!live.includes(f.name)) {
          this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${f.name}" ${sqlType(f)}`);
          // A declared default is a promise about every row, not only new ones.
          const seed = defaultValue(f);
          if (seed !== null) {
            const n = this.db.prepare(`UPDATE "${table}" SET "${f.name}"=? WHERE "${f.name}" IS NULL`).run(seed).changes;
            this.migrations.push(`add column ${table}.${f.name} (+ backfilled ${n} row(s) with ${JSON.stringify(seed)})`);
          } else this.migrations.push(`add column ${table}.${f.name}`);
        }
      }
      const declared = fields.map((f) => f.name);
      const orphan = live.filter((c) => c !== 'id' && !declared.includes(c));
      if (orphan.length && !this.graph.allowDestructive) {
        this.migrations.push(`kept orphan columns ${orphan.join(', ')} (destructive change needs "allowDestructive": true)`);
      }
    }
  }

  field(entity, name) { return this.fields[entity].find((f) => f.name === name); }

  insert(entity, values) {
    const fields = this.fields[entity];
    const cols = [], vals = [];
    for (const f of fields) {
      const given = values[f.name];
      cols.push(`"${f.name}"`);
      vals.push(given === undefined || given === '' ? defaultValue(f) : coerce(f, given));
    }
    const st = this.db.prepare(
      `INSERT INTO "${entity.toLowerCase()}" (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    return Number(st.run(...vals).lastInsertRowid);
  }

  update(entity, id, values) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(values)) {
      const f = this.field(entity, k);
      if (!f) continue;
      sets.push(`"${k}"=?`); vals.push(coerce(f, v));
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE "${entity.toLowerCase()}" SET ${sets.join(',')} WHERE id=?`).run(...vals, Number(id));
  }

  remove(entity, id) {
    this.db.prepare(`DELETE FROM "${entity.toLowerCase()}" WHERE id=?`).run(Number(id));
  }

  get(entity, id) {
    return this.db.prepare(`SELECT * FROM "${entity.toLowerCase()}" WHERE id=?`).get(Number(id));
  }

  // Structured query only: the graph names fields and comparisons, never SQL.
  list(entity, { search = [], q = '', where = {}, sort = null } = {}) {
    const table = entity.toLowerCase();
    const clauses = [], vals = [];
    for (const [field, cmp] of Object.entries(where)) {
      if (cmp === undefined || cmp === null) continue;
      clauses.push(`"${field}"=?`);
      vals.push(coerce(this.field(entity, field), cmp));
    }
    if (q && search.length) {
      clauses.push('(' + search.map((f) => `LOWER("${f}") LIKE ?`).join(' OR ') + ')');
      search.forEach(() => vals.push(`%${q.toLowerCase()}%`));
    }
    const order = sort ? `ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}` : 'ORDER BY id DESC';
    const sql = `SELECT * FROM "${table}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ${order}`;
    return this.db.prepare(sql).all(...vals);
  }
}
