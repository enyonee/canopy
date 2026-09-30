// The `inbound` block of a descriptor: how a provider's webhooks are authenticated (`signature`, with the
// `secret` slot and the `toleranceS` replay window), where in a request its event type and its id sit
// (`type`, `eventId`: a `$.path` into the JSON body or `{"header": "name"}`), and which event types it may send
// (`events`: each with the `schema` its payload must satisfy and an optional `map` that names the values the app's
// steps receive). Pure; `checkInbound` is fail closed like the rest of the descriptor checker.
import { checkSchema, validate } from './schema.mjs';
import { pathSteps, pick } from './template.mjs';
import { checkRecipe } from './signature.mjs';

const KEYS = ['signature', 'secret', 'toleranceS', 'eventId', 'type', 'events'];
const EVENT_KEYS = ['schema', 'map'];
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

function checkEvent(ev, path) {
  if (!isObject(ev)) return [[path, 'an inbound event is an object with a "schema"']];
  const out = Object.keys(ev).filter((k) => !EVENT_KEYS.includes(k)).map((k) => [`${path}/${k}`, `unknown key "${k}"`, `allowed: ${EVENT_KEYS.join(', ')}`]);
  if (!isObject(ev.schema)) return [...out, [`${path}/schema`, 'an inbound event needs a "schema" (of type object) its payload must satisfy', '{"type": "object", "required": ["id"]}']];
  out.push(...checkSchema(ev.schema, `${path}/schema`));
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

/** What is wrong with the `inbound` block of a descriptor: [[path, message, hint?]]. */
export function checkInbound(inb) {
  if (!isObject(inb)) return [['/inbound', '"inbound" is an object']];
  const out = Object.keys(inb).filter((k) => !KEYS.includes(k)).map((k) => [`/inbound/${k}`, `unknown key "${k}"`, `allowed: ${KEYS.join(', ')}`]);
  out.push(...checkRecipe(inb.signature, '/inbound/signature'));
  if (typeof inb.secret !== 'string' || !/^[A-Za-z_][\w-]*$/.test(inb.secret)) out.push(['/inbound/secret', 'inbound names the "secret" slot whose store value signs the webhooks', '"secret": "webhookSecret"']);
  if (inb.toleranceS !== undefined && !(Number.isInteger(inb.toleranceS) && inb.toleranceS >= 1 && inb.toleranceS <= 86400)) out.push(['/inbound/toleranceS', '"toleranceS" is a whole number of seconds, 1 to 86400 (default 300)']);
  out.push(...checkLocator(inb.eventId, '/inbound/eventId', 'eventId'), ...checkLocator(inb.type, '/inbound/type', 'type'));
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

/** The provider's id of an event as text, or undefined when it is missing or unusable as a key. */
export function eventIdOf(inb, payload, headers) {
  const id = locate(inb.eventId, payload, headers);
  const text = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  return typeof text === 'string' && text !== '' && text.length <= MAX_EVENT_ID ? text : undefined;
}

/** Problems of a payload against its event's schema (open: a provider may send more than the schema names). */
export const payloadProblems = (ev, payload) => validate(ev.schema, payload, '', { extra: true });

/** The values an app's steps receive: the `map` picks, else the payload's top-level scalars. */
export function valuesOf(ev, payload) {
  if (ev.map) return Object.fromEntries(Object.entries(ev.map).map(([name, p]) => [name, pick(p, payload)]));
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v === null || typeof v !== 'object'));
}
