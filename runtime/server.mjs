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
import { everyMs } from './schedule.mjs';

function invalidGraphServer(graph, errors, port, host) {
  console.error(`graph is invalid:\n${formatErrors(errors)}`);
  const server = http.createServer((_, res) => {
    res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
    res.end(errorPage(null, formatErrors(errors)));
  });
  server.listen(port, host);
  return { server, graph, invalid: true };
}

async function dispatch(ctx) {
  if (widgets.handle(ctx)) return;
  if (await session.handle(ctx)) return;
  if (ctx.perms.enabled && !ctx.role) { ctx.deny('Please sign in.'); return; }
  if (await views.handle(ctx)) return;
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
    const timer = setInterval(() => {
      trace({ kind: 'schedule', name: sched.name, manual: false });
      interp.attempt(() => interp.runSteps(sched.do, { rowEntity: null, id: null, values: {}, user: null }))
        .catch((e) => trace({ kind: 'error', message: String(e && e.message) }));
    }, everyMs(sched.every));
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
}

export function serve({ graphFile, dbFile, traceFile, port, host = '127.0.0.1', filesDir = undefined, keyFile = undefined, fetchImpl = undefined, registry = DEFAULT, pluginErrors = [], noTimers = false }) {
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const errors = [...pluginErrors, ...validate(graph, registry)];
  if (errors.length) return invalidGraphServer(graph, errors, port, host);

  const dir = path.dirname(dbFile);
  filesDir = filesDir || path.join(dir, 'files');
  const store = new Store(graph, dbFile, registry);
  store.migrations.forEach((m) => console.log(`migration: ${m}`));
  const perms = permissions(graph, store);
  const sess = graph.roles ? sessions(keyFile || path.join(dir, 'session.key'), store) : null;

  // A seed row is checked against the graph's own rules exactly like any other
  // write (Store#insert/#update's guard, runtime/store/rules.mjs) — a
  // violation is a boot error, not a crash: served the same way a statically
  // invalid graph is (item 20).
  let meId;
  try {
    meId = bootstrapIdentity(graph, store);
    bootstrapSeed(graph, store, path.dirname(graphFile), filesDir);
  } catch (e) {
    return invalidGraphServer(graph, [{ path: '/seed', message: e.message }], port, host);
  }

  const trace = (event) => {
    if (!traceFile) return;
    fs.appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  };
  const interp = createInterpreter({ graph, store, registry, perms, meId, trace, fetchImpl });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const ctx = createContext({ req, res, url, graph, store, perms, sess, interp, trace, registry, filesDir, fetchImpl });
    try {
      await dispatch(ctx);
    } catch (e) {
      if (e instanceof TooBig) { trace({ kind: 'refused', message: e.message }); ctx.send(413, noticePage(graph, ctx.vc, 'Too large', e.message)); return; }
      trace({ kind: 'error', message: String(e && e.message), stack: String(e && e.stack) });
      console.error(e && e.stack);
      ctx.send(500, errorPage(graph, String(e && e.message)));
    }
  });

  startTimers(graph, interp, trace, server, noTimers);
  server.listen(port, host);
  return { server, graph, store, perms, invalid: false };
}
