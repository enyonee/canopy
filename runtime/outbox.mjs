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

// Deliver everything that is still queued. Called after a commit, never inside one.
export async function flush(store, graph, opts) {
  const out = [];
  for (const row of store.outbox({ status: 'queued' }).reverse()) out.push(await deliver(store, graph, row, opts));
  return out;
}
