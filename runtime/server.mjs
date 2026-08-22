// The interpreter. Routes, screens and effects are derived from the graph;
// nothing here knows what a "task" or a "company" is.
import http from 'node:http';
import fs from 'node:fs';
import { validate, formatErrors } from './validate.mjs';
import { CATALOG } from './blocks.mjs';
import { Store } from './store.mjs';
import { listView, formView, detailView, dashboardView, staticPage, errorPage } from './render.mjs';

const parseBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => { data += c; });
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
});

export function serve({ graphFile, dbFile, traceFile, port, host = '127.0.0.1' }) {
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

  const store = new Store(graph, dbFile);
  store.migrations.forEach((m) => console.log(`migration: ${m}`));

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

  // "@me", "@now", "@field", "@picked.title" — the only interpolation the format has.
  const makeResolve = (ctx) => {
    const one = (v) => {
      if (typeof v !== 'string' || !v.startsWith('@')) return v;
      const path = v.slice(1);
      if (path === 'me') return meId;
      if (path === 'now') return new Date().toISOString();
      return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), ctx);
    };
    return (obj) => (obj && typeof obj === 'object' && !Array.isArray(obj)
      ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, one(v)])) : one(obj));
  };
  const interpolate = (text, ctx) => String(text || '').replace(/\{([^}]+)\}/g,
    (_, p) => String(p.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), ctx) ?? ''));

  const validateValues = (entity, values, partial = false) => {
    const problems = [];
    for (const f of store.fields[entity]) {
      const v = values[f.name];
      if (partial && v === undefined) continue;
      if (f.required && (v === undefined || String(v).trim() === '')) problems.push(`${f.name} is required`);
      if (f.kind === 'int' && v !== undefined && v !== '' && Number.isNaN(Number(v))) problems.push(`${f.name} must be a number`);
      if (f.kind === 'enum' && v && !f.options.includes(String(v))) problems.push(`${f.name} must be one of: ${f.options.join(', ')}`);
    }
    return problems;
  };

  const runSteps = (steps, { entity, id, values }) => {
    const ctx = { values, row: id ? store.get(entity, id) : null };
    for (const [i, step] of steps.entries()) {
      const block = CATALOG[step.block];
      const out = block.run({ store, graph, entity, id, values, step, resolve: makeResolve(ctx) });
      Object.assign(ctx, out);
      if (out.id) ctx.created = out.id;
      trace({ kind: 'step', i, block: step.block, effects: block.effects, entity, id, out: out.picked ? { picked: out.picked.id } : out });
    }
    return ctx;
  };

  const fireEvents = (entity, id, values) => {
    for (const ev of graph.events || []) {
      if (ev.on !== `${entity}.created`) continue;
      trace({ kind: 'event', on: ev.on, entity, id });
      runSteps(ev.do, { entity, id, values });
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const flash = url.searchParams.get('ok') || '';
    const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };
    const redirect = (to) => { res.writeHead(303, { location: to }); res.end(); };
    const ok = (to, msg) => redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : to);

    try {
      if (!parts.length) {
        const home = graph.home || (graph.pages?.[0] ? `/page/${graph.pages[0].id}` : `/${Object.keys(graph.data)[0]}`);
        return redirect(home);
      }
      if (parts[0] === 'page') {
        const p = (graph.pages || []).find((x) => x.id === parts[1]);
        return p ? send(200, staticPage(graph, p, flash)) : send(404, errorPage(graph, `no page ${parts[1]}`));
      }
      if (parts[0] === 'dashboard') {
        const d = (graph.dashboards || []).find((x) => x.id === parts[1]);
        return d ? send(200, dashboardView(graph, store, d, flash)) : send(404, errorPage(graph, `no dashboard ${parts[1]}`));
      }
      if (parts[0] === 'list') {
        const l = (graph.lists || []).find((x) => x.id === parts[1]);
        if (!l) return send(404, errorPage(graph, `no list ${parts[1]}`));
        const where = makeResolve({})(l.where || {});
        const rows = store.list(l.entity, { where, sort: l.sort, search: l.search || [], q: url.searchParams.get('q') || '' });
        const view = { ...(graph.override?.[`${l.entity}.list`] || {}), ...l, create: l.create ?? false };
        const g = { ...graph, override: { ...graph.override, [`${l.entity}.list`]: view } };
        return send(200, listView(g, store, l.entity, store.fields[l.entity], rows, { q: '', where: {}, flash }));
      }
      if (parts[0] === 'action' && req.method === 'POST') {
        const action = (graph.actions || []).find((a) => a.name === parts[1] && !a.in);
        if (!action) return send(404, errorPage(graph, `no global action ${parts[1]}`));
        const values = await parseBody(req);
        const ctx = runSteps(action.do, { entity: null, id: null, values });
        return ok(action.after || '/', action.confirm ? interpolate(action.confirm, ctx) : '');
      }

      const entity = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[0].toLowerCase());
      if (!entity) return send(404, errorPage(graph, `no entity at /${parts[0]}`));
      const fields = store.fields[entity];
      const ov = graph.override?.[`${entity}.list`] || {};
      const formOv = graph.override?.[`${entity}.form`] || {};

      if (req.method === 'GET' && parts.length === 1) {
        const where = {};
        for (const f of ov.filters || []) {
          const v = url.searchParams.get(f.field);
          if (v !== null && v !== '') where[f.field] = v;
        }
        const q = url.searchParams.get('q') || '';
        const rows = store.list(entity, { search: ov.search || [], q, where, sort: ov.sort });
        trace({ kind: 'query', entity, q, where, rows: rows.length });
        return send(200, listView(graph, store, entity, fields, rows, { q, where, flash }));
      }
      if (req.method === 'GET' && parts[1] === 'new') return send(200, formView(graph, store, entity, fields, {}, 'new'));
      if (req.method === 'GET' && parts.length === 2) {
        const row = store.get(entity, parts[1]);
        return row ? send(200, detailView(graph, store, entity, fields, row, flash))
          : send(404, errorPage(graph, `no ${entity} #${parts[1]}`));
      }
      if (req.method === 'GET' && parts[2] === 'edit') {
        const row = store.get(entity, parts[1]);
        return row ? send(200, formView(graph, store, entity, fields, row, 'edit'))
          : send(404, errorPage(graph, `no ${entity} #${parts[1]}`));
      }

      if (req.method === 'POST') {
        const submitted = await parseBody(req);
        if (parts.length === 1) {
          // An unchecked checkbox sends nothing. On a form submit that means false,
          // not "field absent, apply the declared default".
          for (const f of fields) if (f.kind === 'bool' && submitted[f.name] === undefined) submitted[f.name] = 'false';
          const values = { ...submitted, ...makeResolve({})(formOv.fill || {}) };
          const problems = validateValues(entity, values);
          if (problems.length) {
            trace({ kind: 'rejected', entity, problems });
            return send(400, formView(graph, store, entity, fields, submitted, 'new', problems));
          }
          const id = store.insert(entity, values);
          trace({ kind: 'create', entity, id, effects: ['db.write'] });
          fireEvents(entity, id, values);
          return ok(formOv.after || `/${entity}`, formOv.confirm || `${entity} saved successfully`);
        }
        const id = parts[1];
        if (parts[2] === 'delete') {
          store.remove(entity, id);
          trace({ kind: 'delete', entity, id, effects: ['db.write'] });
          return ok(`/${entity}`, `${entity} deleted`);
        }
        if (parts[2] === 'action') {
          const action = (graph.actions || []).find((a) => a.name === parts[3]);
          if (!action) return send(404, errorPage(graph, `no action ${parts[3]}`));
          const ctx = runSteps(action.do, { entity, id, values: submitted });
          return ok(action.after || `/${entity}`, action.confirm ? interpolate(action.confirm, ctx) : '');
        }
        if (parts[2] === 'add') {
          const child = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[3].toLowerCase());
          const rel = (graph.override?.[`${entity}.detail`]?.related || []).find((r) => r.entity === child);
          if (!rel) return send(404, errorPage(graph, `no related ${parts[3]} on ${entity}`));
          for (const f of store.fields[child]) if (f.kind === 'bool' && submitted[f.name] === undefined) submitted[f.name] = 'false';
          const values = { ...submitted, [rel.via]: id, ...makeResolve({})(rel.fill || {}) };
          const problems = validateValues(child, values);
          if (problems.length) return send(400, detailView(graph, store, entity, fields, store.get(entity, id), problems.join('; ')));
          const kid = store.insert(child, values);
          trace({ kind: 'create', entity: child, id: kid, via: rel.via, effects: ['db.write'] });
          fireEvents(child, kid, values);
          return ok(`/${entity}/${id}`, rel.confirm || `${child} added successfully`);
        }
        for (const f of fields) if (f.kind === 'bool' && submitted[f.name] === undefined) submitted[f.name] = 'false';
        const problems = validateValues(entity, submitted, true);
        if (problems.length) return send(400, formView(graph, store, entity, fields, submitted, 'edit', problems));
        store.update(entity, id, submitted);
        trace({ kind: 'update', entity, id, effects: ['db.write'] });
        return ok(formOv.afterEdit || `/${entity}`, `${entity} updated successfully`);
      }
      return send(404, errorPage(graph, 'no route'));
    } catch (e) {
      trace({ kind: 'error', message: String(e && e.message) });
      return send(500, errorPage(graph, String(e && e.stack)));
    }
  });

  server.listen(port, host);
  return { server, graph, store, invalid: false };
}
