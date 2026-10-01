// /settings: the connector settings screen of an admin (vc.settings, like /outbox) and its three POSTs:
//   POST /settings/secret         connector, slot, value   set or replace one slot's secret (an empty value changes nothing)
//   POST /settings/secret/remove  connector, slot, confirm=yes
//   POST /settings/test           connector                one operation through the sandbox, sandbox mode only
// Every POST is refused unless it comes from this site: there is no CSRF token in the app (the session cookie is
// SameSite=Lax), so the Origin header (else Referer) must name the Host the request was made to; neither header is a refusal.
// A secret's value is written to the store and nowhere else: not echoed, not in the redirect, not in the trace (which
// keeps the connector, the slot and the store name), and masked in any error. Switching a connector to live is not here:
// the screen shows the command line (`--connectors live NAME --confirm`).
import { errorPage, noticePage, forbiddenPage } from '../render.mjs';
import { settingsView } from '../render/settings.mjs';
import { secretSlots, secretName, prepare, deliverRow } from '../connectors/engine.mjs';
import { redact } from '../connectors/redact.mjs';
import { CLOSED } from '../connectors/backoff.mjs';

const DAY_MS = 24 * 3600 * 1000;
const MAX_SECRET = 4096;
const NONE = { sent: 0, failed: 0, unknown: 0, drift: 0 };

/** Is this POST from the page's own site? The Origin (else the Referer) names the same host the request was sent to. */
function sameOrigin(req) {
  const from = req.headers.origin ?? req.headers.referer;
  if (!from) return false;
  try { return new URL(from).host === req.headers.host; } catch { return false; } // allow-swallow: a header that is not a URL is a cross-site request, refused
}

// Every value the store holds, for masking an error; an unreadable store holds nothing that could leak.
function held(secrets) {
  try { return secrets.values(); } catch { return []; } // allow-swallow: an unreadable store has no values to mask, and the screen says why
}

// The names in the store, once (one read of the file for the whole screen); null when the store cannot be read.
function storeNames(secrets) {
  try { return new Set(secrets.names()); } catch { return null; } // allow-swallow: shown on the screen as "unreadable", never as set or missing
}

// The operation "send test" runs: the descriptor's sandbox.test, else its first operation with sandbox rules and an empty input.
function testOf(d) {
  if (!d?.modes?.includes('sandbox')) return null;
  const op = d.sandbox.test?.op ?? Object.keys(d.operations).find((n) => d.sandbox.operations[n]);
  return op ? { op, input: d.sandbox.test?.input ?? {} } : null;
}

function itemsOf(ctx) {
  const { graph, registry, store, env, clock, interp } = ctx;
  const names = storeNames(env.secrets);
  const stats = store.outboxStats(new Date(clock.now() - DAY_MS).toISOString());
  const breakers = new Map(store.breakers().map((b) => [`${b.connector}|${b.mode}`, b]));
  const items = interp.modes().map((m) => {
    const d = registry.descriptors[m.kind];
    const c = graph.connectors[m.connector];
    return { ...m, test: testOf(d)?.op ?? null, counts: stats[m.connector] ?? NONE,
      breakers: Object.fromEntries(m.modes.map((mode) => [mode, breakers.get(`${m.connector}|${mode}`) ?? { connector: m.connector, mode, ...CLOSED }])),
      slots: (d ? secretSlots(d) : []).map((slot) => ({ slot, name: secretName(c, slot), set: names ? names.has(secretName(c, slot)) : false })),
      hook: d?.inbound ? `/hook/${m.connector}` : null };
  });
  return { items, unreadable: names === null, graphFile: ctx.graphFile };
}

// What the page says about each connector as plain data (the JSON answer): the same facts, still no value.
const plainItem = (it) => ({ connector: it.connector, kind: it.kind, mode: it.mode, modes: it.modes, breakers: it.breakers, counts: it.counts,
  slots: it.slots.map((s) => ({ slot: s.slot, name: s.name, set: s.set })), webhook: it.hook, test: it.test });

function show(ctx, extra = {}) {
  const { graph, vc, flash } = ctx;
  const model = { ...itemsOf(ctx), ...extra };
  ctx.headers['cache-control'] = 'no-store';
  ctx.answer(200, settingsView(graph, vc, flash, model), { ok: true, connectors: model.items.map(plainItem), test: extra.test ?? null });
}

const refuse = (ctx, code, message) => ctx.answer(code, noticePage(ctx.graph, ctx.vc, 'Not done', message), { ok: false, status: code, errors: [message] });

// The connector and slot a form names, or null: only a slot the connector's descriptor reads (or verifies webhooks with) can be touched.
function slotOf(ctx, b) {
  const { graph, registry } = ctx;
  const name = typeof b.connector === 'string' && Object.hasOwn(graph.connectors, b.connector) ? b.connector : null;
  const d = name && registry.descriptors[graph.connectors[name].kind];
  if (!d || typeof b.slot !== 'string' || !secretSlots(d).includes(b.slot)) return null;
  return { connector: name, slot: b.slot, name: secretName(graph.connectors[name], b.slot) };
}

