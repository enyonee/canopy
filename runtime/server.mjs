// The HTTP shell. Loads and validates the graph, boots the store and the
// interpreter, and for every request builds one request context and tries
// the route modules in order — session routes first (they work signed out),
// then the "you must be signed in" gate, then the rest. Each route module
// answers the request itself (see routes/context.mjs's send/redirect/ok/deny)
// and reports back whether it handled the request; routes/entity.mjs is
// terminal and always does. No route module has HTTP-server bring-up
// knowledge, and this file has no routing knowledge beyond the try order.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { validate, formatErrors } from './validate.mjs';
import { Store } from './store.mjs';
import { DEFAULT } from './registry.mjs';
import { permissions, sessions } from './auth.mjs';
import { createInterpreter } from './interp.mjs';
import { bootstrapIdentity, bootstrapSeed } from './boot.mjs';
import { errorPage, noticePage } from './render.mjs';
import { createContext, TooBig } from './routes/context.mjs';
import * as session from './routes/session.mjs';
import * as views from './routes/views.mjs';
import * as system from './routes/system.mjs';
import * as entity from './routes/entity.mjs';
import * as widgets from './routes/widgets.mjs';
import * as schedule from './routes/schedule.mjs';
import * as hooks from './routes/hooks.mjs';
import * as settings from './routes/settings.mjs';
import { everyMs } from './schedule.mjs';
import { flush } from './outbox.mjs';
import { systemClock } from './clock.mjs';
import { connectorEnv } from './deploy.mjs';

// What a server answers while the graph cannot be served: the errors, on every path.
function invalidHandler(graph, errors) {
  console.error(`graph is invalid:\n${formatErrors(errors)}`);
  return (_, res) => {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(errorPage(null, formatErrors(errors)));
  };
}

function invalidGraphServer(graph, errors, port, host) {
  const server = http.createServer(invalidHandler(graph, errors));
  server.listen(port, host);
  const app = { server, graph, invalid: true, ready: null };
  app.ready = Promise.resolve(app);
  return app;
}

async function dispatch(ctx) {
  if (widgets.handle(ctx)) return;
  if (await hooks.handle(ctx)) return; // a provider's webhook: signed, never a session — before the gate below
  if (await session.handle(ctx)) return;
  if (ctx.perms.enabled && !ctx.role) { ctx.deny('Please sign in.'); return; }
  if (await views.handle(ctx)) return;
  if (await settings.handle(ctx)) return;
  if (await system.handle(ctx)) return;
  if (await schedule.handle(ctx)) return;
  await entity.handle(ctx); // terminal: answers even when nothing else matches
}

// A schedule's steps run like a global action, on its own timer — unref'd
// (never keeps the process alive by itself) and stopped when the server
// closes. `noTimers` (cli.mjs sets it from AG_NO_TIMERS) is how verify/run.mjs
// and tests keep every effect deterministic: only `POST /schedule/<name>/run`
// runs them then.
function startTimers(graph, interp, trace, server, noTimers) {
  if (noTimers) return;
  for (const sched of graph.schedule || []) {
    const timer = setInterval(async () => {
      trace({ kind: 'schedule', name: sched.name, manual: false });
      try { await interp.attempt(async (tx) => await interp.runSteps(sched.do, { rowEntity: null, id: null, values: {}, user: null, tx })); }
      catch (e) { trace({ kind: 'error', message: String(e && e.message) }); }
    }, everyMs(sched.every));
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
}

// The background flusher: retries come due on their own, not only when someone next causes a flush. It flushes every
// `intervalMs`, and a one-shot timer wakes it at the earliest `nextAttemptAt` still ahead. Both run on the injected
// clock, are unref'd, stop when the server closes, and are absent under `noTimers` — so `flusher` is null and only a request
// or the /outbox retry delivers. A flush that throws is traced; the next tick tries again. The same tick forgets
// the webhooks' dedup rows older than INBOUND_RETENTION_MS (longer than any provider retries), at most once an hour.
export const INBOUND_RETENTION_MS = 30 * 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 3600 * 1000;
export function startFlusher({ store, graph, server, trace, noTimers, clock = systemClock, intervalMs = 5000, ...flushOpts }) {
  if (noTimers) return null;
  let every = null, shot = null, stopped = false, busy = false, prunedAt = -Infinity;
  // Read first, then swap the timer: nothing is left unarmed while the store answers.
  const arm = async () => {
    const at = await store.outboxNextDue(clock.now());
    if (stopped) return;
    clock.clear(shot);
    shot = at === null ? null : clock.setTimer(tick, at - clock.now());
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await flush(store, graph, { ...flushOpts, trace, clock });
      if (clock.now() - prunedAt >= PRUNE_EVERY_MS) { prunedAt = clock.now(); await store.inboundPrune(prunedAt - INBOUND_RETENTION_MS); }
    }
    catch (e) { trace({ kind: 'error', message: String(e && e.message) }); }
    finally { busy = false; }
    if (!stopped) await arm();
  };
  const loop = () => { every = clock.setTimer(async () => { await tick(); if (!stopped) loop(); }, intervalMs); };
  const stop = () => { stopped = true; clock.clear(every); clock.clear(shot); };
  server.on('close', stop);
  loop();
  arm().catch((e) => trace({ kind: 'error', message: String(e && e.message) }));
  return { stop, arm };
}

