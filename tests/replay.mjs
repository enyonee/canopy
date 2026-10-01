// Hermetic provider tests (docs/CONNECTORS.md section 6): the recordings under connectors/<name>/fixtures, a `fetch`
// that answers only from them, and a scan that keeps a secret out of them. No network anywhere: a request no recording
// answers throws, it is never sent and never answered with a made-up default.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'connectors');
export const REDACTED = '«redacted»';

/** The parsed fixtures of a connector, as { file, ...fixture }: `op` ones (a request and its answer) and `inbound` ones (a webhook). */
export function loadFixtures(name) {
  const dir = path.join(ROOT, name, 'fixtures');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}

export const loadDescriptor = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name, 'descriptor.json'), 'utf8'));
export const connectorNames = () => fs.readdirSync(ROOT).filter((n) => fs.existsSync(path.join(ROOT, n, 'descriptor.json'))).sort();

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

/** A body as text, so that the same body written in another key order is the same: JSON with sorted keys, or sorted form pairs. */
export function canonicalBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') return JSON.stringify(sortKeys(body));
  try { return JSON.stringify(sortKeys(JSON.parse(body))); } catch { return body.split('&').sort().join('&'); } // allow-swallow: not JSON, so it is a form body
}

/** Header names in lower case; any value that holds one of `secrets` is replaced by REDACTED (what a recorder would have written). */
export const redactHeaders = (headers, secrets) => Object.fromEntries(Object.entries(headers || {})
  .map(([k, v]) => [k.toLowerCase(), secrets.some((s) => String(v).includes(s)) ? REDACTED : v]));

const answer = (r) => {
  const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  const headers = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => text };
};

/**
 * A `fetchImpl` that answers from recordings: matched on method, url and the canonical body (headers are redacted in a
 * recording and are not matched). A request no recording matches throws — fail closed, nothing falls through to
 * a default answer or to the network. `.calls` lists what was asked.
 */
export function replayFetch(fixtures) {
  const recorded = fixtures.filter((f) => f.request && f.response);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = [init.method || 'GET', String(url), canonicalBody(init.body)];
    calls.push(key);
    const hit = recorded.find((f) => f.request.method === key[0] && f.request.url === key[1] && canonicalBody(f.request.body) === key[2]);
    if (!hit) throw new Error(`replay miss: no recording answers ${key[0]} ${key[1]} ${key[2].slice(0, 120)}`);
    return answer(hit.response);
  };
  return Object.assign(fetchImpl, { calls });
}

const entropy = (s) => {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  return -[...n.values()].reduce((sum, k) => sum + (k / s.length) * Math.log2(k / s.length), 0);
};
const PATTERNS = [
  [/\bsk_/, 'a Stripe secret key (sk_)'], [/\b(rk|pk)_(live|test)_/, 'a Stripe key'], [/\bwhsec_/, 'a Stripe webhook secret'],
  [/Bearer\s/, 'a bearer token'], [/\bxox[abprs]-/, 'a Slack token'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}/, 'a JWT'],
];

/** What in `text` looks like a secret: known key shapes, a JWT, or a long token of high entropy (or a long hex string). */
export function suspicious(text) {
  const hits = PATTERNS.filter(([re]) => re.test(text)).map(([, what]) => what);
  // A url or a media type is long and slashed, and says nothing; what is left is scanned for tokens.
  const rest = text.replace(/https?:\/\/[^\s"']+/g, ' ').replace(/\b[a-z]+\/[a-z0-9.+-]+/g, ' ');
  for (const token of rest.match(/[A-Za-z0-9+/_-]{32,}={0,2}/g) || []) {
    if (/^[0-9a-fA-F]{32,}$/.test(token) || entropy(token) >= 3.5) hits.push(`a long token "${token.slice(0, 12)}…"`);
  }
  return hits;
}
