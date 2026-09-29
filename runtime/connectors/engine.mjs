// The engine of connector descriptors: from an operation and its input it builds the
// request, from the response it builds the outbox patch. No storage, no network of its
// own — the caller passes `fetchImpl`. `synthesize` turns a descriptor into the
// registry's transport, so the outbox delivers a descriptor's rows like any other.
import { validate, withDefaults } from './schema.mjs';
import { expand, expandUrl, pick } from './template.mjs';
import { METHODS, MAX_TIMEOUT_MS } from './descriptor.mjs';
import { faultOf } from './backoff.mjs';
import { systemClock } from '../clock.mjs';

export const DEFAULT_TIMEOUT_MS = 3000;
// The most of an answer the outbox row keeps.
export const RESPONSE_CAP = 16384;

const operation = (d, name) => {
  const op = d.operations[name];
  if (!op) throw new Error(`${d.name} has no operation "${name}" (operations: ${Object.keys(d.operations).join(', ')})`);
  return op;
};
const configOf = (d, connector) => { const { kind, ...rest } = connector || {}; return withDefaults(d.config || {}, rest); };
const problems = (list, root) => list.map(([p, m]) => `${root}${p}: ${m}`).join('; ');

function scopesOf(d, connector, input, secret) {
  const config = configOf(d, connector);
  return { config, input, secret, base: d.base === undefined ? undefined : expand(d.base, { config }) };
}

function requestUrl(op, scopes) {
  const url = expandUrl(op.request.url, scopes);
  if (!/^https?:\/\//.test(url)) throw new Error(`the request url must start with http:// or https://, got "${url}"`);
  return url;
}

/**
 * What a call must satisfy before it is queued: the input is completed with its defaults and
 * validated against the operation's schema, and the target url is built. Throws with every
 * problem named. Returns the input to store and the url to show in the outbox.
 */
export function prepare(d, connector, opName, input) {
  const op = operation(d, opName);
  const whole = withDefaults(op.input, input);
  const bad = validate(op.input, whole);
  if (bad.length) throw new Error(`${d.name}.${opName}: ${problems(bad, 'input')}`);
  return { input: whole, target: requestUrl(op, scopesOf(d, connector, whole)) };
}

/**
 * The request of one operation: { method, url, headers, body (JSON text or undefined), timeout }.
 * A row queued before the descriptor existed already has its url (`target`): that one is used as is.
 * `timeout` is the descriptor's (or the connector's) `timeoutMs`, never above `timeoutCapMs` (half the outbox lease), so a
 * request cannot outlive the claim on its row. With `idemKey`, a descriptor that declares `idempotency.header` sends it there.
 * @param {{ secret?: (name: string) => any, target?: string, idemKey?: string, timeoutCapMs?: number }} [opts]
 */
export function buildRequest(d, connector, opName, input, opts = {}) {
  const { secret, target, idemKey, timeoutCapMs = MAX_TIMEOUT_MS } = opts;
  const op = operation(d, opName);
  const scopes = scopesOf(d, connector, input, secret);
  const r = op.request;
  const method = r.method === undefined ? 'POST' : expand(r.method, scopes);
  if (!METHODS.includes(method)) throw new Error(`unsupported method "${method}"`);
  const body = r.body === undefined ? undefined : expand(r.body, scopes);
  const headers = expand(r.headers || {}, scopes);
  if (idemKey !== undefined && d.idempotency) headers[d.idempotency.header] = idemKey;
  for (const [k, v] of Object.entries(headers)) if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) throw new Error(`header "${k.replace(/[\r\n]/g, ' ')}" holds a line break`);
  return {
    method, url: target ?? requestUrl(op, scopes), headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: Math.min(scopes.config.timeout || d.timeoutMs || DEFAULT_TIMEOUT_MS, timeoutCapMs),
  };
}

