// The two bookkeeping tables every graph gets for free, attached to
// Store.prototype by store.mjs: the outbox (every effect that leaves the
// process, delivered after commit — see runtime/outbox.mjs) and sessions
// (a cookie names a row here, so signing out really ends the session).
export function enqueue({ kind, connector, target, payload }) {
  const at = new Date().toISOString();
  return this.drv.run(`INSERT INTO "_outbox" (kind, connector, target, payload, status, attempts, at, updatedAt)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`, [kind, connector, target, JSON.stringify(payload ?? null), at, at]).lastId;
}
export function outbox(where = {}) {
  const clauses = [], vals = [];
  for (const [k, v] of Object.entries(where)) { clauses.push(`"${k}"=?`); vals.push(v); }
  return this.drv.all(`SELECT * FROM "_outbox"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC`, vals)
    .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
// Rows a flush may take: queued, or sending with a lease older than leaseMs
// (the process that claimed them died mid-delivery). Oldest first.
export function outboxDue(now, leaseMs) {
  return this.drv.all(`SELECT * FROM "_outbox" WHERE status='queued' OR (status='sending' AND "claimedAt"<=?) ORDER BY id ASC`,
    [now - leaseMs]).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
// The atomic claim: one UPDATE that only matches a row nobody holds. True only
// for the caller whose UPDATE changed the row; the guard, not the caller's
// earlier read, decides who delivers.
export function outboxClaim(id, now, leaseMs) {
  return this.drv.run(`UPDATE "_outbox" SET status='sending', "claimedAt"=?, "updatedAt"=?
    WHERE id=? AND (status='queued' OR (status='sending' AND "claimedAt"<=?))`,
  [now, new Date(now).toISOString(), Number(id), now - leaseMs]).changes === 1;
}
export function outboxGet(id) { return this.outbox({ id: Number(id) })[0] || null; }
function outboxSet(drv, id, patch, guard, ...guardVals) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(patch)) { sets.push(`"${k}"=?`); vals.push(v); }
  sets.push('"updatedAt"=?'); vals.push(new Date().toISOString());
  return drv.run(`UPDATE "_outbox" SET ${sets.join(',')} WHERE id=?${guard}`, [...vals, Number(id), ...guardVals]).changes === 1;
}
// Unconditional write by id: manual paths (retry, tests) that hold no claim.
export function outboxUpdate(id, patch) { outboxSet(this.drv, id, patch, ''); }
// The final write of a delivery: lands only while the row is still the one this
// flush claimed. False when the lease ran out and another flush took it over.
export function outboxFinish(id, claimedAt, patch) {
  return outboxSet(this.drv, id, patch, ` AND "claimedAt"=? AND status='sending'`, claimedAt);
}

export function sessionSet(sid, userId) {
  this.drv.run(`INSERT OR REPLACE INTO "_session" (id, user, at) VALUES (?, ?, ?)`,
    [String(sid), Number(userId), new Date().toISOString()]);
  return sid;
}
export function sessionUser(sid) {
  const row = this.drv.get(`SELECT user FROM "_session" WHERE id=?`, [String(sid)]);
  return row ? Number(row.user) : null;
}
export function sessionEnd(sid) { this.drv.run(`DELETE FROM "_session" WHERE id=?`, [String(sid)]); }