function done(ctx, message) {
  if (ctx.wantsJSON) ctx.sendJson(200, { ok: true, message });
  else ctx.ok('/settings', message);
}

async function setSecret(ctx) {
  const b = await ctx.body();
  const at = slotOf(ctx, b);
  if (!at) return refuse(ctx, 404, 'No such connector or secret slot.');
  const value = typeof b.value === 'string' ? b.value : '';
  if (value === '') return done(ctx, `${at.name}: no change (the value was empty)`);
  if (value.length > MAX_SECRET) return refuse(ctx, 400, `A secret is at most ${MAX_SECRET} characters.`);
  try { ctx.env.secrets.set(at.name, value); } catch (e) { return refuse(ctx, 400, redact(e.message, [value, ...held(ctx.env.secrets)])); }
  ctx.trace({ kind: 'secret_set', connector: at.connector, slot: at.slot, name: at.name, by: ctx.user?.id ?? null });
  return done(ctx, `${at.name} saved`);
}

async function removeSecret(ctx) {
  const b = await ctx.body();
  const at = slotOf(ctx, b);
  if (!at) return refuse(ctx, 404, 'No such connector or secret slot.');
  if (b.confirm !== 'yes') return refuse(ctx, 400, `${at.name} was not removed: tick the confirmation box.`);
  let removed;
  try { removed = ctx.env.secrets.remove(at.name); } catch (e) { return refuse(ctx, 400, redact(e.message, held(ctx.env.secrets))); }
  if (removed) ctx.trace({ kind: 'secret_removed', connector: at.connector, slot: at.slot, name: at.name, by: ctx.user?.id ?? null });
  return done(ctx, removed ? `${at.name} removed` : `${at.name} was not set`);
}

// The names and types of a value, not the value: what an operation's answer looks like.
const shapeOf = (v) => (Array.isArray(v) ? [v.length ? shapeOf(v[0]) : 'empty'] : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)])) : v === null ? 'null' : typeof v);

function shapeOfText(text) {
  try { return shapeOf(JSON.parse(text)); } catch { return 'not JSON, or cut short'; } // allow-swallow: the screen says the answer could not be read; it is a display, not a decision
}

async function sendTest(ctx) {
  const { graph, registry, env, trace } = ctx;
  const b = await ctx.body();
  const name = typeof b.connector === 'string' && Object.hasOwn(graph.connectors, b.connector) ? b.connector : null;
  const m = name && ctx.interp.modes().find((x) => x.connector === name);
  if (!m) return refuse(ctx, 404, 'No such connector.');
  if (m.mode !== 'sandbox') return refuse(ctx, 400, `${name} runs live: a test is never sent from this screen (only through the sandbox).`);
  const d = registry.descriptors[m.kind];
  const t = testOf(d);
  if (!t) return refuse(ctx, 400, `${name} (${m.kind}) has no sandbox operation to test.`);
  const c = graph.connectors[name];
  let patch;
  try {
    const { input } = prepare(d, c, t.op, t.input);
    patch = await deliverRow(d, { id: null, connector: name, op: t.op, payload: input }, c, { mode: 'sandbox', idemKey: 'settings-test', clock: ctx.clock });
  } catch (e) { patch = { status: 'failed', code: null, error: redact(e.message, held(env.secrets)) }; }
  const raw = patch.response ?? patch.result;
  const shape = raw === undefined ? null : shapeOfText(raw);
  const test = { connector: name, op: t.op, status: patch.status, code: patch.code ?? null, error: patch.error ? redact(patch.error, held(env.secrets)) : null, shape };
  trace({ kind: 'settings_test', connector: name, op: t.op, status: test.status, code: test.code });
  return show(ctx, { test });
}

const POSTS = { 'secret': setSecret, 'secret/remove': removeSecret, 'test': sendTest };

// Always a 403, for a guest too (ctx.deny would send a signed-out GET to the login page, which says nothing is here for them).
function forbid(ctx, message = 'You are not allowed to do this.') {
  ctx.trace({ kind: 'denied', path: ctx.url.pathname, who: ctx.user?.id ?? null, role: ctx.role });
  if (ctx.wantsJSON) ctx.sendJson(403, { ok: false, status: 403, errors: [message] });
  else ctx.send(403, forbiddenPage(ctx.graph, ctx.vc, message));
}

export async function handle(ctx) {
  const { parts, req, vc, graph } = ctx;
  if (parts[0] !== 'settings') return undefined;
  if (!vc.settings) { forbid(ctx); return true; }
  const rest = parts.slice(1).join('/');
  if (!graph.connectors || (rest !== '' && !Object.hasOwn(POSTS, rest))) { ctx.send(404, errorPage(graph, 'no such page')); return true; }
  if (rest === '') { if (req.method === 'GET') show(ctx); else { ctx.headers.allow = 'GET'; refuse(ctx, 405, 'Use GET.'); } return true; }
  if (req.method !== 'POST') { ctx.headers.allow = 'POST'; refuse(ctx, 405, 'Use POST.'); return true; }
  if (!sameOrigin(req)) { forbid(ctx, 'This request did not come from this site.'); return true; }
  await POSTS[rest](ctx);
  return true;
}
