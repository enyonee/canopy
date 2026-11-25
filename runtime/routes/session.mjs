// /login, /register, POST /logout — real sessions when /roles is declared. Under /api (POST /api/login, /api/register,
// /api/logout) the same steps answer JSON: the session cookie is set or cleared exactly as here, and where the form path
// redirects with a flash, the JSON answer is `{ ok: true, flash, user, role }` (the signed-in row as a JSON GET reads it).
import { verifyPassword } from '../auth.mjs';
import { rowJSON } from '../render.mjs';
import { loginView, registerView, registerFields } from '../render/pages.mjs';
import { registerPre } from './load.mjs';

// Where the form path redirects with a flash, /api answers the user it signed in (or out).
async function signedIn(ctx, id, to, flash) {
  if (!ctx.api) { ctx.ok(to, flash); return; }
  const entity = ctx.graph.roles.entity;
  const row = id === null ? null : await ctx.store.get(entity, id);
  ctx.sendJson(200, { ok: true, flash, user: row && rowJSON(ctx.store, entity, ctx.store.fields[entity], row), role: row ? ctx.perms.roleOf(row) : ctx.perms.roleOf(null) });
}

// A refusal: the form again with the message, or under /api the JSON error.
async function refused(ctx, code, problems, html) {
  if (ctx.api) ctx.sendJson(code, { ok: false, status: code, errors: problems });
  else ctx.send(code, await html());
}

export async function handle(ctx) {
  const { sess, graph, store, interp, trace } = ctx;
  if (!sess) return undefined;
  const { parts, req, send, headers, vc, safeNext } = ctx;

  if (parts[0] === 'login' && parts.length === 1) {
    if (req.method === 'GET') { send(200, loginView(graph, { next: ctx.url.searchParams.get('next') || '' }, vc)); return true; }
    const form = await ctx.body();
    const [found] = await store.list(graph.roles.entity, { where: { [graph.roles.login]: form.login || '' } });
    if (!found || !verifyPassword(form.password, found[graph.roles.password])) {
      trace({ kind: 'login', ok: false, login: form.login || '' });
      await refused(ctx, 401, ['Wrong login or password'], () => loginView(graph, { error: 'Wrong login or password', next: form.next || '', login: form.login || '' }, vc));
      return true;
    }
    headers['set-cookie'] = sess.setCookie(await sess.start(found.id));
    trace({ kind: 'login', ok: true, who: found.id });
    // A login event (row = the signed-in user) is a write, but — like a viewed
    // event — must never lock someone out of their own session if it breaks.
    if ((graph.events || []).some((ev) => ev.on === `${graph.roles.entity}.login`)) {
      try { await interp.attempt(async (tx) => await interp.fireEvents('login', graph.roles.entity, found.id, {}, found, found, 0, tx)); }
      catch (e) { trace({ kind: 'error', message: `login event: ${e.message}` }); }
    }
    await signedIn(ctx, found.id, safeNext(form.next), `Welcome, ${found[graph.roles.login]}`);
    return true;
  }

  if (parts[0] === 'logout' && req.method === 'POST') {
    await sess.end(req.headers.cookie);
    headers['set-cookie'] = sess.clearCookie();
    trace({ kind: 'logout', who: ctx.user?.id ?? null });
    await signedIn(ctx, null, '/', 'Signed out');
    return true;
  }

  if (parts[0] === 'register' && parts.length === 1 && graph.roles.register) {
    const entity = graph.roles.entity, fields = store.fields[entity];
    if (req.method === 'GET') { send(200, registerView(graph, store, fields, {}, [], vc, await registerPre(ctx, fields))); return true; }
    const submitted = ctx.submitted(entity, await ctx.body());
    interp.onlyWritable(entity, null, submitted, registerFields(graph, store));
    const values = { ...submitted, [graph.roles.role]: graph.roles.register };
    const problems = await interp.validateValues(entity, values);
    if (!problems.length && await store.exists(entity, graph.roles.login, values[graph.roles.login])) problems.push(`${graph.roles.login} is already registered`);
    if (problems.length) { trace({ kind: 'rejected', entity, problems }); await refused(ctx, 400, problems, async () => registerView(graph, store, fields, submitted, problems, vc, await registerPre(ctx, fields))); return true; }
    let id;
    try { id = await interp.attempt(async (tx) => { const n = await tx.insert(entity, values); await interp.fireEvents('created', entity, n, values, null, null, 0, tx); return n; }); }
    catch (e) { trace({ kind: 'refused', entity, message: e.message }); await refused(ctx, 400, [e.message], async () => registerView(graph, store, fields, submitted, [e.message], vc, await registerPre(ctx, fields))); return true; }
    headers['set-cookie'] = sess.setCookie(await sess.start(id));
    trace({ kind: 'register', who: id });
    await signedIn(ctx, id, '/', `Welcome, ${values[graph.roles.login]}`);
    return true;
  }

  return undefined;
}
