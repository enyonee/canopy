// The `inbound` block of a descriptor: how a provider's webhooks are authenticated (`signature`, with the
// `secret` slot and the `toleranceS` replay window), where in a request its event type and its id sit
// (`type`: a `$.path` into the JSON body or `{"header": "name"}`; `eventId`: a `$.path` into the signed body only), and which event types it may send
// (`events`: each with the `schema` its payload must satisfy, an optional `map` that names the values the app's
// steps receive and an optional `eventId` of its own), and the one request a provider sends to see that the endpoint is
// ours (`challenge`: the answer echoes one bounded value of it). Pure; `checkInbound` is fail closed like the rest of the descriptor checker.
import { checkSchema, validate } from './schema.mjs';
import { pathSteps, pick } from './template.mjs';
import { checkRecipe } from './signature.mjs';

const KEYS = ['signature', 'secret', 'toleranceS', 'eventId', 'type', 'challenge', 'events'];
const EVENT_KEYS = ['schema', 'map', 'eventId'];
const CHALLENGE_KEYS = ['type', 'equals', 'echo'];
// What a challenge may be echoed as: a token, never markup or a sentence — and never longer than this.
const CHALLENGE_VALUE = /^[A-Za-z0-9._~-]{1,128}$/;
// The longest event id kept for deduplication.
const MAX_EVENT_ID = 255;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkLocator(v, path, what) {
  if (typeof v === 'string') {
    try { pathSteps(v); return []; } catch (e) { return [[path, e.message]]; }
  }
  if (isObject(v) && Object.keys(v).length === 1 && typeof v.header === 'string' && /^[A-Za-z0-9-]+$/.test(v.header)) return [];
  return [[path, `"${what}" is a $.path into the JSON body or {"header": "name"}`, `"${what}": "$.id"`]];
}

// The dedup id: a $.path into the signed body, or a list of up to 4 of them that together make it (a provider whose
// event has no single id field). Never a header: no recipe signs one, so a replayer could change it.
function checkEventId(v, path) {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > 4 || list.some((p) => typeof p !== 'string')) return [[path, '"eventId" is a $.path into the signed JSON body: a header is not covered by the signature, so a replay could change it', '"eventId": "$.id"']];
  return list.flatMap((p) => checkLocator(p, path, 'eventId'));
}

function checkEvent(ev, path) {
  if (!isObject(ev)) return [[path, 'an inbound event is an object with a "schema"']];
  const out = Object.keys(ev).filter((k) => !EVENT_KEYS.includes(k)).map((k) => [`${path}/${k}`, `unknown key "${k}"`, `allowed: ${EVENT_KEYS.join(', ')}`]);
  if (!isObject(ev.schema)) return [...out, [`${path}/schema`, 'an inbound event needs a "schema" (of type object) its payload must satisfy', '{"type": "object", "required": ["id"]}']];
  out.push(...checkSchema(ev.schema, `${path}/schema`));
  if (ev.eventId !== undefined) out.push(...checkEventId(ev.eventId, `${path}/eventId`));
  if (ev.schema.type !== 'object') out.push([`${path}/schema/type`, 'a payload is an object: "type" must be "object"']);
  if (ev.map === undefined) return out;
  if (!isObject(ev.map)) return [...out, [`${path}/map`, '"map" maps a value name to a $.path in the payload']];
  for (const [name, p] of Object.entries(ev.map)) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) out.push([`${path}/map/${name}`, `"${name}" cannot be a value name`]);
    if (typeof p !== 'string') out.push([`${path}/map/${name}`, 'a mapped value is a $.path in the payload']);
    else out.push(...checkLocator(p, `${path}/map/${name}`, 'map'));
  }
  return out;
}

// The one deliberate echo: a request whose `type` path holds `equals` is the provider asking whether the endpoint is ours,
// and the answer is the `echo` value of the request, which must be a short token (CHALLENGE_VALUE). The signature is
// verified first like for any webhook; a challenge is never an event (no dedup row, no steps).
function checkChallenge(c) {
  if (!isObject(c)) return [['/inbound/challenge', '"challenge" is an object', '{"type": "$.type", "equals": "url_verification", "echo": "$.challenge"}']];
  const out = Object.keys(c).filter((k) => !CHALLENGE_KEYS.includes(k)).map((k) => [`/inbound/challenge/${k}`, `unknown key "${k}"`, `allowed: ${CHALLENGE_KEYS.join(', ')}`]);
  for (const k of ['type', 'echo']) out.push(...(typeof c[k] === 'string' ? checkLocator(c[k], `/inbound/challenge/${k}`, k) : [[`/inbound/challenge/${k}`, `"${k}" is a $.path into the JSON body`]]));
  if (typeof c.equals !== 'string' || c.equals === '') out.push(['/inbound/challenge/equals', '"equals" is the text the type has in a challenge request']);
  return out;
}

