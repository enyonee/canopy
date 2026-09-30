// Who sent this webhook? A provider signs the raw body with a secret both sides hold; this module
// says whether a request's headers and bytes carry a signature made with one of the secrets we hold.
// Four recipes: `stripe` (t=<unix>,v1=<hex>[,v1=…] over "t.raw"), `slack` (v0=<hex> over "v0:ts:raw"), a
// generic `hmac` ({header, algo, encoding, prefix, signed, timestampHeader}) and `basic` (HTTP Basic).
// Pure: the caller hands in the headers, the raw bytes, the secrets (newest first, so a rotation keeps
// the old one working) and the time. Fail closed: anything missing or odd is a refusal with a reason,
// and every comparison is constant time (`timingSafeEqual`, after a length check — it throws on a
// length mismatch). The signing side lives here too, so `--connectors simulate` and the tests sign with
// exactly what verification reads.
import crypto from 'node:crypto';

const SCHEMES = ['stripe', 'slack', 'hmac', 'basic'];
const ALGOS = ['sha256', 'sha1'];
const ENCODINGS = ['hex', 'base64'];
const SIGNED = ['raw', 'ts.raw'];
const HEADER = /^[A-Za-z0-9-]+$/;
const SECONDS = /^\d{1,12}$/;
const SHAPES = {
  stripe: ['scheme', 'header'],
  slack: ['scheme'],
  basic: ['scheme'],
  hmac: ['scheme', 'header', 'algo', 'encoding', 'prefix', 'signed', 'timestampHeader'],
};

/** What is wrong with a signature recipe of a descriptor: [[path, message, hint?]]. */
export function checkRecipe(r, path) {
  if (r === null || typeof r !== 'object' || Array.isArray(r) || !SCHEMES.includes(r.scheme))
    return [[path, `"signature" is an object with a "scheme": ${SCHEMES.join(', ')}`, '{"scheme": "stripe"}']];
  const out = Object.keys(r).filter((k) => !SHAPES[r.scheme].includes(k)).map((k) => [`${path}/${k}`, `unknown key "${k}" for the ${r.scheme} scheme`, `allowed: ${SHAPES[r.scheme].join(', ')}`]);
  const bad = (k, message, hint) => out.push([`${path}/${k}`, message, hint]);
  if (r.header !== undefined && (typeof r.header !== 'string' || !HEADER.test(r.header))) bad('header', '"header" is an HTTP header name');
  if (r.scheme !== 'hmac') return out;
  if (r.header === undefined) bad('header', 'an hmac signature names the "header" that carries it');
  if (!ALGOS.includes(r.algo)) bad('algo', `"algo" is one of: ${ALGOS.join(', ')}`);
  if (!ENCODINGS.includes(r.encoding)) bad('encoding', `"encoding" is one of: ${ENCODINGS.join(', ')}`);
  if (r.prefix !== undefined && (typeof r.prefix !== 'string' || r.prefix.length > 32)) bad('prefix', '"prefix" is a short string (for example "sha256=")');
  if (r.signed !== undefined && !SIGNED.includes(r.signed)) bad('signed', `"signed" is one of: ${SIGNED.join(', ')}`);
  const stamped = r.signed === 'ts.raw';
  if (stamped && (typeof r.timestampHeader !== 'string' || !HEADER.test(r.timestampHeader))) bad('timestampHeader', '"signed": "ts.raw" needs the "timestampHeader" that carries the unix time');
  if (!stamped && r.timestampHeader !== undefined) bad('timestampHeader', 'a timestamp that is not part of the signed text proves nothing: use "signed": "ts.raw"');
  return out;
}

const cat = (head, raw) => Buffer.concat([Buffer.from(head), raw]);
const digest = (p, secret, data) => p.prefix + crypto.createHmac(p.algo, secret).update(data).digest(p.encoding);

