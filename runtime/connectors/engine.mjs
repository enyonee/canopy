// The engine of connector descriptors: from an operation and its input it builds the
// request, from the response it builds the outbox patch. No storage, no network of its
// own — the caller passes `fetchImpl`. `synthesize` turns a descriptor into the
// registry's transport, so the outbox delivers a descriptor's rows like any other.
import { validate, withDefaults } from './schema.mjs';
import { expand, expandUrl, pick, refs } from './template.mjs';
import { sandboxAnswer } from './sandbox.mjs';
import { METHODS, MAX_TIMEOUT_MS } from './descriptor.mjs';
import { faultOf } from './backoff.mjs';
import { systemClock } from '../clock.mjs';
import { formEncode, FORM_TYPE } from './form.mjs';
import { accessToken, tokenRequest } from './token.mjs';
import { redactDeep } from './redact.mjs';

export const DEFAULT_TIMEOUT_MS = 3000;
// The most of an answer the outbox row keeps.
export const RESPONSE_CAP = 16384;

const operation = (d, name) => {
  const op = d.operations[name];
  if (!op) throw new Error(`${d.name} has no operation "${name}" (operations: ${Object.keys(d.operations).join(', ')})`);
  return op;
};
const configOf = (d, connector) => { const { kind, secrets, ...rest } = connector || {}; return withDefaults(d.config || {}, rest); };
const timeoutOf = (d, config, cap) => Math.min(config.timeout || d.timeoutMs || DEFAULT_TIMEOUT_MS, cap);
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

function privateUrl(op, scopes, credential) {
  if (typeof credential !== 'string' || !/^(?:[A-Za-z0-9_-]{1,256}|bot[0-9]{1,20}:[A-Za-z0-9_-]{1,232})$/.test(credential)) throw new Error('invalid path credential');
  const segment = `{secret.${op.request.pathSecret}}`;
  const url = new URL(expandUrl(op.request.url.replace(segment, credential), scopes));
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== new URL(scopes.base).origin)
    throw new Error('path credentials require an HTTPS target on the declared origin');
  return url.href;
}

/** The slots a descriptor reads from the secret store: `{secret.<slot>}` in live requests, and the inbound signature's. */
export const secretSlots = (d) => [...new Set([...Object.values(d.operations).flatMap((op) => refs(op.request)).filter((r) => r.scope === 'secret').map((r) => r.path[0]),
  ...(d.inbound ? [d.inbound.secret] : []), ...(d.token ? [d.token.clientId, d.token.clientSecret, d.token.apiKey].filter(Boolean) : [])])];

