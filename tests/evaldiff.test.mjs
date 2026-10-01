// S3b's differential safety net: rules and step values evaluate over a prefetched snapshot, and the
// old lazy context stays reachable behind `store.lazyEval` (tests-only). For EVERY app under apps/ the
// same writes (generated over its graph: inserts, then updates of every row, most of them built to
// trip a rule) run against two identical stores, one per path, and must end the same way — accepted or
// refused, with the same error text, leaving the same stored rows. Then every step value the app's
// actions, events and transitions declare (`@path`, `= expr`, `{template}`) is resolved for rows of
// the entity it runs on through both contexts: same value, or same error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { createInterpreter } from '../runtime/interp.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { bootstrapIdentity, bootstrapSeed } from '../runtime/boot.mjs';
import { hashPassword } from '../runtime/auth.mjs';
import { freezeClock } from './helpers.mjs';

const NOW = '2026-09-29T12:00:00.000Z';
// A password is hashed by scrypt, on purpose slow: generated writes hand over a hash made once (it is stored as is).
const HASH = hashPassword('secret');
const apps = fs.readdirSync('apps').filter((d) => fs.existsSync(path.join('apps', d, 'app.json'))).sort();

// A value for field `f` of the `i`-th generated write: small, negative and oversized numbers, dates on both
// sides of "today", and references to rows that exist, are missing or are blank — to trip rules both ways.
function value(f, i, ids) {
  if (f.type.secret) return i % 6 === 2 ? '' : HASH;
  switch (f.kind) {
    case 'ref': return ids[f.target]?.length && i % 6 !== 5 ? ids[f.target][i % ids[f.target].length] : undefined;
    case 'enum': return f.options[i % f.options.length];
    case 'int': return [-1, 0, 1, 2, 7, 120][i % 6];
    case 'money': return [0, 1.25, 9.5, 400, -2, 15][i % 6];
    case 'bool': return i % 2 === 0;
    case 'date': return ['2020-01-01', '2026-09-29', '2027-06-15', '2026-01-10'][i % 4];
    case 'time': return ['2020-01-01T08:30:00.000Z', '2026-09-29T12:00:00.000Z', '2027-06-15T23:00:00.000Z'][i % 3];
    case 'file': case 'image': return undefined;
    default: return i % 7 === 3 ? '' : `${f.name} ${i % 4}`;
  }
}

const order = (store, graph) => {
  const out = [], seen = new Set();
  const visit = (e) => {
    if (seen.has(e)) return;
    seen.add(e);
    store.fields[e].filter((f) => f.kind === 'ref' && f.target !== e).forEach((f) => visit(f.target));
    out.push(e);
  };
  Object.keys(graph.data).forEach(visit);
  return out;
};

const attempt = (fn) => { try { return `ok ${JSON.stringify(fn())}`; } catch (e) { return `error ${e.message}`; } };

// The same writes against every store in `stores`; returns one outcome list per store.
function writeAll(stores, graph) {
  const outcomes = stores.map(() => []);
  const ids = {};
  for (const e of order(stores[0], graph)) {
    ids[e] = stores[0].list(e, {}).map((r) => r.id);
    const fields = stores[0].fields[e].filter((f) => !f.derive);
    const ruled = Boolean(graph.rules?.[e]?.length);
    for (let i = 0; i < (ruled ? 10 : 3); i++) {
      const row = Object.fromEntries(fields.map((f) => [f.name, value(f, i, ids)]));
      const got = stores.map((s) => attempt(() => s.insert(e, row)));
      got.forEach((g, k) => outcomes[k].push(`insert ${e}#${i}: ${g}`));
      if (got[0].startsWith('ok')) ids[e].push(JSON.parse(got[0].slice(3)));
    }
    for (const id of ruled ? ids[e].slice(0, 6) : []) {
      for (let j = 0; j < 2; j++) {
        const patch = Object.fromEntries(fields.filter((f, k) => (k + j) % 2 === 0).map((f) => [f.name, value(f, id * 3 + j, ids)]));
        stores.forEach((s, k) => outcomes[k].push(`update ${e}#${id}/${j}: ${attempt(() => s.update(e, id, patch))}`));
      }
    }
  }
  return outcomes;
}

const plain = (store, entity) => {
  const secret = new Set(store.fields[entity].filter((f) => f.type.secret).map((f) => f.name));
  return store.listRaw(entity).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !secret.has(k))));
};