/** Constant-time equality of two strings (a length mismatch is simply unequal, never a throw). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// stripe: "t=1700000000,v1=abc,v1=def" — any number of v1 (a provider signs with old and new secrets during a roll).
function readStripe(header) {
  return (headers) => {
    const value = headers[header];
    if (typeof value !== 'string') return 'signature_missing';
    const pairs = value.split(',').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]);
    const t = pairs.find(([k]) => k === 't')?.[1];
    const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
    return t !== undefined && SECONDS.test(t) && sigs.length ? { sigs, ts: t } : 'signature_malformed';
  };
}

// One signature header, and a timestamp header when the scheme has one.
function readHeaders(p) {
  return (headers) => {
    const sig = headers[p.header], ts = p.tsHeader ? headers[p.tsHeader] : null;
    if (typeof sig !== 'string' || (p.tsHeader && typeof ts !== 'string')) return 'signature_missing';
    return ts === null || SECONDS.test(ts) ? { sigs: [sig], ts } : 'signature_malformed';
  };
}

// The recipe as one shape: how to read the candidates, what is signed, how to write the headers.
function plan(r) {
  if (r.scheme === 'stripe') {
    const header = (r.header ?? 'stripe-signature').toLowerCase();
    return { algo: 'sha256', encoding: 'hex', prefix: '', read: readStripe(header), signed: (t, raw) => cat(`${t}.`, raw),
      write: (t, sig) => ({ [header]: `t=${t},v1=${sig}` }) };
  }
  const p = r.scheme === 'slack'
    ? { header: 'x-slack-signature', tsHeader: 'x-slack-request-timestamp', prefix: 'v0=', algo: 'sha256', encoding: 'hex', signed: (t, raw) => cat(`v0:${t}:`, raw) }
    : { header: r.header.toLowerCase(), tsHeader: r.timestampHeader?.toLowerCase(), prefix: r.prefix ?? '', algo: r.algo, encoding: r.encoding, signed: r.signed === 'ts.raw' ? (t, raw) => cat(`${t}.`, raw) : (_t, raw) => raw };
  return { ...p, read: readHeaders(p), write: (t, sig) => ({ [p.header]: sig, ...(p.tsHeader ? { [p.tsHeader]: t } : {}) }) };
}

const basicOf = (secret) => `Basic ${Buffer.from(secret).toString('base64')}`;

function verifyBasic(headers, secrets) {
  const got = headers.authorization;
  if (typeof got !== 'string') return { ok: false, reason: 'signature_missing' };
  let ok = false;
  for (const s of secrets) ok = safeEqual(got, basicOf(s)) || ok; // every secret is compared: no early exit
  return ok ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

/**
 * Is this request signed by one of `secrets`? `headers` are Node's (lower case), `raw` the body bytes, `now` epoch
 * milliseconds. A scheme with a timestamp also has to be inside `toleranceS` seconds of it, and only after the
 * signature itself checks out. Returns { ok: true } or { ok: false, reason }.
 * @param {any} recipe
 * @param {{ headers: Record<string, any>, raw: Buffer, secrets: string[], now: number, toleranceS?: number }} req
 */
export function verifySignature(recipe, { headers, raw, secrets, now, toleranceS = 300 }) {
  if (recipe.scheme === 'basic') return secrets.length ? verifyBasic(headers, secrets) : { ok: false, reason: 'secret_not_set' };
  const p = plan(recipe);
  const got = p.read(headers);
  if (typeof got === 'string') return { ok: false, reason: got };
  if (!secrets.length) return { ok: false, reason: 'secret_not_set' };
  const data = p.signed(got.ts, raw);
  let ok = false;
  for (const secret of secrets) {
    const want = digest(p, secret, data);
    for (const sig of got.sigs) ok = safeEqual(sig, want) || ok;
  }
  if (!ok) return { ok: false, reason: 'signature_mismatch' };
  if (got.ts !== null && Math.abs(now / 1000 - Number(got.ts)) > toleranceS) return { ok: false, reason: 'timestamp_stale' };
  return { ok: true };
}

/** The headers a provider would send for `raw`, signed with `secret` at `now` (epoch ms). */
export function signHeaders(recipe, { raw, secret, now }) {
  if (recipe.scheme === 'basic') return { authorization: basicOf(secret) };
  const p = plan(recipe);
  const t = String(Math.floor(now / 1000));
  return p.write(t, digest(p, secret, p.signed(t, raw)));
}
