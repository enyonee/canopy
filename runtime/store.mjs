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
        if (live.includes(f.name)) continue;
        this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${f.name}" ${sqlType(f)}`);
        // A declared default is a promise about every row, not only new ones.
        const seed = defaultValue(f);
        if (seed !== null) {
          const n = this.db.prepare(
            `UPDATE "${table}" SET "${f.name}"=? WHERE "${f.name}" IS NULL`).run(seed).changes;
          this.migrations.push(`add column ${table}.${f.name} (+ backfilled ${n} row(s) with ${JSON.stringify(seed)})`);
        } else this.migrations.push(`add column ${table}.${f.name}`);
      }
      const declared = fields.map((f) => f.name);
      const orphan = live.filter((c) => c !== 'id' && !declared.includes(c));
      if (orphan.length && !this.graph.allowDestructive) {
        this.migrations.push(`kept orphan columns ${orphan.join(', ')} (destructive change needs "allowDestructive": true)`);
      }
    }
  }

  field(entity, name) { return (this.fields[entity] || []).find((f) => f.name === name); }

  // Display name of a row: the entity's first plain text field, or #id.
  labelField(entity) {
    const f = (this.fields[entity] || []).find((x) => x.kind === 'text');
    return f ? f.name : null;
  }
  label(entity, row) {
    if (!row) return '';
    const lf = this.labelField(entity);
    return lf && row[lf] ? String(row[lf]) : `#${row.id}`;
  }

  insert(entity, values) {
    const cols = [], vals = [];
    for (const f of this.fields[entity]) {
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
    if (id === undefined || id === null || id === '') return null;
    return this.db.prepare(`SELECT * FROM "${entity.toLowerCase()}" WHERE id=?`).get(Number(id));
  }

  count(entity, where = {}) { return this.list(entity, { where }).length; }

  // Structured query only: the graph names fields and comparisons, never SQL.
  list(entity, { search = [], q = '', where = {}, sort = null } = {}) {
    const table = entity.toLowerCase();
    const clauses = [], vals = [];
    for (const [field, cmp] of Object.entries(where)) {
      if (cmp === undefined || cmp === null || cmp === '') continue;
      clauses.push(`"${field}"=?`);
      vals.push(coerce(this.field(entity, field), cmp));
    }
    if (q && search.length) {
      clauses.push('(' + search.map((f) => `LOWER("${f}") LIKE ?`).join(' OR ') + ')');
      search.forEach(() => vals.push(`%${q.toLowerCase()}%`));
    }
    const order = sort ? `ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}` : 'ORDER BY id DESC';
    return this.db.prepare(
      `SELECT * FROM "${table}"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ${order}`).all(...vals);
  }

  // Declarative aggregation: the graph names the function and the field, never SQL.
  aggregate(entity, { groupBy = null, metrics = [], sort = null, limit = null, where = {} } = {}) {
    const table = entity.toLowerCase();
    const cols = [], names = [];
    if (groupBy) { cols.push(`"${groupBy}" AS grp`); names.push('grp'); }
    for (const m of metrics) {
      const fn = String(m.fn).toUpperCase();
      const expr = fn === 'COUNT' ? 'COUNT(*)' : `${fn}("${m.field}")`;
      cols.push(`${expr} AS "${m.as}"`); names.push(m.as);
    }
    const clauses = [], vals = [];
    for (const [field, cmp] of Object.entries(where)) {
      if (cmp === undefined || cmp === null || cmp === '') continue;
      clauses.push(`"${field}"=?`); vals.push(coerce(this.field(entity, field), cmp));
    }
    let sql = `SELECT ${cols.join(', ')} FROM "${table}"`;
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    if (groupBy) sql += ` GROUP BY "${groupBy}"`;
    if (sort) sql += ` ORDER BY "${sort.field}" ${sort.dir === 'asc' ? 'ASC' : 'DESC'}`;
    if (limit) sql += ` LIMIT ${Number(limit)}`;
    return this.db.prepare(sql).all(...vals);
  }
}