// Every object with a `do` list, with the entity its steps run on.
function stepGroups(graph) {
  const groups = [];
  for (const a of graph.actions || []) groups.push({ entity: a.in, steps: [a.do, a.confirm] });
  // An inbound event (C4) has no row of its own: its steps run on the provider's payload, not on an entity.
  for (const ev of graph.events || []) if (ev.on) groups.push({ entity: ev.on.split('.')[0], steps: [ev.do] });
  for (const [entity, st] of Object.entries(graph.states || {})) for (const tr of st.transitions || []) groups.push({ entity, steps: [tr.do, tr.confirm] });
  return groups;
}
const leaves = (x, out = []) => {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((y) => leaves(y, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((y) => leaves(y, out));
  return out;
};

test('every app: rules and step values give the same answers over the snapshot and over the lazy context', async (t) => {
  t.after(freezeClock(NOW));
  const log = console.log; console.log = () => {};
  const stats = { writes: 0, refused: 0, byRule: 0, accepted: 0, values: 0 };
  try {
    for (const app of apps) {
      const dir = path.join('apps', app), graph = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
      const { registry } = await loadPlugins(graph, path.resolve(dir));
      const stores = [new Store(graph, ':memory:', registry), new Store(graph, ':memory:', registry)];
      stores[1].lazyEval = true;
      const secrets = (e) => stores[0].fields[e].filter((f) => f.type.secret).map((f) => f.name);
      const rehash = (e, row) => { for (const n of secrets(e)) if (row[n]) row[n] = HASH; };
      for (const [e, rows] of Object.entries(graph.seed || {})) rows.forEach((r) => rehash(e, r));
      if (graph.identity) rehash(graph.identity.entity, graph.identity.defaults || {});
      const meIds = stores.map((s) => { const id = bootstrapIdentity(graph, s); bootstrapSeed(graph, s, dir, null); return id; });
      const [a, b] = writeAll(stores, graph);
      assert.deepEqual(a, b, `${app}: a write ended differently`);
      const messages = new Set(Object.values(graph.rules || {}).flat().filter((r) => r.check).map((r) => `error ${r.message}`));
      stats.byRule += a.filter((o) => messages.has(o.slice(o.indexOf(': ') + 2))).length;
      stats.writes += a.length; stats.refused += a.filter((o) => o.includes(': error')).length; stats.accepted += a.filter((o) => o.includes(': ok')).length;
      for (const e of Object.keys(graph.data)) assert.deepEqual(plain(stores[0], e), plain(stores[1], e), `${app}/${e}: the stored rows differ`);
      // The same rules, asked of the same store both ways, before and after the writes.
      for (const [e, list] of Object.entries(graph.rules || {})) {
        if (!list.some((r) => r.check)) continue;
        for (const row of stores[0].listRaw(e).slice(0, 6)) {
          const ask = () => attempt(() => stores[0].checkRules(e, { ...row, id: undefined }, row));
          const snap = ask(); stores[0].lazyEval = true; const lazy = ask(); stores[0].lazyEval = false;
          assert.equal(snap, lazy, `${app}/${e}#${row.id}: checkRules differ`);
        }
      }
      const interps = stores.map((s, k) => createInterpreter({ graph, store: s, registry, perms: null, meId: meIds[k] }));
      for (const g of stepGroups(graph)) {
        const rows = g.entity && stores[0].fields[g.entity] ? stores[0].list(g.entity, {}).slice(0, 3) : [null];
        for (const row of rows) for (const s of leaves(g.steps)) {
          const one = (k) => {
            const ctx = { rowEntity: g.entity, id: row?.id, row, values: row || {}, user: null };
            const run = () => (s.startsWith('@') || s.startsWith('=') ? interps[k].resolve(ctx)(s) : interps[k].interpolate(s, ctx));
            return attempt(run);
          };
          assert.equal(one(0), one(1), `${app}/${g.entity}#${row?.id}: ${s} resolves differently`);
          stats.values++;
        }
      }
    }
  } finally { console.log = log; }
  assert.ok(stats.writes > 3000 && stats.refused > 300 && stats.byRule > 50 && stats.accepted > 1000, `the differential must have something to compare: ${JSON.stringify(stats)}`);
  assert.ok(stats.values > 500, `and step values too: ${JSON.stringify(stats)}`);
});
