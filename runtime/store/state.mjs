// The two bookkeeping tables every graph gets for free, attached to
// Store.prototype by store.mjs: the outbox (every effect that leaves the
// process, delivered after commit — see runtime/outbox.mjs) and sessions
// (a cookie names a row here, so signing out really ends the session).
export function enqueue({ kind, connector, target, payload }) {
  const at = new Date().toISOString();
  return Number(this.db.prepare(`INSERT INTO "_outbox" (kind, connector, target, payload, status, attempts, at, updatedAt)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`).run(kind, connector, target, JSON.stringify(payload ?? null), at, at).lastInsertRowid);
}
export function outbox(where = {}) {
  const clauses = [], vals = [];
  for (const [k, v] of Object.entries(where)) { clauses.push(`"${k}"=?`); vals.push(v); }
  return this.db.prepare(`SELECT * FROM "_outbox"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC`).all(...vals)
    .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
export function outboxGet(id) { return this.outbox({ id: Number(id) })[0] || null; }
export function outboxUpdate(id, patch) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(`"${k}"=?`); vals.push(v); }
  sets.push('"updatedAt"=?'); vals.push(new Date().toISOString());
  this.db.prepare(`UPDATE "_outbox" SET ${sets.join(',')} WHERE id=?`).run(...vals, Number(id));
}

export function sessionSet(sid, userId) {
  this.db.prepare(`INSERT OR REPLACE INTO "_session" (id, user, at) VALUES (?, ?, ?)`)
    .run(String(sid), Number(userId), new Date().toISOString());
  return sid;
}
export function sessionUser(sid) {
  const row = this.db.prepare(`SELECT user FROM "_session" WHERE id=?`).get(String(sid));
  return row ? Number(row.user) : null;
}
export function sessionEnd(sid) { this.db.prepare(`DELETE FROM "_session" WHERE id=?`).run(String(sid)); }
