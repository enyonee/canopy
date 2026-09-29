// The outbox. An effect that leaves the process is a row first and a request
// second: it is committed with the transaction that caused it, then delivered
// by the transport registered for its kind. Delivery never runs inside a
// transaction and never blocks a commit. A delivery that fails in a way worth
// retrying goes back to `queued` with `nextAttemptAt` (runtime/settle.mjs, the
// policy in runtime/connectors/backoff.mjs); a provider that keeps failing opens
// its circuit breaker, and its rows wait without being tried.
import { DEFAULT } from './registry.mjs';
import { resolveClock } from './clock.mjs';
import { idemKeyOf } from './connectors/backoff.mjs';
import { settle, policyOf } from './settle.mjs';
import { redact, redactDeep } from './connectors/redact.mjs';
import { modesOf, modeOf } from './deploy.mjs';

// A row in `sending` whose claim is older than this is taken to belong to a dead
// process and becomes claimable again: delivery is exactly-once unless a process
// dies mid-delivery, then at-least-once. Connectors should send an idempotency key,
// and a request never waits longer than half of this, so a live one cannot outlive its claim.
export const LEASE_MS = 60000;

// Every secret value the store holds, for masking. A store that cannot be read (wrong key) holds nothing that was
// resolved either: the delivery itself fails with the store's own message.
function known(secrets) {
  try { return secrets ? secrets.values() : []; } catch { return []; } // allow-swallow: an unreadable store resolved nothing, and the delivery reports why
}

export async function deliver(store, graph, row, opts = {}) {
  const { fetchImpl = fetch, trace = (_event) => {}, registry = DEFAULT, claimedAt = null, leaseMs = LEASE_MS, secrets = null } = opts;
  const clock = resolveClock(opts);
  const connector = graph.connectors?.[row.connector] || {};
  const idemKey = row.idemKey || idemKeyOf(graph.app, row.connector, row.id, row.at);
  const transport = registry.transports[row.kind];
  const modes = modesOf(registry, row.kind);
  const mode = opts.mode ?? modes[0];
  // What a secret resolved to must not outlive the request: masked in the answer, the error and every trace line.
  const values = known(secrets);
  const say = (event) => trace(redactDeep(event, values));
  let result = {}, error = null;
  try {
    if (!transport) throw new Error(`unknown delivery kind "${row.kind}"`);
    if (!modes.includes(mode)) throw new Error(`connector "${row.connector}" cannot run in ${mode} mode (it offers: ${modes.join(', ')})`);
    result = redactDeep(await transport.deliver(row, connector, { fetchImpl, trace: say, clock, idemKey, timeoutCapMs: leaseMs / 2, mode, secrets }), values);
  } catch (e) { error = Object.assign(new Error(redact(String(e && e.message), values)), { fault: e && e.fault }); }
  const policy = policyOf(registry, row);
  const { patch, event } = settle(row, result, error, { policy, now: clock.now(), idemKey });
  if (event) {
    const { before, after } = store.breakerRecord(row.connector, mode, event, clock.now(), policy.breaker);
    if (before.state !== after.state) say({ kind: 'breaker', connector: row.connector, mode, from: before.state, to: after.state, openUntil: after.openUntil });
  }
  // A delivery that came from a flush finishes only while it still holds its claim;
  // one whose lease ran out and was re-claimed is dropped, not written over the new owner.
  if (claimedAt !== null && !store.outboxFinish(row.id, claimedAt, patch)) {
    say({ kind: 'delivery', id: row.id, via: row.kind, connector: row.connector, target: row.target, stale: true });
    return 'stale';
  }
  if (claimedAt === null) store.outboxUpdate(row.id, patch);
  say({ kind: 'delivery', id: row.id, via: row.kind, connector: row.connector, target: row.target, status: patch.status, code: patch.code ?? null, nextAttemptAt: patch.nextAttemptAt });
  return patch.status;
}

// May this row be tried now? A closed breaker says yes. Otherwise the connector is
// being spared: once its cooldown is over exactly one caller wins the probe (an atomic
// claim), everyone else leaves the row where it is, and while it is still cooling the
// row's next attempt is pushed to the end of the cooldown — without counting an attempt.
function admit(store, row, { now, mode, registry, leaseMs }) {
  const b = store.breakerGet(row.connector, mode);
  if (b.state === 'closed') return true;
  if (store.breakerClaim(row.connector, mode, now, { ...policyOf(registry, row).breaker, probeLeaseMs: leaseMs })) return true;
  if (b.state === 'open' && now < b.openUntil) store.outboxDefer(row.id, b.openUntil);
  return false;
}

// Deliver everything that is due: queued (and past its nextAttemptAt), or whose lease
// ran out. Called after a commit and by the background flusher, never inside a
// transaction. A row is delivered only by the caller that claimed it, so overlapping
// flushes never deliver one row twice.
export async function flush(store, graph, opts = {}) {
  const { leaseMs = LEASE_MS, registry = DEFAULT, env = null } = opts;
  const clock = resolveClock(opts);
  const deploy = env ? env.deploy() : { connectors: {} };
  const out = [];
  for (const row of store.outboxDue(clock.now(), leaseMs)) {
    const mode = modeOf(deploy, row.connector, modesOf(registry, row.kind));
    if (!admit(store, row, { now: clock.now(), mode, registry, leaseMs })) continue;
    const claimedAt = clock.now();
    if (store.outboxClaim(row.id, claimedAt, leaseMs)) out.push(await deliver(store, graph, row, { ...opts, mode, secrets: env?.secrets, clock, claimedAt }));
  }
  return out;
}