// The request handler of a booted app: one request context per request, the route modules in order.
function requestHandler({ graph, store, perms, sess, interp, trace, registry, filesDir, fetchImpl, clock, env, graphFile }) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ctx = await createContext({ req, res, url, graph, store, perms, sess, interp, trace, registry, filesDir, fetchImpl, clock, env, graphFile });
    try {
      await dispatch(ctx);
    } catch (e) {
      if (e instanceof TooBig) { trace({ kind: 'refused', message: e.message }); ctx.send(413, noticePage(graph, ctx.vc, 'Too large', e.message)); return; }
      trace({ kind: 'error', message: String(e && e.message), stack: String(e && e.stack) });
      console.error(e && e.stack);
      ctx.send(500, errorPage(graph, String(e && e.message)));
    }
  };
}

// The scaffold's identity row and the declared seed rows. A seed row is checked against the graph's own rules
// exactly like any other write (Store#insert/#update's guard, runtime/store/rules.mjs): a violation is a boot
// error, not a crash, served the way a statically invalid graph is (item 20).
async function bootData(graph, store, graphFile, filesDir) {
  const meId = await bootstrapIdentity(graph, store);
  await bootstrapSeed(graph, store, path.dirname(graphFile), filesDir);
  return meId;
}

// `serve()` answers at once with `{ server, ready, ... }`; the server starts listening only after `ready`, i.e. after the
// store is migrated and the seed is in, so the first request finds a finished database. `ready` resolves to the app
// itself (`invalid` is then final: a seed or deploy-file error is served as the errors, on the same server).
export function serve({ graphFile, dbFile, traceFile, port, host = '127.0.0.1', filesDir = undefined, keyFile = undefined, fetchImpl = undefined, registry = DEFAULT, pluginErrors = [], noTimers = false, clock = systemClock }) {
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const errors = [...pluginErrors, ...validate(graph, registry)];
  if (errors.length) return invalidGraphServer(graph, errors, port, host);

  const dir = path.dirname(dbFile);
  filesDir = filesDir || path.join(dir, 'files');
  const trace = (event) => {
    if (!traceFile) return;
    fs.appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  };

  let handle = (_, res) => { res.writeHead(503); res.end(); }; // nothing listens before `ready`; the real handler replaces this
  const server = http.createServer((req, res) => handle(req, res));
  const app = { server, graph, store: null, perms: null, flusher: null, invalid: false, ready: null };
  const refuse = (list) => { handle = invalidHandler(graph, list); app.invalid = true; server.listen(port, host); return app; };

  app.ready = (async () => {
    const store = app.store = await Store.open(graph, dbFile, registry);
    store.migrations.forEach((m) => console.log(`migration: ${m}`));
    const perms = app.perms = permissions(graph, store);
    const sess = graph.roles ? sessions(keyFile || path.join(dir, 'session.key'), store) : null;
    let meId;
    try { meId = await bootData(graph, store, graphFile, filesDir); } catch (e) { return refuse([{ path: '/seed', message: e.message }]); }
    // The deploy file (each connector's mode) must be sound before anything is delivered.
    const env = connectorEnv(dir, graph.app);
    try { env.deploy(); } catch (e) { return refuse([{ path: '/deploy.json', message: e.message }]); }
    const interp = createInterpreter({ graph, store, registry, perms, meId, trace, fetchImpl, clock, env });
    handle = requestHandler({ graph, store, perms, sess, interp, trace, registry, filesDir, fetchImpl, clock, env, graphFile });
    startTimers(graph, interp, trace, server, noTimers);
    app.flusher = startFlusher({ store, graph, server, trace, noTimers, clock, registry, fetchImpl, env });
    server.listen(port, host);
    return app;
  })();
  return app;
}
