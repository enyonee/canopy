// The interpreter. Routes, screens and effects are derived from the graph;
// nothing here knows what a "task" or an "order" is. Every write runs in a
// transaction; every effect that leaves the process is an outbox row delivered
// after the commit; every read and write is checked against the role matrix.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { validate, formatErrors } from './validate.mjs';
import { CATALOG } from './blocks.mjs';
import { Store } from './store.mjs';
import { permissions, sessions, verifyPassword } from './auth.mjs';
import { flush } from './outbox.mjs';
import { parse as parseExpr, evaluate, isExpression, stripExpression } from './expr.mjs';
import { coerce, defaultValue, formatMoney } from './spec.mjs';
import { listView, formView, detailView, dashboardView, staticPage, errorPage, loginView, registerView,
  outboxView, forbiddenPage, noticePage, transitionsFor, label } from './render.mjs';

const readText = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(data));
});

export function serve({ graphFile, dbFile, traceFile, port, host = '127.0.0.1', filesDir, keyFile, fetchImpl }) {
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const errors = validate(graph);
  if (errors.length) {
    console.error(`graph ${graphFile} is invalid:\n${formatErrors(errors)}`);
    const server = http.createServer((_, res) => {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(errorPage(null, formatErrors(errors)));
    });
    server.listen(port, host);
    return { server, graph, invalid: true };
  }

  const dir = path.dirname(dbFile);
  filesDir = filesDir || path.join(dir, 'files');
  const store = new Store(graph, dbFile);
  store.migrations.forEach((m) => console.log(`migration: ${m}`));
  const perms = permissions(graph);
  const sess = graph.roles ? sessions(keyFile || path.join(dir, 'session.key')) : null;
  const exprCache = new Map();
  const compiled = (src) => { if (!exprCache.has(src)) exprCache.set(src, parseExpr(src)); return exprCache.get(src); };

  // Seed: declared starting rows, inserted once, only while the table is empty.
  for (const [entity, rows] of Object.entries(graph.seed || {})) {
    if (store.count(entity)) continue;
    for (const row of rows) store.insert(entity, row);
    console.log(`seed: ${rows.length} row(s) into ${entity}`);
  }

  // Identity: one declared row stands for the current user. No login in the scaffold.
  let meId = null;
  if (graph.identity) {
    const rows = store.list(graph.identity.entity, {});
    meId = rows.length ? rows[rows.length - 1].id : store.insert(graph.identity.entity, graph.identity.defaults || {});
  }

  const trace = (event) => {
    if (!traceFile) return;
    fs.appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  };

  // --- names inside steps: "@row.x", "@me", "@created", "= qty * price", "{row.title}" ------------
  const ROWS = { row: 'rowEntity', each: 'eachEntity', found: 'foundEntity', picked: 'pickedEntity' };
  const refValue = (ctx, pathParts) => {
    const [head, ...rest] = pathParts;
    if (head === 'me') return ctx.user ? ctx.user.id : meId;
    if (head === 'now') return new Date().toISOString();
    if (head === 'today') return new Date().toISOString().slice(0, 10);
    if (head === 'values') return ctx.values?.[rest[0]];
    if (ROWS[head]) {
      const obj = ctx[head];
      if (!obj) return null;
      if (!rest.length || rest[0] === 'id') return obj.id;
      return store.ctx(ctx[ROWS[head]], obj).get(rest);
    }
    return rest.length ? undefined : ctx[head];
  };
  const exprCtx = (ctx) => ({
    get(p) {
      const [head] = p;
      if (['me', 'now', 'today', 'values', 'created', 'delivery'].includes(head) || ROWS[head]) return refValue(ctx, p);
      if (ctx.row) return store.ctx(ctx.rowEntity, ctx.row).get(p);
      throw new Error(`unknown name "${head}" in expression`);
    },
    rows(child, via) {
      if (!ctx.row) throw new Error(`no current row to aggregate ${child} against`);
      return store.ctx(ctx.rowEntity, ctx.row).rows(child, via);
    },
  });
  const makeResolve = (ctx) => {
    const one = (v) => {
      if (typeof v === 'string') {
        if (v.startsWith('@')) return refValue(ctx, v.slice(1).split('.'));
        if (isExpression(v)) return evaluate(compiled(stripExpression(v)), exprCtx(ctx));
        return v;
      }
      if (Array.isArray(v)) return v.map(one);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)]));
      return v;
    };
    return one;
  };
  const interpolate = (text, ctx) => String(text).replace(/\{([^}]+)\}/g, (_, p) => {
    const parts = p.trim().split('.');
    const v = refValue(ctx, parts);
    if (v === undefined || v === null) return '';
    const f = ROWS[parts[0]] && ctx[ROWS[parts[0]]] ? store.fieldAt(ctx[ROWS[parts[0]]], parts.slice(1)) : null;
    if (f?.kind === 'money') return formatMoney(Math.round(v * 100));
    return typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v);
  });
  // "/Order/{order}" — a path may name fields of the row it lands on; {id} is the row id.
  const afterPath = (template, entity, id) => String(template).replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 'id') return String(id);
    const row = store.raw(entity, id);
    return row && row[k] !== undefined && row[k] !== null ? String(row[k]) : '';
  });
  // A block that refuses (not enough stock, empty table) is the application's answer, not a crash.
  class Refused extends Error {}
  const attempt = async (fn) => {
    try { return await withEffects(fn); }
    catch (e) { if (e instanceof Refused) throw e; const r = new Refused(e.message); r.cause = e; throw r; }
  };

  // --- steps run inside the caller's transaction; effects wait in the outbox -------------------
  const runSteps = (steps, ctx) => {
    if (ctx.rowEntity && ctx.id && !ctx.row) ctx.row = store.get(ctx.rowEntity, ctx.id);
    for (const [i, step] of steps.entries()) {
      const block = CATALOG[step.block];
      const out = block.run({
        store, graph, entity: ctx.rowEntity, id: ctx.id, values: ctx.values, step, user: ctx.user,
        resolve: makeResolve(ctx), text: (s) => interpolate(s, ctx),
        run: (sub, extra) => runSteps(sub, { ...ctx, ...extra }),
      });
      Object.assign(ctx, out);
      if (out.id) ctx.created = out.id;
      if (out.found) ctx.foundEntity = step.entity;
      if (out.picked) ctx.pickedEntity = step.from;
      if (ctx.rowEntity && ctx.id) ctx.row = store.get(ctx.rowEntity, ctx.id) || ctx.row;
      trace({ kind: 'step', i, block: step.block, effects: block.effects, entity: ctx.rowEntity, id: ctx.id,
        out: out.picked ? { picked: out.picked.id } : out.found ? { found: out.found.id } : out });
    }
    return ctx;
  };
  const withEffects = async (fn) => {
    const out = store.transaction(fn);
    await flush(store, graph, { fetchImpl, trace });
    return out;
  };
  const fireEvents = (trigger, entity, id, values, user, snapshot = null) => {
    for (const ev of graph.events || []) {
      if (ev.on !== `${entity}.${trigger}`) continue;
      trace({ kind: 'event', on: ev.on, entity, id });
      runSteps(ev.do, { rowEntity: entity, id, row: snapshot, values, user });
    }
  };

  // --- validation: types, rules, uniqueness ------------------------------------------------------
  const validateValues = (entity, values, { partial = false, existing = null } = {}) => {
    const problems = [];
    const fields = store.fields[entity];
    for (const f of fields) {
      if (f.derive) continue;
      const v = values[f.name];
      if (partial && v === undefined) continue;
      if (f.required && (v === undefined || String(v).trim() === '')) problems.push(`${f.name} is required`);
      if ((f.kind === 'int' || f.kind === 'money') && v !== undefined && v !== '' && Number.isNaN(Number(v))) problems.push(`${f.name} must be a number`);
      if (f.kind === 'enum' && v && !f.options.includes(String(v))) problems.push(`${f.name} must be one of: ${f.options.join(', ')}`);
      if (f.kind === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) problems.push(`${f.name} must be a date (YYYY-MM-DD)`);
    }
    if (problems.length) return problems;
    // Rules see the row as it would be stored: the existing row under the submitted values.
    const probe = { id: existing?.id ?? 0, ...(existing || {}) };
    const asStored = (f, v) => (v === '' || v === undefined ? defaultValue(f) : coerce(f, v));
    for (const f of fields) if (!f.derive && values[f.name] !== undefined) probe[f.name] = asStored(f, values[f.name]);
    for (const f of fields) if (!f.derive && probe[f.name] === undefined) probe[f.name] = asStored(f, values[f.name]);
    for (const rule of graph.rules?.[entity] || []) {
      if (rule.unique !== undefined) {
        const v = values[rule.unique];
        if (v !== undefined && v !== '' && store.exists(entity, rule.unique, v, existing?.id)) problems.push(rule.message || `${label(rule.unique)} is already taken`);
        continue;
      }
      let ok;
      try { ok = evaluate(compiled(rule.check), store.ctx(entity, probe)); }
      catch (e) { trace({ kind: 'error', message: `rule ${rule.check}: ${e.message}` }); ok = true; }
      if (!ok) problems.push(rule.message);
    }
    return problems;
  };
  const checkboxes = (entity, submitted) => {
    // An unchecked checkbox sends nothing. On a form submit that means false,
    // not "field absent, apply the declared default".
    for (const f of store.fields[entity]) if (f.kind === 'bool' && submitted[f.name] === undefined) submitted[f.name] = 'false';
    return submitted;
  };

  const parseBody = async (req) => {
    const ct = req.headers['content-type'] || '';
    if (ct.startsWith('multipart/form-data')) {
      const fd = await new Response(Readable.toWeb(req), { headers: { 'content-type': ct } }).formData();
      const out = {};
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') { out[k] = v; continue; }
        if (!v.size) continue;
        fs.mkdirSync(filesDir, { recursive: true });
        const name = `${Date.now()}-${String(v.name || 'file').replace(/[^\w.-]/g, '_')}`;
        fs.writeFileSync(path.join(filesDir, name), Buffer.from(await v.arrayBuffer()));
        out[k] = name;
      }
      return out;
    }
    return Object.fromEntries(new URLSearchParams(await readText(req)));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const flash = url.searchParams.get('ok') || '';
    const headers = {};
    const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
    const redirect = (to) => { res.writeHead(303, { location: to, ...headers }); res.end(); };
    const ok = (to, msg) => redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : to);

    // Who is asking.
    const user = sess ? store.get(graph.roles.entity, sess.read(req.headers.cookie)) : null;
    const role = perms.enabled ? perms.roleOf(user) : null;
    const vc = {
      user, role,
      can: (e, op, row) => perms.can(user, e, op, row),
      canSee: (item) => perms.canSee(user, item),
      ownField: (e) => perms.ownField(user, e),
      outbox: !perms.enabled || perms.isAdmin(user),
    };
    const deny = (message) => {
      trace({ kind: 'denied', path: url.pathname, who: user?.id ?? null, role });
      if (perms.enabled && !user && req.method === 'GET') return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
      return send(403, forbiddenPage(graph, vc, message));
    };
    const ownWhere = (entity) => { const own = perms.ownField(user, entity); return own ? { [own]: user ? user.id : -1 } : {}; };
    const resolveTop = makeResolve({ user, values: {} });

    try {
      // --- session ----------------------------------------------------------------------------
      if (sess && parts[0] === 'login' && parts.length === 1) {
        if (req.method === 'GET') return send(200, loginView(graph, { next: url.searchParams.get('next') || '' }, vc));
        const body = await parseBody(req);
        const [found] = store.list(graph.roles.entity, { where: { [graph.roles.login]: body.login || '' } });
        if (!found || !verifyPassword(body.password, found[graph.roles.password])) {
          trace({ kind: 'login', ok: false, login: body.login || '' });
          return send(401, loginView(graph, { error: 'Wrong login or password', next: body.next || '', login: body.login || '' }, vc));
        }
        headers['set-cookie'] = sess.setCookie(found.id);
        trace({ kind: 'login', ok: true, who: found.id });
        return ok(body.next && body.next.startsWith('/') ? body.next : '/', `Welcome, ${found[graph.roles.login]}`);
      }
      if (sess && parts[0] === 'logout' && req.method === 'POST') {
        headers['set-cookie'] = sess.clearCookie();
        trace({ kind: 'logout', who: user?.id ?? null });
        return ok('/', 'Signed out');
      }
      if (sess && parts[0] === 'register' && parts.length === 1 && graph.roles.register) {
        const entity = graph.roles.entity, fields = store.fields[entity];
        if (req.method === 'GET') return send(200, registerView(graph, store, fields, {}, [], vc));
        const submitted = checkboxes(entity, await parseBody(req));
        const values = { ...submitted, [graph.roles.role]: graph.roles.register };
        const problems = validateValues(entity, values);
        if (!problems.length && store.exists(entity, graph.roles.login, values[graph.roles.login])) problems.push(`${label(graph.roles.login)} is already registered`);
        if (problems.length) { trace({ kind: 'rejected', entity, problems }); return send(400, registerView(graph, store, fields, submitted, problems, vc)); }
        const id = await withEffects(() => { const n = store.insert(entity, values); fireEvents('created', entity, n, values, null); return n; });
        headers['set-cookie'] = sess.setCookie(id);
        trace({ kind: 'register', who: id });
        return ok('/', `Welcome, ${values[graph.roles.login]}`);
      }
      if (perms.enabled && !role) return deny('Please sign in.');

      // --- home, pages, dashboards, lists, outbox, files ------------------------------------------
      if (!parts.length) {
        const keep = (to) => (flash ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(flash)}` : to);
        if (graph.home) return redirect(keep(graph.home));
        const p = (graph.pages || []).find((x) => vc.canSee(x));
        if (p) return redirect(keep(`/page/${p.id}`));
        const e = Object.keys(graph.data).find((x) => vc.can(x, 'view') && !graph.override?.[`${x}.list`]?.hidden);
        if (e) return redirect(keep(`/${e}`));
        const d = (graph.dashboards || []).find((x) => vc.canSee(x));
        return d ? redirect(keep(`/dashboard/${d.id}`)) : deny('Nothing here for your role.');
      }
      if (parts[0] === 'page') {
        const p = (graph.pages || []).find((x) => x.id === parts[1]);
        if (!p) return send(404, errorPage(graph, `no page ${parts[1]}`));
        return vc.canSee(p) ? send(200, staticPage(graph, p, flash, vc)) : deny();
      }
      if (parts[0] === 'dashboard') {
        const d = (graph.dashboards || []).find((x) => x.id === parts[1]);
        if (!d) return send(404, errorPage(graph, `no dashboard ${parts[1]}`));
        if (!vc.canSee(d)) return deny();
        const period = { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' };
        trace({ kind: 'dashboard', id: d.id, period });
        const mine = { ...d, cards: (d.cards || []).map((c) => ({ ...c, where: resolveTop(c.where || {}) })),
          tables: (d.tables || []).map((t) => ({ ...t, where: resolveTop(t.where || {}) })) };
        return send(200, dashboardView(graph, store, mine, flash, vc, period));
      }
      if (parts[0] === 'list') {
        const l = (graph.lists || []).find((x) => x.id === parts[1]);
        if (!l) return send(404, errorPage(graph, `no list ${parts[1]}`));
        if (!vc.canSee(l) || !vc.can(l.entity, 'view')) return deny();
        const where = { ...resolveTop(l.where || {}), ...ownWhere(l.entity) };
        const rows = store.list(l.entity, { where, sort: l.sort, search: l.search || [], q: url.searchParams.get('q') || '' });
        const view = { ...(graph.override?.[`${l.entity}.list`] || {}), ...l, create: l.create ?? false };
        const g = { ...graph, override: { ...graph.override, [`${l.entity}.list`]: view } };
        return send(200, listView(g, store, l.entity, store.fields[l.entity], rows, { q: url.searchParams.get('q') || '', where: {}, flash, vc, path: `/list/${l.id}` }));
      }
      if (parts[0] === 'outbox') {
        if (!vc.outbox) return deny();
        if (parts[2] === 'retry' && req.method === 'POST') {
          const row = store.outboxGet(parts[1]);
          if (!row) return send(404, errorPage(graph, `no delivery #${parts[1]}`));
          store.outboxUpdate(row.id, { status: 'queued' });
          await flush(store, graph, { fetchImpl, trace });
          return ok('/outbox', `Delivery #${row.id} retried: ${store.outboxGet(row.id).status}`);
        }
        return send(200, outboxView(graph, store.outbox(), flash, vc));
      }
      if (parts[0] === 'file' && parts.length === 4) {
        const [, e, id, fieldName] = parts;
        const entity = Object.keys(graph.data).find((x) => x.toLowerCase() === e.toLowerCase());
        const row = entity && store.get(entity, id);
        const f = entity && store.field(entity, fieldName);
        if (!row || !f || f.kind !== 'file' || !row[fieldName]) return send(404, errorPage(graph, 'no such file'));
        if (!vc.can(entity, 'view', row)) return deny();
        const file = path.join(filesDir, path.basename(row[fieldName]));
        if (!fs.existsSync(file)) return send(404, errorPage(graph, 'file is missing on disk'));
        res.writeHead(200, { 'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${String(row[fieldName]).replace(/^\d+-/, '').replace(/"/g, '')}"` });
        return fs.createReadStream(file).pipe(res);
      }
      if (parts[0] === 'action' && req.method === 'POST') {
        const action = (graph.actions || []).find((a) => a.name === parts[1] && !a.in);
        if (!action) return send(404, errorPage(graph, `no global action ${parts[1]}`));
        if (action.by ? !action.by.includes(role) : perms.enabled && !vc.can('*', `do:${action.name}`)) return deny();
        const values = await parseBody(req);
        let ctx;
        try { ctx = await attempt(() => runSteps(action.do, { rowEntity: null, id: null, values, user })); }
        catch (e) { trace({ kind: 'refused', action: action.name, message: e.message }); return send(400, noticePage(graph, vc, 'Not done', e.message)); }
        return ok(action.after || '/', action.confirm ? interpolate(action.confirm, ctx) : '');
      }

      // --- entities -------------------------------------------------------------------------------
      const entity = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[0].toLowerCase());
      if (!entity) return send(404, errorPage(graph, `no entity at /${parts[0]}`));
      const fields = store.fields[entity];
      const ov = graph.override?.[`${entity}.list`] || {};
      const formOv = graph.override?.[`${entity}.form`] || {};

      if (req.method === 'GET' && parts.length === 1) {
        if (!vc.can(entity, 'view')) return deny();
        const where = { ...resolveTop(ov.where || {}), ...ownWhere(entity) };
        const range = {};
        for (const f of ov.filters || []) {
          if (f.range) {
            const from = url.searchParams.get(`${f.field}_from`) || '', to = url.searchParams.get(`${f.field}_to`) || '';
            range[`${f.field}_from`] = from; range[`${f.field}_to`] = to;
            const kind = store.field(entity, f.field).kind;
            if (from || to) where[f.field] = { gte: from ? (kind === 'time' ? `${from}T00:00:00` : from) : undefined, lte: to ? (kind === 'time' ? `${to}T23:59:59.999Z` : to) : undefined };
            continue;
          }
          const v = url.searchParams.get(f.field);
          if (v !== null && v !== '') where[f.field] = v;
        }
        const q = url.searchParams.get('q') || '';
        const rows = store.list(entity, { search: ov.search || [], q, where, sort: ov.sort });
        trace({ kind: 'query', entity, q, where, rows: rows.length, who: user?.id ?? null });
        return send(200, listView(graph, store, entity, fields, rows, { q, where, flash, vc, range }));
      }
      if (req.method === 'GET' && parts[1] === 'new') {
        return vc.can(entity, 'create') ? send(200, formView(graph, store, entity, fields, {}, 'new', [], vc)) : deny();
      }
      if (req.method === 'GET' && parts.length === 2) {
        const row = store.get(entity, parts[1]);
        if (!row) return send(404, errorPage(graph, `no ${entity} #${parts[1]}`));
        return vc.can(entity, 'view', row) ? send(200, detailView(graph, store, entity, fields, row, flash, vc)) : deny();
      }
      if (req.method === 'GET' && parts[2] === 'edit') {
        const row = store.get(entity, parts[1]);
        if (!row) return send(404, errorPage(graph, `no ${entity} #${parts[1]}`));
        return vc.can(entity, 'edit', row) ? send(200, formView(graph, store, entity, fields, row, 'edit', [], vc)) : deny();
      }
      if (req.method !== 'POST') return send(404, errorPage(graph, 'no route'));

      const submitted = await parseBody(req);
      if (parts.length === 1) {
        if (!vc.can(entity, 'create')) return deny();
        checkboxes(entity, submitted);
        const values = { ...submitted, ...resolveTop(formOv.fill || {}) };
        const own = perms.ownField(user, entity);
        if (own) values[own] = user.id;
        const problems = validateValues(entity, values);
        if (problems.length) {
          trace({ kind: 'rejected', entity, problems });
          return send(400, formView(graph, store, entity, fields, submitted, 'new', problems, vc));
        }
        const id = await withEffects(() => {
          const n = store.insert(entity, values);
          trace({ kind: 'create', entity, id: n, effects: ['db.write'], who: user?.id ?? null });
          fireEvents('created', entity, n, values, user);
          return n;
        });
        const after = afterPath(formOv.after || `/${entity}`, entity, id);
        return ok(after, formOv.confirm || `${label(entity)} saved successfully`);
      }
      const id = parts[1];
      const row = store.get(entity, id);
      if (!row) return send(404, errorPage(graph, `no ${entity} #${id}`));

      if (parts[2] === 'delete') {
        if (!vc.can(entity, 'delete', row)) return deny();
        await withEffects(() => {
          store.remove(entity, id);
          trace({ kind: 'delete', entity, id, effects: ['db.write'], who: user?.id ?? null });
          fireEvents('deleted', entity, id, {}, user, row);
        });
        return ok(`/${entity}`, `${label(entity)} deleted`);
      }
      if (parts[2] === 'action') {
        const action = graph.actions?.find((a) => a.name === parts[3]);
        if (!action) return send(404, errorPage(graph, `no action ${parts[3]}`));
        if (action.by ? !action.by.includes(role) : !vc.can(entity, `do:${action.name}`, row)) return deny();
        let ctx;
        try { ctx = await attempt(() => runSteps(action.do, { rowEntity: entity, id, row, values: submitted, user })); }
        catch (e) { trace({ kind: 'refused', entity, id, action: action.name, message: e.message }); return send(400, detailView(graph, store, entity, fields, row, e.message, vc)); }
        return ok(afterPath(action.after || `/${entity}`, entity, id), action.confirm ? interpolate(action.confirm, ctx) : '');
      }
      if (parts[2] === 'go') {
        const st = graph.states?.[entity];
        const t = st?.transitions.find((x) => x.name === parts[3]);
        if (!t) return send(404, errorPage(graph, `no transition ${parts[3]} on ${entity}`));
        if (!transitionsFor(graph, entity, row, vc).includes(t)) {
          if (!vc.can(entity, `go:${t.name}`, row) || (t.by && !t.by.includes(role))) return deny();
          return send(409, forbiddenPage(graph, vc, `${label(entity)} is ${row[st.field]}; "${t.title || label(t.name)}" is not available from here.`));
        }
        const values = {};
        for (const f of t.fields || []) if (submitted[f] !== undefined) values[f] = submitted[f];
        const problems = validateValues(entity, { ...values, [st.field]: t.to }, { partial: true, existing: row });
        for (const f of t.fields || []) if (values[f] === undefined || String(values[f]).trim() === '') problems.push(`${f} is required`);
        if (problems.length) return send(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc));
        let ctx;
        try {
          ctx = await attempt(() => {
            store.update(entity, id, { ...values, [st.field]: t.to });
            trace({ kind: 'transition', entity, id, name: t.name, from: row[st.field], to: t.to, who: user?.id ?? null });
            return runSteps(t.do || [], { rowEntity: entity, id, values: submitted, user });
          });
        } catch (e) { trace({ kind: 'refused', entity, id, transition: t.name, message: e.message }); return send(400, detailView(graph, store, entity, fields, row, e.message, vc)); }
        return ok(afterPath(t.after || `/${entity}/${id}`, entity, id), t.confirm ? interpolate(t.confirm, ctx) : `${label(entity)} is now ${t.to}`);
      }
      if (parts[2] === 'add') {
        const child = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[3].toLowerCase());
        const rel = (graph.override?.[`${entity}.detail`]?.related || []).find((r) => r.entity === child);
        if (!rel) return send(404, errorPage(graph, `no related ${parts[3]} on ${entity}`));
        if (!vc.can(entity, 'view', row) || !vc.can(child, 'create')) return deny();
        checkboxes(child, submitted);
        const values = { ...submitted, [rel.via]: id, ...resolveTop(rel.fill || {}) };
        const own = perms.ownField(user, child);
        if (own) values[own] = user.id;
        const problems = validateValues(child, values);
        if (problems.length) return send(400, detailView(graph, store, entity, fields, row, problems.join('; '), vc));
        await withEffects(() => {
          const kid = store.insert(child, values);
          trace({ kind: 'create', entity: child, id: kid, via: rel.via, effects: ['db.write'], who: user?.id ?? null });
          fireEvents('created', child, kid, values, user);
        });
        return ok(`/${entity}/${id}`, rel.confirm || `${label(child)} added successfully`);
      }
      if (parts.length === 2) {
        if (!vc.can(entity, 'edit', row)) return deny();
        checkboxes(entity, submitted);
        const own = perms.ownField(user, entity);
        if (own) delete submitted[own];
        const problems = validateValues(entity, submitted, { partial: true, existing: store.raw(entity, id) });
        if (problems.length) return send(400, formView(graph, store, entity, fields, { ...row, ...submitted }, 'edit', problems, vc));
        await withEffects(() => {
          store.update(entity, id, submitted);
          trace({ kind: 'update', entity, id, effects: ['db.write'], who: user?.id ?? null });
          fireEvents('updated', entity, id, submitted, user);
        });
        return ok(afterPath(formOv.afterEdit || `/${entity}`, entity, id), formOv.confirmEdit || `${label(entity)} updated successfully`);
      }
      return send(404, errorPage(graph, 'no route'));
    } catch (e) {
      trace({ kind: 'error', message: String(e && e.message) });
      return send(500, errorPage(graph, String(e && e.stack)));
    }
  });

  server.listen(port, host);
  return { server, graph, store, perms, invalid: false };
}

export { formatMoney };
