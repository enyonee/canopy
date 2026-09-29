// The engine of connector descriptors: from an operation and its input it builds the
// request, from the response it builds the outbox patch. No storage, no network of its
// own — the caller passes `fetchImpl`. `synthesize` turns a descriptor into the
// registry's transport, so the outbox delivers a descriptor's rows like any other.
import { validate, withDefaults } from './schema.mjs';
import { expand, pick } from './template.mjs';
import { METHODS } from './descriptor.mjs';

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
  const url = expand(op.request.url, scopes);
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
 * @param {{ secret?: (name: string) => any, target?: string }} [opts]
 */
export function buildRequest(d, connector, opName, input, opts = {}) {
  const { secret, target } = opts;
  const op = operation(d, opName);
  const scopes = scopesOf(d, connector, input, secret);
  const r = op.request;
  const method = r.method === undefined ? 'POST' : expand(r.method, scopes);
  if (!METHODS.includes(method)) throw new Error(`unsupported method "${method}"`);
  const body = r.body === undefined ? undefined : expand(r.body, scopes);
  return {
    method, url: target ?? requestUrl(op, scopes), headers: expand(r.headers || {}, scopes),
    body: body === undefined ? undefined : JSON.stringify(body),
    timeout: scopes.config.timeout || d.timeoutMs || DEFAULT_TIMEOUT_MS,
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
  if (!res.ok || !op.output) return { patch, drift: [] };
  const { drift, ...answer } = await readAnswer(op, res);
  return { patch: { ...patch, ...answer, drift: drift.length ? 1 : 0 }, drift };
}

/**
 * Deliver one outbox row of this descriptor's kind: build the request, send it, map the answer.
 * @param {{ fetchImpl?: typeof fetch, trace?: (event: any) => void, secret?: (name: string) => any }} [opts]
 */
export async function deliverRow(d, row, connector, opts = {}) {
  const { fetchImpl = fetch, trace = (_event) => {}, secret } = opts;
  const legacy = row.op === null || row.op === undefined;
  const opName = legacy ? d.legacy : row.op;
  if (!opName) throw new Error(`a "${d.name}" row needs an operation`);
  const req = buildRequest(d, connector, opName, legacy ? { body: row.payload } : row.payload, { secret, target: legacy ? row.target : undefined });
  const init = { method: req.method, headers: req.headers, signal: AbortSignal.timeout(req.timeout) };
  if (req.body !== undefined) init.body = req.body;
  const res = await fetchImpl(req.url, init);
  const { patch, drift } = await mapResponse(operation(d, opName), res);
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
