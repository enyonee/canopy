// The outbox. An effect that leaves the process is a row first and a request
// second: it is committed with the transaction that caused it, then delivered
// by the transport registered for its kind. Delivery never runs inside a
// transaction and never blocks a commit.
import { DEFAULT } from './registry.mjs';

export async function deliver(store, graph, row, { fetchImpl = fetch, trace = (_event) => {}, registry = DEFAULT } = {}) {
  const connector = graph.connectors?.[row.connector] || {};
  const patch = { attempts: (row.attempts || 0) + 1 };
  const transport = registry.transports[row.kind];
  try {
    if (!transport) throw new Error(`unknown delivery kind "${row.kind}"`);
    Object.assign(patch, await transport.deliver(row, connector, { fetchImpl }));
  } catch (e) {
    patch.status = 'failed';
    patch.error = String(e && e.message);
  }
  store.outboxUpdate(row.id, patch);
  trace({ kind: 'delivery', id: row.id, via: row.kind, connector: row.connector, target: row.target, status: patch.status, code: patch.code ?? null });
  return patch.status;
}

// A row in `sending` whose claim is older than this is taken to belong to a dead
// process and becomes claimable again: delivery is exactly-once unless a process
// dies mid-delivery, then at-least-once. Connectors should send an idempotency key.
export const LEASE_MS = 60000;

// Deliver everything that is queued (or whose lease ran out). Called after a
// commit, never inside one. A row is delivered only by the caller that claimed
// it, so overlapping flushes never deliver one row twice.
export async function flush(store, graph, opts = {}) {
  const { now = Date.now, leaseMs = LEASE_MS } = opts;
  const out = [];
  for (const row of store.outboxDue(now(), leaseMs)) {
    if (store.outboxClaim(row.id, now(), leaseMs)) out.push(await deliver(store, graph, row, opts));
  }
  return out;
}
