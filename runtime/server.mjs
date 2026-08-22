// The interpreter. Routes, screens and effects are derived from the graph;
// nothing here knows what a "task" is.
import http from 'node:http';
import fs from 'node:fs';
import { validate, formatErrors } from './validate.mjs';
import { CATALOG } from './blocks.mjs';
import { Store } from './store.mjs';
import { listView, formView, detailView, errorPage } from './render.mjs';

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

  const trace = (event) => {
    if (!traceFile) return;
    fs.appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  };

  const runAction = (action, entity, id, values) => {
    for (const [i, step] of action.do.entries()) {
      const block = CATALOG[step.block];
      const out = block.run({ store, entity, id, values, step });
      trace({ kind: 'step', action: action.name, i, block: step.block, effects: block.effects, entity, id, out });
      if (out.id) id = out.id;
    }
    return id;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const send = (code, html) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const redirect = (to) => { res.writeHead(303, { location: to }); res.end(); };

    try {
      if (!parts.length) return redirect(`/${Object.keys(graph.data)[0]}`);
      const entity = Object.keys(graph.data).find((e) => e.toLowerCase() === parts[0].toLowerCase());
      if (!entity) return send(404, errorPage(graph, `no entity at /${parts[0]}`));
      const fields = store.fields[entity];
      const ov = graph.override?.[`${entity}.list`] || {};

      // GET /Entity — list with structured filters and declared search fields
      if (req.method === 'GET' && parts.length === 1) {
        const where = {};
        for (const f of ov.filters || []) {
          const v = url.searchParams.get(f.field);
          if (v !== null && v !== '') where[f.field] = v;
        }
        const q = url.searchParams.get('q') || '';
        const rows = store.list(entity, { search: ov.search || [], q, where });
        trace({ kind: 'query', entity, q, where, rows: rows.length });
        return send(200, listView(graph, entity, fields, rows, { q, where }));
      }
      if (req.method === 'GET' && parts[1] === 'new') return send(200, formView(graph, entity, fields, {}, 'new'));
      if (req.method === 'GET' && parts.length === 2) {
        const row = store.get(entity, parts[1]);
        if (!row) return send(404, errorPage(graph, `no ${entity} #${parts[1]}`));
        return send(200, detailView(graph, entity, fields, row));
      }
      if (req.method === 'GET' && parts[2] === 'edit') {
        const row = store.get(entity, parts[1]);
        if (!row) return send(404, errorPage(graph, `no ${entity} #${parts[1]}`));
        return send(200, formView(graph, entity, fields, row, 'edit'));
      }

      if (req.method === 'POST') {
        const values = await parseBody(req);
        if (parts.length === 1) {
          const id = store.insert(entity, values);
          trace({ kind: 'create', entity, id, effects: ['db.write'] });
          return redirect(`/${entity}`);
        }
        const id = parts[1];
        if (parts[2] === 'delete') {
          store.remove(entity, id);
          trace({ kind: 'delete', entity, id, effects: ['db.write'] });
          return redirect(`/${entity}`);
        }
        if (parts[2] === 'action') {
          const action = (graph.actions || []).find((a) => a.name === parts[3]);
          if (!action) return send(404, errorPage(graph, `no action ${parts[3]}`));
          runAction(action, entity, id, values);
          return redirect(url.searchParams.get('back') || `/${entity}`);
        }
        for (const f of fields) if (f.kind === 'bool' && values[f.name] === undefined) values[f.name] = 'false';
        store.update(entity, id, values);
        trace({ kind: 'update', entity, id, effects: ['db.write'] });
        return redirect(`/${entity}`);
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
