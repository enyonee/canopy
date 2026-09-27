// /login, /register, POST /logout — real sessions when /roles is declared.
import { verifyPassword } from '../auth.mjs';
import { loginView, registerView } from '../render/pages.mjs';

export async function handle(ctx) {
  const { sess, graph, store, interp, trace } = ctx;
  if (!sess) return undefined;
  const { parts, req, send, ok, headers, vc, safeNext } = ctx;

  if (parts[0] === 'login' && parts.length === 1) {
    if (req.method === 'GET') { send(200, loginView(graph, { next: ctx.url.searchParams.get('next') || '' }, vc)); return true; }
    const form = await ctx.body();
    const [found] = store.list(graph.roles.entity, { where: { [graph.roles.login]: form.login || '' } });
    if (!found || !verifyPassword(form.password, found[graph.roles.password])) {
      trace({ kind: 'login', ok: false, login: form.login || '' });
      send(401, loginView(graph, { error: 'Wrong login or password', next: form.next || '', login: form.login || '' }, vc));
      return true;
    }
    headers['set-cookie'] = sess.setCookie(sess.start(found.id));
    trace({ kind: 'login', ok: true, who: found.id });
    ok(safeNext(form.next), `Welcome, ${found[graph.roles.login]}`);
    return true;
  }

  if (parts[0] === 'logout' && req.method === 'POST') {
    sess.end(req.headers.cookie);
    headers['set-cookie'] = sess.clearCookie();
    trace({ kind: 'logout', who: ctx.user?.id ?? null });
    ok('/', 'Signed out');
    return true;
  }

  if (parts[0] === 'register' && parts.length === 1 && graph.roles.register) {
    const entity = graph.roles.entity, fields = store.fields[entity];
    if (req.method === 'GET') { send(200, registerView(graph, store, fields, {}, [], vc)); return true; }
    const submitted = interp.checkboxes(entity, await ctx.body());
    delete submitted[graph.roles.role];
    const values = { ...submitted, [graph.roles.role]: graph.roles.register };
    const problems = interp.validateValues(entity, values);
    if (!problems.length && store.exists(entity, graph.roles.login, values[graph.roles.login])) problems.push(`${graph.roles.login} is already registered`);
    if (problems.length) { trace({ kind: 'rejected', entity, problems }); send(400, registerView(graph, store, fields, submitted, problems, vc)); return true; }
    let id;
    try { id = await interp.attempt(() => { const n = store.insert(entity, values); interp.fireEvents('created', entity, n, values, null); return n; }); }
    catch (e) { trace({ kind: 'refused', entity, message: e.message }); send(400, registerView(graph, store, fields, submitted, [e.message], vc)); return true; }
    headers['set-cookie'] = sess.setCookie(sess.start(id));
    trace({ kind: 'register', who: id });
    ok('/', `Welcome, ${values[graph.roles.login]}`);
    return true;
  }

  return undefined;
}
