// The two bookkeeping tables every graph gets for free, attached to
// Store.prototype by store.mjs: the outbox (every effect that leaves the
// process, delivered after commit — see runtime/outbox.mjs) and sessions
// (a cookie names a row here, so signing out really ends the session).
// "op" is the operation of a connector descriptor (connector.call); a row queued without one is a
// legacy row, delivered by its transport's default operation.
export function enqueue({ kind, connector, target, payload, op = null }) {
  const at = new Date().toISOString();
  return this.drv.run(this.drv.dialect.insert('_outbox', ['kind', 'connector', 'target', 'payload', 'op', 'status', 'attempts', 'at', 'updatedAt']),
    [kind, connector, target, JSON.stringify(payload ?? null), op, 'queued', 0, at, at]).lastId;
}
export function outbox(where = {}) {
  const { quote: q, ph } = this.drv.dialect;
  const clauses = [], vals = [];
  for (const [k, v] of Object.entries(where)) { vals.push(v); clauses.push(`${q(k)}=${ph(vals.length)}`); }
  return this.drv.all(`SELECT * FROM ${q('_outbox')}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC`, vals)
    .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
// Rows a flush may take: queued, or sending with a lease older than leaseMs
// (the process that claimed them died mid-delivery). Oldest first.
export function outboxDue(now, leaseMs) {
  const { quote: q, ph } = this.drv.dialect;
  return this.drv.all(`SELECT * FROM ${q('_outbox')} WHERE ${q('status')}='queued' OR (${q('status')}='sending' AND ${q('claimedAt')}<=${ph(1)}) ORDER BY id ASC`,
    [now - leaseMs]).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
// The atomic claim: one UPDATE that only matches a row nobody holds. True only
// for the caller whose UPDATE changed the row; the guard, not the caller's
// earlier read, decides who delivers.
export function outboxClaim(id, now, leaseMs) {
  const { quote: q, ph } = this.drv.dialect;
  return this.drv.run(`UPDATE ${q('_outbox')} SET ${q('status')}='sending', ${q('claimedAt')}=${ph(1)}, ${q('updatedAt')}=${ph(2)}
    WHERE id=${ph(3)} AND (${q('status')}='queued' OR (${q('status')}='sending' AND ${q('claimedAt')}<=${ph(4)}))`,
  [now, new Date(now).toISOString(), Number(id), now - leaseMs]).changes === 1;
}
export function outboxGet(id) { return this.outbox({ id: Number(id) })[0] || null; }
function outboxSet(drv, id, patch, guard, ...guardVals) {
  const { quote: q, ph } = drv.dialect;
  const sets = [], vals = [];
  for (const [k, v] of Object.entries({ ...patch, updatedAt: new Date().toISOString() })) { vals.push(v); sets.push(`${q(k)}=${ph(vals.length)}`); }
  return drv.run(`UPDATE ${q('_outbox')} SET ${sets.join(',')} WHERE id=${ph(vals.length + 1)}${guard(q, ph, vals.length + 2)}`, [...vals, Number(id), ...guardVals]).changes === 1;
}
// Unconditional write by id: manual paths (retry, tests) that hold no claim.
export function outboxUpdate(id, patch) { outboxSet(this.drv, id, patch, () => ''); }
// The final write of a delivery: lands only while the row is still the one this
// flush claimed. False when the lease ran out and another flush took it over.
export function outboxFinish(id, claimedAt, patch) {
  return outboxSet(this.drv, id, patch, (q, ph, n) => ` AND ${q('claimedAt')}=${ph(n)} AND ${q('status')}='sending'`, claimedAt);
}

export function sessionSet(sid, userId) {
  this.drv.run(this.drv.dialect.upsert('_session', ['id', 'user', 'at'], 'id'),
    [String(sid), Number(userId), new Date().toISOString()]);
  return sid;
}
export function sessionUser(sid) {
  const { quote: q, ph } = this.drv.dialect;
  const row = this.drv.get(`SELECT ${q('user')} FROM ${q('_session')} WHERE id=${ph(1)}`, [String(sid)]);
  return row ? Number(row.user) : null;
}
export function sessionEnd(sid) {
  const { quote: q, ph } = this.drv.dialect;
  this.drv.run(`DELETE FROM ${q('_session')} WHERE id=${ph(1)}`, [String(sid)]);
}
