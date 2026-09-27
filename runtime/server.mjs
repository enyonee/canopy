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
  if (await session.handle(ctx)) return;
  if (ctx.perms.enabled && !ctx.role) { ctx.deny('Please sign in.'); return; }
  if (await views.handle(ctx)) return;
  if (await system.handle(ctx)) return;
  await entity.handle(ctx); // terminal: answers even when nothing else matches
}

export function serve({ graphFile, dbFile, traceFile, port, host = '127.0.0.1', filesDir = undefined, keyFile = undefined, fetchImpl = undefined, registry = DEFAULT, pluginErrors = [] }) {
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const errors = [...pluginErrors, ...validate(graph, registry)];
  if (errors.length) return invalidGraphServer(graph, errors, port, host);

  const dir = path.dirname(dbFile);
  filesDir = filesDir || path.join(dir, 'files');
  const store = new Store(graph, dbFile, registry);
  store.migrations.forEach((m) => console.log(`migration: ${m}`));
  const perms = permissions(graph);
  const sess = graph.roles ? sessions(keyFile || path.join(dir, 'session.key'), store) : null;

  const meId = bootstrapIdentity(graph, store);
  bootstrapSeed(graph, store);

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

  server.listen(port, host);
  return { server, graph, store, perms, invalid: false };
}
