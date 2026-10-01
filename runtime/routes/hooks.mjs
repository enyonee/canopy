// POST /hook/<connector>: a provider's webhook. The one route that answers without a session, a cookie or a
// user: who sent it is decided by the signature recipe of the connector's descriptor (`inbound`) and nothing
// else, and only after the bytes are in (capped at 1 MiB) and before anything is parsed. It answers JSON only
// and never echoes anything of the payload, except the one bounded token of a descriptor's declared `challenge` (a
// provider's "is this endpoint yours?" request, answered only after the signature); every refusal body is a fixed word, and the trace keeps the reason
// (never the body). The steps of the event a webhook triggers run in ONE transaction with its dedup row, so a
// crash or a failing step leaves no row and the provider's retry is processed exactly once; a duplicate is 200
// (a provider retries anything else). Order: connector (404) → bytes (413) → signature (401) → JSON, challenge, type,
// schema, id (400) → unknown or unsubscribed type (200 ignored) → transaction (200 / duplicate / 500).
import { TooBig } from './context.mjs';
import { secretName } from '../connectors/engine.mjs';
import { verifySignature } from '../connectors/signature.mjs';
import { typeOf, eventIdOf, payloadProblems, valuesOf, challengeOf, missingOf } from '../connectors/inbound.mjs';

class Duplicate extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const brief = (e) => String(e && e.message).slice(0, 200);

function parseJson(raw) {
  try { return JSON.parse(raw.toString('utf8')); } catch { return undefined; } // allow-swallow: bytes that are not JSON are the caller's 400
}

// A refusal: the reason goes to the trace, the client gets `error` (for a signature, one word whatever the reason).
function refuse(ctx, connector, code, reason, error = reason) {
  ctx.trace({ kind: 'webhook_rejected', connector, reason });
  ctx.sendJson(code, { ok: false, error });
}

// The event's steps and its dedup row, in one transaction; true when it ran, false for a duplicate.
async function take(ctx, connector, type, eventId, values) {
  const { store, clock, interp } = ctx;
  try {
    await store.transaction(async (tx) => {
      if (await tx.inboundSeen(connector, eventId)) throw new Duplicate();
      await tx.inboundAdd(connector, eventId, clock.now());
      await interp.fireInbound(connector, type, values, tx);
    });
    return true;
  } catch (e) {
    if (e instanceof Duplicate) return false;
    throw e;
  }
}

// The provider asks whether the endpoint is ours (only after the signature checked out): the one place a request's own
// bytes are answered — a bounded token (challengeOf), as JSON, and nothing is stored or run.
function answerChallenge(ctx, name, echo) {
  if (echo === null) return refuse(ctx, name, 400, 'invalid_challenge');
  ctx.trace({ kind: 'webhook_challenge', connector: name });
  return ctx.sendJson(200, { challenge: echo });
}

async function receive(ctx, name, inbound) {
  const { req, graph, trace } = ctx;
  const raw = await ctx.rawBody();
  const secrets = ctx.env.secrets.get(secretName(graph.connectors[name], inbound.secret));
  const sig = verifySignature(inbound.signature, { headers: req.headers, raw, secrets, now: ctx.clock.now(), toleranceS: inbound.toleranceS });
  if (!sig.ok) return refuse(ctx, name, 401, sig.reason, 'unauthorized');
  const payload = parseJson(raw);
  if (!isObject(payload)) return refuse(ctx, name, 400, 'invalid_json');
  const echo = challengeOf(inbound, payload);
  if (echo !== undefined) return answerChallenge(ctx, name, echo);
  const type = typeOf(inbound, payload, req.headers);
  if (type === undefined) return refuse(ctx, name, 400, 'missing_type');
  const ev = Object.hasOwn(inbound.events, type) ? inbound.events[type] : null;
  if (!ev || !(graph.events || []).some((e) => e.inbound === `${name}.${type}`)) {
    trace({ kind: 'webhook_ignored', connector: name, type: type.slice(0, 64), known: Boolean(ev) });
    return ctx.sendJson(200, { ok: true, ignored: true });
  }
  if (payloadProblems(ev, payload).length) return refuse(ctx, name, 400, 'invalid_payload');
  const eventId = eventIdOf(inbound, payload, ev);
  if (eventId === undefined) return refuse(ctx, name, 400, 'invalid_event_id');
  // A payment made outside the app carries no order: answered, so the provider does not retry it, and never run, so a
  // step that selects rows by the missing value cannot select all of them.
  const values = valuesOf(ev, payload);
  const missing = missingOf(ev, values);
  if (missing !== undefined) {
    trace({ kind: 'webhook_ignored', connector: name, type, known: true, missing });
    return ctx.sendJson(200, { ok: true, ignored: true });
  }
  if (!await take(ctx, name, type, eventId, values)) {
    trace({ kind: 'webhook_duplicate', connector: name, type, eventId });
    return ctx.sendJson(200, { ok: true, duplicate: true });
  }
  trace({ kind: 'webhook', connector: name, type, eventId });
  try { await ctx.interp.flushNow(); } catch (e) { trace({ kind: 'error', message: brief(e) }); } // allow-swallow: the event is committed; the effects it queued are delivered by the flusher or /outbox
  return ctx.sendJson(200, { ok: true });
}

export async function handle(ctx) {
  const { parts, req, graph, registry } = ctx;
  if (parts[0] !== 'hook' || parts.length !== 2) return undefined;
  const name = parts[1];
  const inbound = Object.hasOwn(graph.connectors || {}, name) ? registry.descriptors[graph.connectors[name].kind]?.inbound : undefined;
  if (!inbound) { ctx.sendJson(404, { ok: false, error: 'not_found' }); return true; }
  if (req.method !== 'POST') { ctx.headers.allow = 'POST'; ctx.sendJson(405, { ok: false, error: 'method_not_allowed' }); return true; }
  try {
    await receive(ctx, name, inbound);
  } catch (e) {
    if (e instanceof TooBig) { ctx.headers.connection = 'close'; refuse(ctx, name, 413, 'too_large'); return true; }
    ctx.trace({ kind: 'webhook_failed', connector: name, message: brief(e) });
    ctx.sendJson(500, { ok: false, error: 'failed' });
  }
  return true;
}
