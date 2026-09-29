// The reliability policy of connector deliveries, as pure functions: what an outcome
// means (classify), what to do about it (decide), how long to wait (delayFor), what
// Retry-After asks for, the circuit breaker's state machine (breakerStep) and the
// idempotency key. No storage, no network and no clock of its own: the caller passes
// `now`, which is what makes every schedule testable with a fake clock.
import { createHash } from 'node:crypto';

/** Total attempts (the first one included), the first delay, its cap and the share of it that jitter may take away. */
export const DEFAULT_RETRY = { max: 5, baseMs: 1000, capMs: 60000, jitter: 0.2 };
/** Consecutive retryable failures that open the breaker, the first cooldown, its cap, and how long a probe may stay unanswered. */
export const DEFAULT_BREAKER = { threshold: 5, cooldownMs: 30000, maxCooldownMs: 600000, probeLeaseMs: 60000 };
export const CLOSED = { state: 'closed', failures: 0, openUntil: 0, cooldownMs: 0, probeClaimedAt: 0 };

// key: [minimum, maximum, whole number?]
const RULES = {
  retry: { max: [1, 20, true], baseMs: [1, 3600000, true], capMs: [1, 86400000, true], jitter: [0, 1, false] },
  breaker: { threshold: [1, 1000, true], cooldownMs: [1, 3600000, true], maxCooldownMs: [1, 86400000, true] },
};
const ORDER = { retry: ['baseMs', 'capMs'], breaker: ['cooldownMs', 'maxCooldownMs'] };
const DEFAULTS = { retry: DEFAULT_RETRY, breaker: DEFAULT_BREAKER };

/** What is wrong with a descriptor's `retry` or `breaker` block: [[path, message, hint?]]. */
export function checkPolicy(kind, value, path) {
  const rules = RULES[kind];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [[path, `"${kind}" is an object`, `keys: ${Object.keys(rules).join(', ')}`]];
  const out = Object.keys(value).filter((k) => !(k in rules)).map((k) => [`${path}/${k}`, `unknown key "${k}"`, `allowed: ${Object.keys(rules).join(', ')}`]);
  for (const [k, [lo, hi, whole]] of Object.entries(rules)) {
    const v = value[k];
    if (v !== undefined && !(typeof v === 'number' && (!whole || Number.isInteger(v)) && v >= lo && v <= hi)) out.push([`${path}/${k}`, `"${k}" is ${whole ? 'a whole number' : 'a number'} from ${lo} to ${hi}`]);
  }
  const [low, high] = ORDER[kind];
  const merged = { ...DEFAULTS[kind], ...value };
  if (!out.length && merged[low] > merged[high]) out.push([path, `"${high}" may not be below "${low}"`]);
  return out;
}

/** The idempotency key of an outbox row: the same whenever it is computed, so a retry, a lease takeover and a restored copy agree. */
export const idemKeyOf = (app, connector, id, at) => createHash('sha256').update([app, connector, id, at].join('|')).digest('hex').slice(0, 32);

// 0 <= u < 1, the same for the same key and attempt.
const unit = (key, attempts) => createHash('sha256').update(`${key}:${attempts}`).digest().readUInt32BE(0) / 2 ** 32;

const UNSENT = /\b(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/;
/** Why a request threw: 'timeout', 'unsent' (it never left: DNS, connection refused) or 'net' (it may have arrived). */
export function faultOf(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  return UNSENT.test(`${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.message ?? ''}`) ? 'unsent' : 'net';
}

/**
 * What an outcome is: { status } for an answer, { fault } for a request that threw.
 * kind 'sent' | 'retry' | 'permanent'; `ambiguous` when nothing answered so the request may have landed;
 * `unsent` when it certainly did not.
 */
export function classify(outcome) {
  if (outcome.fault) return { kind: 'retry', ambiguous: outcome.fault !== 'unsent', unsent: outcome.fault === 'unsent' };
  const s = outcome.status;
  if (s >= 200 && s < 300) return { kind: 'sent' };
  return { kind: s === 429 || s >= 500 ? 'retry' : 'permanent' };
}

/** The Retry-After header (seconds or an HTTP date) as milliseconds from `now`; 0 when absent or unusable. */
export function retryAfterMs(value, now) {
  if (value === undefined || value === null) return 0;
  const text = String(value).trim();
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * The wait before attempt number `attempts + 1`: min(cap, base * 2^(attempts-1)), reduced by up to `jitter` of
 * itself from a hash of the key (never above the cap, never random), and raised to Retry-After (itself capped).
 */
export function delayFor(retry, attempts, idemKey, retryAfter = 0) {
  const { baseMs, capMs, jitter } = { ...DEFAULT_RETRY, ...retry };
  const raw = Math.min(capMs, baseMs * 2 ** Math.min(attempts - 1, 30));
  return Math.max(raw - Math.floor(raw * jitter * unit(idemKey, attempts)), Math.min(retryAfter, capMs));
}

/**
 * What to do with a classified outcome after `attempts` attempts: { action: 'sent' | 'failed' | 'unknown' | 'retry',
 * delayMs?, reason? }. Only an idempotent operation is retried after an answer or a request that may have landed;
 * a request that never left may always be. A non-idempotent one that got no answer is 'unknown': an operator decides.
 */
export function decide(c, { idempotent, attempts, retry, idemKey, retryAfter = 0 }) {
  if (c.kind === 'sent') return { action: 'sent' };
  if (c.kind === 'permanent') return { action: 'failed' };
  if (!idempotent && !c.unsent) return { action: c.ambiguous ? 'unknown' : 'failed' };
  const { max } = { ...DEFAULT_RETRY, ...retry };
  if (attempts >= max) return { action: 'failed', reason: `gave up after ${attempts} attempts` };
  return { action: 'retry', delayMs: delayFor(retry, attempts, idemKey, retryAfter) };
}

/** What an outcome tells the breaker about the provider: a retryable failure, a sign of life, or nothing. */
export const breakerEvent = (c) => (c.kind === 'retry' ? 'failure' : 'success');

/**
 * The breaker as a state machine: b = { state: 'closed' | 'open' | 'half', failures, openUntil, cooldownMs, probeClaimedAt }.
 * 'failure' counts, and opens the breaker at `threshold` in a row (or reopens it from half with the cooldown doubled up to
 * maxCooldownMs); 'success' closes it; 'probe' asks for the one trial call once the cooldown is over (or its earlier probe
 * went unanswered for probeLeaseMs) and returns `b` itself when there is none to give.
 */
export function breakerStep(b, event, now, cfg) {
  const c = { ...DEFAULT_BREAKER, ...cfg };
  if (event === 'success') return { ...CLOSED };
  if (event === 'probe') {
    if (b.state === 'open' && now >= b.openUntil) return { ...b, state: 'half', probeClaimedAt: now };
    if (b.state === 'half' && now - b.probeClaimedAt >= c.probeLeaseMs) return { ...b, probeClaimedAt: now };
    return b;
  }
  const failures = b.failures + 1;
  if (b.state === 'open') return { ...b, failures };
  if (b.state === 'closed' && failures < c.threshold) return { ...b, failures };
  const cooldownMs = b.state === 'half' ? Math.min(c.maxCooldownMs, b.cooldownMs * 2) : c.cooldownMs;
  return { state: 'open', failures, openUntil: now + cooldownMs, cooldownMs, probeClaimedAt: 0 };
}
