// /api/*: the JSON routes of the scaffold under one prefix, for a frontend of its own. routes/context.mjs has already
// taken the prefix off `parts` and set `wantsJSON`, so a request this module lets through runs the very route its path
// names without the prefix (the same permission checks, own scoping, validation and effects); only the answer is always
// JSON. What this module adds is only what a prefix needs:
//   which routes are under it     an entity's list/read/create/edit/delete/action/go/add, /list, /dashboard, /search,
//                                 a global /action, /login, /register, /logout; anything else (a form page, a CSV, the
//                                 outbox, settings, files, widgets, webhooks, schedules) is a JSON 404
//   how a POST must arrive        from this site (Origin, else Referer, names the Host — the check /settings uses) and
//                                 as an application/json body of one flat object; else 403, 415, 400 or 413
//   GET /api/me                   who the session belongs to: { user, role }
//   GET /api/openapi.json         the contract (runtime/contract.mjs), after the sign-in gate like every other read
import { sameOrigin, BadBody, TooBig } from './context.mjs';
import { rowJSON } from '../render.mjs';
import { openapiText } from '../contract.mjs';

// Paths whose first part a route module claims before the entity routes: never read as an entity under /api.
const RESERVED = new Set(['page', 'outbox', 'file', 'widget', 'schedule', 'hook', 'settings', 'list', 'dashboard', 'action', 'search', 'login', 'register', 'logout', 'me', 'openapi.json']);
const ROW_POSTS = new Set(['action', 'go', 'add']);

// Is this method and path one of the routes /api serves?
function served(ctx) {
  const { parts, req, graph } = ctx;
  const n = parts.length, [a, b, c] = parts;
  const get = req.method === 'GET', post = req.method === 'POST';
  if (ctx.wantsCsv || !n) return false;
  if (a === 'openapi.json' || a === 'me') return get && n === 1;
  if (a === 'login' || a === 'logout') return post && n === 1 && Boolean(graph.roles);
  if (a === 'register') return post && n === 1 && Boolean(graph.roles?.register);
  if (a === 'list' || a === 'dashboard') return get && n === 2;
  if (a === 'search') return get && n === 1 && Boolean(graph.search);
  if (a === 'action') return post && n === 2;
  if (RESERVED.has(a) || !Object.keys(graph.data).some((e) => e.toLowerCase() === a.toLowerCase())) return false;
  if (n === 1) return get || post;
  if (n === 2) return post || (get && b !== 'new');
  if (n === 3) return post && c === 'delete';
  return n === 4 && post && ROW_POSTS.has(c);
}

const isJsonBody = (req) => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';

function fail(ctx, code, message) {
  if (code === 403) ctx.trace({ kind: 'denied', path: ctx.url.pathname, who: ctx.user?.id ?? null, role: ctx.role });
  ctx.sendJson(code, { ok: false, status: code, errors: [message] });
  return true;
}

// A POST is read here, once, before its route runs: a body that cannot be one is refused without touching anything.
async function admit(ctx) {
  const { req } = ctx;
  if (!sameOrigin(req)) return fail(ctx, 403, 'This request did not come from this site.');
  if (!isJsonBody(req)) return fail(ctx, 415, 'Send the body as application/json.');
  try { await ctx.body(); } catch (e) {
    const code = e instanceof BadBody ? 400 : e instanceof TooBig ? 413 : 0;
    if (!code) throw e; // a body the connection lost is the server's failure, a 500 like any other
    return fail(ctx, code, e.message);
  }
  return undefined;
}

/** Before the session routes and the sign-in gate: the /api refusals and "who am I"; undefined lets the request go on. */
export async function handle(ctx) {
  if (!ctx.api) return undefined;
  const { parts, req, store, graph } = ctx;
  if (!served(ctx)) return fail(ctx, 404, `no route ${req.method} ${ctx.url.pathname}`);
  if (req.method === 'POST') return await admit(ctx);
  if (parts[0] !== 'me') return undefined;
  const entity = graph.roles?.entity;
  ctx.sendJson(200, { user: ctx.user ? rowJSON(store, entity, store.fields[entity], ctx.user, ctx.vc) : null, role: ctx.role });
  return true;
}

// The document depends on the graph and the registry only: built once per app.
const documents = new WeakMap();

/** After the sign-in gate: GET /api/openapi.json, the same bytes `run.mjs --openapi` writes. */
export function contract(ctx) {
  if (!ctx.api || ctx.parts[0] !== 'openapi.json') return undefined;
  if (!documents.has(ctx.graph)) documents.set(ctx.graph, openapiText(ctx.graph, ctx.registry));
  ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...ctx.headers });
  ctx.res.end(documents.get(ctx.graph));
  return true;
}
