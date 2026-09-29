// What a delivery came to. `settle` turns what a transport returned (or threw) into the
// outbox patch to write, applying the retry policy of the connector's descriptor, and says
// what the outcome tells the circuit breaker. Pure: the caller passes `now`.
import { classify, decide, breakerEvent, retryAfterMs } from './connectors/backoff.mjs';

/** The reliability policy of a row: whether its operation is idempotent, and the descriptor's retry and breaker overrides. */
export function policyOf(registry, row) {
  const d = registry.descriptors[row.kind];
  if (!d) return { idempotent: false };
  return { idempotent: d.operations[row.op ?? d.legacy]?.idempotent === true, retry: d.retry, breaker: d.breaker };
}

// null: not a provider's answer (a request that could not be built, a plugin's own failure), so it is final.
function outcomeOf(patch, error) {
  if (error) return error.fault ? { fault: error.fault } : null;
  if (patch.status === 'sent') return { status: 200 };
  return typeof patch.code === 'number' ? { status: patch.code } : null;
}

const apply = {
  sent: (patch) => patch,
  failed: (patch, d) => (d.reason ? { ...patch, error: `${patch.error} (${d.reason})` } : patch),
  unknown: (patch) => ({ ...patch, status: 'unknown', error: `${patch.error}; the request may have landed, so it is not retried` }),
  retry: (patch, d, now) => ({ ...patch, status: 'queued', nextAttemptAt: now + d.delayMs }),
};

/**
 * @param {any} row the outbox row as it was claimed
 * @param {any} result the patch a transport returned ({} when it threw)
 * @param {any} error what it threw, with `fault` when the request itself failed
 * @param {{ policy: any, now: number, idemKey: string }} ctx
 * @returns {{ patch: Record<string, any>, event: 'failure' | 'success' | null }} the columns to write; the breaker event
 */
export function settle(row, result, error, { policy, now, idemKey }) {
  const { retryAfter, ...rest } = error ? { status: 'failed', code: null, error: String(error.message) } : result;
  const attempts = (row.attempts || 0) + 1;
  const outcome = outcomeOf(rest, error);
  const c = outcome && classify(outcome);
  const base = { ...rest, attempts, nextAttemptAt: null };
  if (!c) return { patch: base, event: null };
  const d = decide(c, { idempotent: policy.idempotent, attempts, retry: policy.retry, idemKey, retryAfter: retryAfterMs(retryAfter, now) });
  return { patch: apply[d.action](base, d, now), event: breakerEvent(c) };
}