// The outbox supplies a stable 128-bit hex key. Banks that require UUID v4 syntax get the same key on retries.
function headerKey(d, key) {
  if (d.idempotency.format !== 'uuid') return key;
  if (!/^[0-9a-f]{32}$/i.test(key)) throw new Error('UUID idempotency needs a 32-digit outbox key');
  const variant = (8 | (parseInt(key[16], 16) & 3)).toString(16);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-${variant}${key.slice(17, 20)}-${key.slice(20)}`;
}

/** The name in the secret store that a slot is: the connector's `secrets` map says, else the slot itself. */
export const secretName = (connector, slot) => connector?.secrets?.[slot] ?? slot;

// `{secret.x}` at delivery: the store's current value, and a missing one fails the delivery for good (no `fault`, so it is
// neither retried nor counted against the breaker). The message names the secret, never a value.
const resolver = (secrets, connector) => (slot) => {
  const name = secretName(connector, slot);
  const value = secrets.current(name);
  if (value === undefined) throw new Error(`secret "${name}" is not set: put it in the secret store (--secrets set ${name})`);
  return value;
};

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
  const scopes = scopesOf(d, connector, whole);
  return { input: whole, target: op.request.pathSecret ? privateUrl(op, scopes, 'redacted') : requestUrl(op, scopes) };
}

/**
 * The request of one operation: { method, url, headers, body (JSON or form text, or undefined), timeout }.
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
  // A form body is the descriptor's object flattened (runtime/connectors/form.mjs); its content type is set unless the descriptor set one.
  const text = body === undefined ? undefined : r.encoding === 'form' ? formEncode(body) : JSON.stringify(body);
  if (r.encoding === 'form' && text !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = FORM_TYPE;
  if (idemKey !== undefined && d.idempotency) headers[d.idempotency.header] = headerKey(d, idemKey);
  for (const [k, v] of Object.entries(headers)) if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) throw new Error(`header "${k.replace(/[\r\n]/g, ' ')}" holds a line break`);
  return {
    method, url: r.pathSecret ? privateUrl(op, scopes, secret?.(r.pathSecret)) : target ?? requestUrl(op, scopes), headers,
    body: text,
    timeout: timeoutOf(d, scopes.config, timeoutCapMs),
  };
}

// The answer of an operation that declares "output" or "failure": its text (capped), the body, the fields "result" names, and
// what does not fit the schema. Never throws: the effect has happened whatever the answer looks like.
/** @returns {Promise<{ response?: string, result?: string, body?: any, drift: string[][] }>} */
async function readAnswer(op, res) {
  let raw = '';
  let body;
  try { raw = await res.text(); body = JSON.parse(raw); } catch (e) {
    if (op.resultOnly) return { drift: [['/', 'the answer is not JSON']] };
    return { response: raw.slice(0, RESPONSE_CAP), drift: [['/', `the answer is not JSON: ${e.message}`]] };
  }
  const drift = op.output ? validate(op.output, body, '', { extra: true }) : [];
  /** @type {{ response?: string, result?: string, body?: any, drift: string[][] }} */
  const answer = { ...(op.resultOnly ? {} : { response: raw.slice(0, RESPONSE_CAP) }), drift, body };
  if (op.result) {
    const entries = Object.entries(op.result).map(([k, p]) => [k, pick(p, body)]);
    if (op.resultOnly && entries.some(([, v]) => v === undefined)) drift.push(['/', 'the result is missing a projected field']);
    answer.result = JSON.stringify(Object.fromEntries(entries.filter(([, v]) => v !== undefined)));
  }
  return answer;
}

const UNREADABLE = { code: 502, error: 'rejected: the answer is not JSON, so whether it succeeded cannot be told' };

// A success status whose body says it failed (a provider that answers 200 with {"ok": false, "error": "…"}): the
// descriptor's "failure" rule names the flag, the reason and the status the failure counts as (`codes[reason]`, else
// `code`, else 400), so the retry policy and the breaker see an ordinary failure. The reason is the provider's text, cut
// and cleaned before it reaches the outbox row.
function failureOf(rule, body) {
  if (pick(rule.path, body) !== rule.equals) return null;
  const raw = rule.error ? pick(rule.error, body) : undefined;
  const reason = typeof raw === 'string' ? raw.replace(/[^\w .:-]/g, '_').slice(0, 100) : '';
  const code = reason && rule.codes && Object.hasOwn(rule.codes, reason) ? rule.codes[reason] : rule.code ?? 400;
  return { code, error: `rejected: ${reason || 'no reason given'}` };
}

// The answer a sandbox rule gives, shaped like a fetch Response so it goes through the same mapping as a real one.
function sandboxResponse(d, opName, connector, input, key) {
  const hit = sandboxAnswer(d.sandbox?.operations?.[opName], { input, key, config: configOf(d, connector) });
  if (!hit) throw new Error(`${d.name}.${opName}: no sandbox rule answers this input`);
  const text = JSON.stringify(hit.body);
  const headers = Object.fromEntries(Object.entries(hit.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => text };
}

/** The outbox patch for a response, and the drift found in it: { patch, drift: [[path, message]] }. */
export async function mapResponse(op, res) {
  const patch = { code: res.status, status: res.ok ? 'sent' : 'failed', error: res.ok ? null : `HTTP ${res.status}` };
  // The provider's own wish for when to come back; the outbox reads it (runtime/settle.mjs) and does not store it.
  const retryAfter = res.headers?.get?.('retry-after');
  if (!res.ok && retryAfter) patch.retryAfter = retryAfter;
  if (!res.ok || !(op.output || op.failure)) return { patch, drift: [] };
  const { drift, body, ...answer } = await readAnswer(op, res);
  if (op.resultOnly && drift.length) return { patch: { ...patch, code: 502, status: 'failed', error: 'provider result did not match its contract', drift: 1 }, drift };
  const bad = op.failure && (body === undefined ? UNREADABLE : failureOf(op.failure, body));
  if (bad) return { patch: { ...patch, ...bad, status: 'failed', response: answer.response }, drift: [] };
  return { patch: { ...patch, ...answer, drift: drift.length ? 1 : 0 }, drift };
}

// The request, with a timeout that comes from the clock (so a test's fake clock can fire it). A request that throws is
// tagged with why (runtime/connectors/backoff.mjs faultOf): the outbox retries a timeout or a refused connection, and
// never a request that could not even be built.
async function send(req, fetchImpl, clock, answer) {
  const abort = new AbortController();
  const timer = clock.setTimer(() => abort.abort(new DOMException(`no answer within ${req.timeout} ms`, 'TimeoutError')), req.timeout);
  /** @type {RequestInit} */
  const init = { method: req.method, headers: req.headers, signal: abort.signal, ...(req.redirect && { redirect: req.redirect }) };
  if (req.body !== undefined) init.body = req.body;
  try {
    let res;
    try { res = await fetchImpl(req.url, init); } catch (e) { throw Object.assign(new Error(e && e.message, { cause: e }), { fault: faultOf(e) }); }
    return await answer(res);
  } finally { clock.clear(timer); }
}

async function sendLive(d, op, req, fetchImpl, clock, secret) {
  if (op.resultOnly) req.redirect = 'manual';
  if (op.request.pathSecret) {
    const credential = secret(op.request.pathSecret);
    try {
      return redactDeep(await send(req, fetchImpl, clock, (res) => mapResponse(op, res)), [credential]);
    } catch (e) {
      throw Object.assign(new Error('authorized provider request failed'), { fault: e.fault });
    }
  }
  if (!d.token) return send(req, fetchImpl, clock, (res) => mapResponse(op, res));
  // Both requests share the delivery's time budget. A token error precedes the monetary request.
  if (new URL(req.url).origin !== new URL(d.base).origin) throw new Error('payment request left the declared origin');
  req.timeout /= 2;
  const preflight = tokenRequest(d.token, secret, req.timeout, op.tokenScope);
  let token;
  try { token = await send(preflight, fetchImpl, clock, accessToken); }
  catch (e) { throw new Error('could not authorize provider request', { cause: e }); }
  req.headers.authorization = `Bearer ${token}`;
  req.redirect = 'manual';
  try {
    return redactDeep(await send(req, fetchImpl, clock, (res) => mapResponse(op, res)), [token]);
  } catch (e) {
    throw Object.assign(new Error('authorized provider request failed'), { fault: e.fault });
  }
}

/**
 * Deliver one outbox row of this descriptor's kind: build the request, send it, map the answer. In `mode: 'sandbox'`
 * nothing is built or sent: the descriptor's sandbox rules answer. `secrets` is the store `{secret.x}` is read from.
 * @param {{ fetchImpl?: typeof fetch, trace?: (event: any) => void, secret?: (name: string) => any, secrets?: any, mode?: string, clock?: import('../types.d.ts').Clock, idemKey?: string, timeoutCapMs?: number }} [opts]
 */
export async function deliverRow(d, row, connector, opts = {}, sdk = undefined) {
  const { fetchImpl = fetch, trace = (_event) => {}, secrets, mode = 'live', clock = systemClock, idemKey, timeoutCapMs } = opts;
  const secret = opts.secret ?? (secrets && resolver(secrets, connector));
  const legacy = row.op === null || row.op === undefined;
  const opName = legacy ? d.legacy : row.op;
  if (!opName) throw new Error(`a "${d.name}" row needs an operation`);
  const input = legacy ? { body: row.payload } : row.payload;
  const op = operation(d, opName);
  let done;
  if (mode === 'sandbox') done = await mapResponse(op, sandboxResponse(d, opName, connector, input, idemKey));
  else if (sdk) {
    const scopes = scopesOf(d, connector, input, secret);
    const timeout = timeoutOf(d, scopes.config, timeoutCapMs ?? MAX_TIMEOUT_MS);
    const args = { op, scopes, timeout, idemKey, opName };
    done = await send({ timeout }, (_url, init) => sdk(fetchImpl, args, init.signal), clock, (res) => mapResponse(op, res));
  }
  else {
    const req = buildRequest(d, connector, opName, input, { secret, target: legacy ? row.target : undefined, idemKey, timeoutCapMs });
    done = await sendLive(d, op, req, fetchImpl, clock, secret);
  }
  if (done.drift.length) trace({ kind: 'contract_drift', id: row.id, connector: row.connector, op: opName, path: done.drift[0][0], message: done.drift[0][1] });
  return done.patch;
}

// `secrets` in a connector maps the descriptor's slots to names in the store: never a value.
/** @returns {[string, string, string?][]} */
function secretProblems(connector) {
  const map = connector?.secrets;
  if (map === undefined) return [];
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return [['secrets', '"secrets" maps a slot to the name of a secret in the store', '{"apiKey": "stripe_key"}']];
  return Object.entries(map).flatMap(([slot, name]) => (typeof name === 'string' && /^[A-Za-z_][\w-]*$/.test(name) ? []
    : [[`secrets/${slot}`, 'a secret is named by letters, digits, "_" and "-" (a name, never the value)']]));
}

/** The registry transport of a descriptor: its configuration is checked against "config", its rows go through the engine. */
export function synthesize(d, sdk = undefined) {
  return {
    summary: d.title || `the ${d.name} connector (${Object.keys(d.operations).join(', ')})`,
    validate: (connector) => [...secretProblems(connector), ...validate(d.config || { type: 'object', properties: {} }, configOf(d, connector), '')
      .map(/** @returns {[string, string, string?]} */ ([p, m, h]) => (h ? [p.slice(1), m, h] : [p.slice(1), m]))],
    deliver: (row, connector, opts) => deliverRow(d, row, connector, opts, sdk),
  };
}
