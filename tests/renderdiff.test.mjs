// S3c's differential safety net: every page a viewer can open is rendered from a seeded, populated
// store, and its HTML / JSON / CSV must hash to what the commit BEFORE S3c produced (tests/golden/
// render.json; `GOLDEN=write node --test tests/renderdiff.test.mjs` rewrites it, and is only for a
// deliberate change of the output). Per app: the guest (when the app has roles), the admin-like role
// and every role that owns rows, each asked for the list, detail, edit and new pages of every entity,
// the declared lists, dashboards, pages and search. Then the permission matrix (`can`, `ownOk`,
// `ownWhere`, `ownField`) of each of those viewers over every stored row is hashed the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boot, freezeClock, populate } from './helpers.mjs';

const GOLDEN = 'tests/golden/render.json';
const NOW = '2026-09-29T12:00:00.000Z';
const apps = fs.readdirSync('apps').filter((d) => fs.existsSync(path.join('apps', d, 'app.json'))).sort();
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 6);

// The viewers of an app: the anonymous one, the first role that may do everything (or the first role),
// and up to two more whose grants are scoped by `own`. Each gets a known password on an existing user.
function viewers(store, graph) {
  if (!graph.roles) return [{ name: 'open' }];
  const { entity, role, login, password, can } = graph.roles;
  const names = Object.keys(can);
  const admin = names.find((n) => can[n] === '*') || names[0];
  const owning = names.filter((n) => n !== admin && JSON.stringify(can[n]).includes('"own"')).slice(0, 2);
  const out = [{ name: 'guest' }];
  for (const n of new Set([admin, ...owning])) {
    const row = store.listRaw(entity).find((r) => String(r[role]) === n);
    if (!row) continue;
    store.update(entity, row.id, { [password]: 'pw' });
    out.push({ name: n, login: row[login], id: row.id });
  }
  return out;
}

function pathsOf(store, graph) {
  const out = ['/', '/search?q=a'];
  const first = Object.keys(graph.data)[0];
  for (const entity of Object.keys(graph.data)) {
    const ids = store.listRaw(entity).slice(0, 1).map((r) => r.id);
    out.push(`/${entity}`, `/${entity}/new`, ...ids.flatMap((id) => [`/${entity}/${id}`, `/${entity}/${id}/edit`]));
    if (entity === first) out.push(`/${entity}?q=a&sort=id&dir=desc`, `/${entity}.csv`);
  }
  for (const l of graph.lists || []) out.push(`/list/${l.id}`, `/list/${l.id}.csv`);
  for (const d of graph.dashboards || []) out.push(`/dashboard/${d.id}`, `/dashboard/${d.id}?from=2026-01-01&to=2026-12-31`, `/dashboard/${d.id}.csv`);
  for (const p of graph.pages || []) out.push(`/page/${p.id}`);
  return out;
}

async function render(s, graph, viewer, paths) {
  let cookie = '';
  if (viewer.login !== undefined) {
    const r = await fetch(`${s.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ login: viewer.login, password: 'pw' }).toString() });
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    await r.arrayBuffer();
  }
  const seen = [];
  const one = async (p, accept) => {
    const r = await fetch(s.base + p, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(accept ? { accept } : {}) } });
    const body = await r.text();
    assert.notEqual(r.status, 500, `${viewer.name} ${accept || ''} ${p}: ${body.slice(0, 200)}`);
    seen.push([`${accept ? 'json ' : ''}${p}`, digest(`${r.status} ${r.headers.get('location') || ''} ${body}`)]);
  };
  // JSON: the list-level answers, and the first detail of each entity.
  const details = new Set();
  for (const p of paths) {
    await one(p);
    const detail = /^\/(\w+)\/\d+$/.exec(p);
    const wantsJson = detail ? !details.has(detail[1]) && details.add(detail[1]) : /^\/(\w+|search\?q=a|list\/\w+|dashboard\/\w+)$/.test(p) && p !== '/';
    if (wantsJson && !p.endsWith('/new')) await one(p, 'application/json');
  }
  return seen;
}

// can / ownOk over every row of every entity for the viewer's user, ownWhere and ownField per entity.
function matrix(store, perms, graph, viewer) {
  const user = viewer.id === undefined ? null : store.get(graph.roles.entity, viewer.id);
  const out = [];
  for (const entity of Object.keys(graph.data)) {
    const rows = store.list(entity, {});
    perms.prime?.(user, entity, rows);
    out.push([entity, perms.ownField(user, entity), JSON.stringify(perms.ownWhere(user, entity)), JSON.stringify(perms.ownWhere(user, entity, 'edit'))]);
    for (const r of rows) {
      const ops = ['view', 'edit', 'delete', 'go:x', 'do:y'].map((op) => `${perms.can(user, entity, op, r) ? 1 : 0}${perms.ownOk(user, entity, r, op) ? 1 : 0}`);
      out.push([entity, r.id, ops.join('')]);
    }
  }
  return digest(JSON.stringify(out));
}

test('every app renders byte-identically to the output before S3c (HTML, JSON, CSV and permissions)', async (t) => {
  t.after(freezeClock(NOW));
  const log = console.log; console.log = () => {};
  const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
  const actual = {}, paths = {};
  let requests = 0;
  try {
    for (const app of apps) {
      const file = path.join('apps', app, 'app.json'), graph = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = await boot(file);
      try {
        const { store, perms } = s.app;
        populate(store, graph, 3);
        const list = pathsOf(store, graph);
        for (const v of viewers(store, graph)) {
          const seen = await render(s, graph, v, list);
          requests += seen.length;
          actual[`${app}|${v.name}`] = seen.map(([, d]) => d).join('');
          paths[`${app}|${v.name}`] = seen.map(([p]) => p);
          if (graph.roles) actual[`${app}|${v.name}|perms`] = matrix(store, perms, graph, v);
        }
      } finally { s.close(); }
    }
  } finally { console.log = log; }
  assert.ok(requests > 5000, `the differential must render something: ${requests} responses`);
  if (process.env.GOLDEN === 'write') { fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 0).replace(/,"/g, ',\n"')}\n`); return; }
  const bad = [];
  for (const key of new Set([...Object.keys(golden), ...Object.keys(actual)])) {
    if (golden[key] === actual[key]) continue;
    const [g, a] = [golden[key] || '', actual[key] || ''];
    const at = key.endsWith('|perms') ? [] : (paths[key] || []).filter((_, i) => g.slice(i * 6, i * 6 + 6) !== a.slice(i * 6, i * 6 + 6));
    bad.push(`${key}${at.length ? `: ${at.slice(0, 4).join(', ')}` : ''}`);
  }
  assert.deepEqual(bad, [], `output differs from the golden (tests/golden/render.json): ${bad.slice(0, 10).join(' | ')}`);
});