// The answer of an operation that declares "output": its text (capped), the fields "result" names, and
// what does not fit the schema. Never throws: the effect has happened whatever the answer looks like.
async function readAnswer(op, res) {
  let raw = '';
  let body;
  try { raw = await res.text(); body = JSON.parse(raw); } catch (e) {
    return { response: raw.slice(0, RESPONSE_CAP), drift: [['/', `the answer is not JSON: ${e.message}`]] };
  }
  const drift = validate(op.output, body, '', { extra: true });
  const answer = { response: raw.slice(0, RESPONSE_CAP), drift };
  if (op.result) answer.result = JSON.stringify(Object.fromEntries(Object.entries(op.result).map(([k, p]) => [k, pick(p, body)]).filter(([, v]) => v !== undefined)));
  return answer;
}

/** The outbox patch for a response, and the drift found in it: { patch, drift: [[path, message]] }. */
export async function mapResponse(op, res) {
  const patch = { code: res.status, status: res.ok ? 'sent' : 'failed', error: res.ok ? null : `HTTP ${res.status}` };
  // The provider's own wish for when to come back; the outbox reads it (runtime/settle.mjs) and does not store it.
  const retryAfter = res.headers?.get?.('retry-after');
  if (!res.ok && retryAfter) patch.retryAfter = retryAfter;
  if (!res.ok || !op.output) return { patch, drift: [] };
  const { drift, ...answer } = await readAnswer(op, res);
  return { patch: { ...patch, ...answer, drift: drift.length ? 1 : 0 }, drift };
}

// The request, with a timeout that comes from the clock (so a test's fake clock can fire it). A request that throws is
// tagged with why (runtime/connectors/backoff.mjs faultOf): the outbox retries a timeout or a refused connection, and
// never a request that could not even be built.
async function send(req, fetchImpl, clock, answer) {
  const abort = new AbortController();
  const timer = clock.setTimer(() => abort.abort(new DOMException(`no answer within ${req.timeout} ms`, 'TimeoutError')), req.timeout);
  const init = { method: req.method, headers: req.headers, signal: abort.signal };
  if (req.body !== undefined) init.body = req.body;
  try {
    let res;
    try { res = await fetchImpl(req.url, init); } catch (e) { throw Object.assign(new Error(e && e.message, { cause: e }), { fault: faultOf(e) }); }
    return await answer(res);
  } finally { clock.clear(timer); }
}

/**
 * Deliver one outbox row of this descriptor's kind: build the request, send it, map the answer.
 * @param {{ fetchImpl?: typeof fetch, trace?: (event: any) => void, secret?: (name: string) => any, clock?: import('../types.d.ts').Clock, idemKey?: string, timeoutCapMs?: number }} [opts]
 */
export async function deliverRow(d, row, connector, opts = {}) {
  const { fetchImpl = fetch, trace = (_event) => {}, secret, clock = systemClock, idemKey, timeoutCapMs } = opts;
  const legacy = row.op === null || row.op === undefined;
  const opName = legacy ? d.legacy : row.op;
  if (!opName) throw new Error(`a "${d.name}" row needs an operation`);
  const req = buildRequest(d, connector, opName, legacy ? { body: row.payload } : row.payload, { secret, target: legacy ? row.target : undefined, idemKey, timeoutCapMs });
  const { patch, drift } = await send(req, fetchImpl, clock, (res) => mapResponse(operation(d, opName), res));
  if (drift.length) trace({ kind: 'contract_drift', id: row.id, connector: row.connector, op: opName, path: drift[0][0], message: drift[0][1] });
  return patch;
}

/** The registry transport of a descriptor: its configuration is checked against "config", its rows go through the engine. */
export function synthesize(d) {
  return {
    summary: d.title || `the ${d.name} connector (${Object.keys(d.operations).join(', ')})`,
    validate: (connector) => validate(d.config || { type: 'object', properties: {} }, configOf(d, connector), '')
      .map(([p, m, h]) => (h ? [p.slice(1), m, h] : [p.slice(1), m])),
    deliver: (row, connector, opts) => deliverRow(d, row, connector, opts),
  };
}
