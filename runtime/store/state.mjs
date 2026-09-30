// The two bookkeeping tables every graph gets for free, attached to
// Store.prototype by store.mjs: the outbox (every effect that leaves the
// process, delivered after commit — see runtime/outbox.mjs) and sessions
// (a cookie names a row here, so signing out really ends the session).
import { idemKeyOf, breakerStep, CLOSED } from '../connectors/backoff.mjs';

// "op" is the operation of a connector descriptor (connector.call); a row queued without one is a
// legacy row, delivered by its transport's default operation.
export function enqueue({ kind, connector, target, payload, op = null }) {
  const { quote: q, ph } = this.drv.dialect;
  const at = new Date().toISOString();
  const id = this.drv.run(this.drv.dialect.insert('_outbox', ['kind', 'connector', 'target', 'payload', 'op', 'status', 'attempts', 'at', 'updatedAt']),
    [kind, connector, target, JSON.stringify(payload ?? null), op, 'queued', 0, at, at]).lastId;
  // The idempotency key is fixed here, once, and sent again on every retry and after a lease takeover.
  this.drv.run(`UPDATE ${q('_outbox')} SET ${q('idemKey')}=${ph(1)} WHERE id=${ph(2)}`, [idemKeyOf(this.graph.app, connector, id, at), id]);
  return id;
}
export function outbox(where = {}) {
  const { quote: q, ph } = this.drv.dialect;
  const clauses = [], vals = [];
  for (const [k, v] of Object.entries(where)) { vals.push(v); clauses.push(`${q(k)}=${ph(vals.length)}`); }
  return this.drv.all(`SELECT * FROM ${q('_outbox')}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC`, vals)
    .map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
// Rows a flush may take: queued and not waiting for a retry (nextAttemptAt is empty or reached),
// or sending with a lease older than leaseMs (the process that claimed them died mid-delivery). Oldest first.
export function outboxDue(now, leaseMs) {
  const { quote: q, ph } = this.drv.dialect;
  return this.drv.all(`SELECT * FROM ${q('_outbox')} WHERE (${q('status')}='queued' AND (${q('nextAttemptAt')} IS NULL OR ${q('nextAttemptAt')}<=${ph(1)}))
    OR (${q('status')}='sending' AND ${q('claimedAt')}<=${ph(2)}) ORDER BY id ASC`,
  [now, now - leaseMs]).map((r) => ({ ...r, payload: JSON.parse(String(r.payload)) }));
}
// The earliest moment a queued row is waiting for (epoch ms), or null: what the flusher sets its one-shot timer to.
export function outboxNextDue(now) {
  const { quote: q, ph } = this.drv.dialect;
  const row = this.drv.get(`SELECT MIN(${q('nextAttemptAt')}) AS at FROM ${q('_outbox')} WHERE ${q('status')}='queued' AND ${q('nextAttemptAt')}>${ph(1)}`, [now]);
  return row && row.at !== null ? Number(row.at) : null;
}
// Push a queued row's next attempt to `at` (an open breaker), without touching its attempts.
export function outboxDefer(id, at) {
  const { quote: q, ph } = this.drv.dialect;
  this.drv.run(`UPDATE ${q('_outbox')} SET ${q('nextAttemptAt')}=${ph(1)} WHERE id=${ph(2)} AND ${q('status')}='queued'`, [at, Number(id)]);
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
// An operator's decision on a row that is in status `from`: lands only if it still is (two operators, one click).
export function outboxMark(id, from, patch) {
  return outboxSet(this.drv, id, patch, (q, ph, n) => ` AND ${q('status')}=${ph(n)}`, from);
}
// The final write of a delivery: lands only while the row is still the one this
// flush claimed. False when the lease ran out and another flush took it over.
export function outboxFinish(id, claimedAt, patch) {
  return outboxSet(this.drv, id, patch, (q, ph, n) => ` AND ${q('claimedAt')}=${ph(n)} AND ${q('status')}='sending'`, claimedAt);
}

// The circuit breaker of one connector in one mode (see runtime/connectors/backoff.mjs breakerStep). One row per
// (connector, mode), keyed by both; a connector that never failed has none, which reads as closed.
const BREAKER_COLS = ['state', 'failures', 'openUntil', 'cooldownMs', 'probeClaimedAt'];
export function breakerGet(connector, mode) {
  const { quote: q, ph } = this.drv.dialect;
  const r = this.drv.get(`SELECT * FROM ${q('_breaker')} WHERE ${q('key')}=${ph(1)}`, [`${connector}|${mode}`]);
  return r ? { connector, mode, state: String(r.state), ...Object.fromEntries(BREAKER_COLS.slice(1).map((k) => [k, Number(r[k])])) } : { connector, mode, ...CLOSED };
}
export function breakers() {
  const { quote: q } = this.drv.dialect;
  return this.drv.all(`SELECT ${q('connector')}, ${q('mode')} FROM ${q('_breaker')} ORDER BY ${q('connector')}, ${q('mode')}`).map((r) => this.breakerGet(String(r.connector), String(r.mode)));
}
// Apply an event to the breaker and store the result. Returns the state before and after.
export function breakerRecord(connector, mode, event, now, cfg) {
  const before = this.breakerGet(connector, mode);
  const after = { connector, mode, ...breakerStep(before, event, now, cfg) };
  if (BREAKER_COLS.some((k) => before[k] !== after[k])) {
    this.drv.run(this.drv.dialect.upsert('_breaker', ['key', 'connector', 'mode', ...BREAKER_COLS], 'key'),
      [`${connector}|${mode}`, connector, mode, ...BREAKER_COLS.map((k) => after[k])]);
  }
  return { before, after };
}
// The probe: one UPDATE that matches only the state this caller saw, so of several callers exactly one wins.
export function breakerClaim(connector, mode, now, cfg) {
  const { quote: q, ph } = this.drv.dialect;
  const before = this.breakerGet(connector, mode);
  const after = breakerStep(before, 'probe', now, cfg);
  if (after === before) return false;
  return this.drv.run(`UPDATE ${q('_breaker')} SET ${q('state')}=${ph(1)}, ${q('probeClaimedAt')}=${ph(2)}
    WHERE ${q('key')}=${ph(3)} AND ${q('state')}=${ph(4)} AND ${q('probeClaimedAt')}=${ph(5)}`,
  [after.state, after.probeClaimedAt, `${connector}|${mode}`, before.state, before.probeClaimedAt]).changes === 1;
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

// The dedup ledger of inbound webhooks. `inboundSeen` and `inboundAdd` run inside the transaction of the event's own
// steps, so the row exists exactly when the steps committed; a duplicate that slips past the read on another instance
// fails the PRIMARY KEY insert, answers 500 and is settled as a duplicate on the provider's next retry.
const inboundKey = (connector, eventId) => `${connector}|${eventId}`;
export function inboundSeen(connector, eventId) {
  const { quote: q, ph } = this.drv.dialect;
  return Boolean(this.drv.get(`SELECT ${q('key')} FROM ${q('_inbound')} WHERE ${q('key')}=${ph(1)}`, [inboundKey(connector, eventId)]));
}
export function inboundAdd(connector, eventId, receivedAt) {
  this.drv.run(this.drv.dialect.insert('_inbound', ['key', 'connector', 'eventId', 'receivedAt']), [inboundKey(connector, eventId), connector, eventId, receivedAt]);
}
// Forget what was received before `before` (epoch ms); returns how many rows went.
export function inboundPrune(before) {
  const { quote: q, ph } = this.drv.dialect;
  return this.drv.run(`DELETE FROM ${q('_inbound')} WHERE ${q('receivedAt')}<${ph(1)}`, [before]).changes;
}