/** What is wrong with the `inbound` block of a descriptor: [[path, message, hint?]]. */
export function checkInbound(inb) {
  if (!isObject(inb)) return [['/inbound', '"inbound" is an object']];
  const out = Object.keys(inb).filter((k) => !KEYS.includes(k)).map((k) => [`/inbound/${k}`, `unknown key "${k}"`, `allowed: ${KEYS.join(', ')}`]);
  out.push(...checkRecipe(inb.signature, '/inbound/signature'));
  if (typeof inb.secret !== 'string' || !/^[A-Za-z_][\w-]*$/.test(inb.secret)) out.push(['/inbound/secret', 'inbound names the "secret" slot whose store value signs the webhooks', '"secret": "webhookSecret"']);
  if (inb.toleranceS !== undefined && !(Number.isInteger(inb.toleranceS) && inb.toleranceS >= 1 && inb.toleranceS <= 86400)) out.push(['/inbound/toleranceS', '"toleranceS" is a whole number of seconds, 1 to 86400 (default 300)']);
  // The id is the dedup key, so it must be something the signature covers: the body. A header is not signed by any recipe,
  // and whoever replays a captured request could change it and make the same event a new one.
  out.push(...checkEventId(inb.eventId, '/inbound/eventId'));
  out.push(...checkLocator(inb.type, '/inbound/type', 'type'));
  if (inb.challenge !== undefined) out.push(...checkChallenge(inb.challenge));
  if (!isObject(inb.events) || !Object.keys(inb.events).length) return [...out, ['/inbound/events', 'inbound lists the "events" it may send, each with a "schema"', '"events": {"payment.succeeded": {"schema": {"type": "object"}}}']];
  for (const [name, ev] of Object.entries(inb.events)) out.push(...checkEvent(ev, `/inbound/events/${name}`));
  return out;
}

// What `spec` (a $.path or {header}) names in a request: the parsed body and Node's lower-case headers.
const locate = (spec, payload, headers) => (typeof spec === 'string' ? pick(spec, payload) : headers[spec.header.toLowerCase()]);

/** The event type of a request, or undefined when it names none. */
export function typeOf(inb, payload, headers) {
  const t = locate(inb.type, payload, headers);
  return typeof t === 'string' && t !== '' ? t : undefined;
}

// One piece of an id: text, or a whole number; anything else is not usable.
const idPart = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : v);

/**
 * The provider's id of an event as text, or undefined when it is missing or unusable as a key. The event's own `eventId`
 * wins over the block's; a list of paths makes a JSON array of the pieces (so no piece can run into the next).
 */
export function eventIdOf(inb, payload, ev) {
  const spec = ev?.eventId ?? inb.eventId;
  const parts = (Array.isArray(spec) ? spec : [spec]).map((p) => idPart(pick(p, payload)));
  if (parts.some((t) => typeof t !== 'string' || t === '')) return undefined;
  const id = parts.length === 1 ? parts[0] : JSON.stringify(parts);
  return id.length <= MAX_EVENT_ID ? id : undefined;
}

/**
 * The echo a challenge request wants: undefined when the request is not a challenge, null when it is one but its value is
 * unusable (not a short token), else the value.
 */
export function challengeOf(inb, payload) {
  const c = inb.challenge;
  if (!c || pick(c.type, payload) !== c.equals) return undefined;
  const v = pick(c.echo, payload);
  return typeof v === 'string' && CHALLENGE_VALUE.test(v) ? v : null;
}

/** Problems of a payload against its event's schema (open: a provider may send more than the schema names). */
export const payloadProblems = (ev, payload) => validate(ev.schema, payload, '', { extra: true });

/** The values an app's steps receive: the `map` picks, else the payload's top-level scalars. */
export function valuesOf(ev, payload) {
  if (ev.map) return Object.fromEntries(Object.entries(ev.map).map(([name, p]) => [name, pick(p, payload)]));
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v === null || typeof v !== 'object'));
}
