// The outbox. An effect that leaves the process is a row first and a request
// second: it is committed with the transaction that caused it, then delivered.
// Delivery never runs inside a transaction and never blocks a commit.

const TIMEOUT_MS = 3000;

export async function deliver(store, graph, row, { fetchImpl = fetch, trace = () => {} } = {}) {
  const connector = graph.connectors?.[row.connector] || {};
  const patch = { attempts: (row.attempts || 0) + 1 };
  try {
    if (row.kind === 'http') {
      const res = await fetchImpl(row.target, {
        method: connector.method || 'POST',
        headers: { 'content-type': 'application/json', ...(connector.headers || {}) },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(connector.timeout || TIMEOUT_MS),
      });
      patch.code = res.status;
      patch.status = res.ok ? 'sent' : 'failed';
      patch.error = res.ok ? null : `HTTP ${res.status}`;
    } else if (row.kind === 'mail') {
      // The stand transport: the letter is recorded, not carried. SMTP is a later connector.
      patch.status = 'sent';
      patch.code = null;
      patch.error = null;
    } else {
      patch.status = 'failed';
      patch.error = `unknown delivery kind "${row.kind}"`;
    }
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

