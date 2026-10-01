// The registry and plugins: a plugin's field kind, function, block and transport
// are treated exactly like the built-ins by the checker, the store, the renderer,
// the interpreter and the outbox — and a plugin that misbehaves is a checker error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRegistry, register, loadPlugins, DEFAULT, TABLES } from '../runtime/registry.mjs';
import { validate } from '../runtime/validate.mjs';
import { Store } from '../runtime/store.mjs';
import { deliver } from '../runtime/outbox.mjs';
import { boot, rows, tmpGraph, fakeFetch, tmpDir } from './helpers.mjs';

const dir = tmpDir('ag-plug-');
const writePlugin = (name, source) => { const f = path.join(dir, name); fs.writeFileSync(f, source); return f; };

const loyalty = writePlugin('loyalty.mjs', `export default {
  async: true,
  fields: { percent: { sql: 'INTEGER', exprKind: 'number', numeric: true, derivable: true,
    def: (f) => Number(f.def), coerce: (raw) => (raw === '' || raw == null ? null : Math.round(Number(raw))),
    validate: (v, f) => (v !== undefined && v !== '' && (Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100) ? f.name + ' must be between 0 and 100' : null),
    fromExpr: (v) => (v == null ? null : Math.round(v)),
    format: (v, f, { esc }) => (v == null ? '' : esc(v + ' %')),
    input: (f, v, { esc }) => '<input type="number" min="0" max="100" id="f_' + f.name + '" name="' + f.name + '" value="' + esc(v) + '">' } },
  functions: { discount: { arity: 2, kind: (ks) => { if (ks[0] !== 'money' && ks[0] !== 'any') throw new Error('discount() needs money first, got ' + ks[0]); return 'money'; },
    run: ([a, p]) => (a == null ? null : Math.round(a * (100 - (p || 0))) / 100) } },
  blocks: { 'loyalty.award': { summary: 'add points', effects: ['db.write'], requires: ['entity', 'id', 'field', 'amount'],
    check: (step, h) => { const f = h.fields[step.entity]?.[step.field]; if (f && !f.type.numeric) h.err(h.path + '/field', 'loyalty.award needs a numeric field'); },
    run: async ({ store, step, resolve }) => { const id = (await resolve({ v: step.id })).v; const row = await store.get(step.entity, id); if (!row) throw new Error('loyalty.award: no row #' + id);
      const points = Math.floor(Number((await resolve({ v: step.amount })).v) || 0); await store.update(step.entity, id, { [step.field]: (row[step.field] || 0) + points }); return { points }; } } },
  transports: { log: { summary: 'a line in a file', validate: (c) => (c.file ? [] : [['file', 'a log connector needs "file"']]),
    deliver: async (row, c) => { (await import('node:fs')).appendFileSync(c.file, JSON.stringify(row.payload) + '\\n'); return { status: 'sent', code: null, error: null }; } } },
};`);

test('the registry starts with the built-ins and refuses a second registration of a name', () => {
  const r = createRegistry();
  // Every table but widgets ships built-ins; no core widget exists (see runtime/widgets.mjs) —
  // an app registers its own through a plugin, same table, same conflict rule.
  for (const t of TABLES) if (t !== 'widgets') assert.ok(Object.keys(r[t]).length, `${t} is not empty`);
  assert.deepEqual(r.widgets, {});
  assert.equal(r.plugins.length, 0);
  assert.equal(DEFAULT.fields.money.sql, 'INTEGER');
  register(r, { fields: { percent: { sql: 'INTEGER' } } }, 'p1');
  assert.equal(r.fields.percent.plugin, 'p1');
  assert.deepEqual(r.plugins, ['p1']);
  assert.throws(() => register(r, { fields: { percent: {} } }, 'p2'), /p2: fields "percent" is already registered by p1/);
  assert.throws(() => register(r, { fields: { money: {} } }, 'p3'), /p3: fields "money" is already registered$/);
  assert.throws(() => register(r, { functions: { if: {} } }), /plugin: functions "if" is already registered/);
  assert.throws(() => register(r, null, 'p4'), /p4: a plugin exports an object/);
  assert.throws(() => register(r, { nothing: 1 }, 'p5'), /p5: nothing to register/);
  assert.throws(() => register(r, { blocks: { x: 5 } }, 'p6'), /p6: blocks "x" must be an object/);
  assert.equal(DEFAULT.fields.percent, undefined, 'the default registry is untouched');
});

test('loadPlugins imports the modules a graph names and reports what it cannot load as checker errors', async () => {
  const ok = await loadPlugins({ plugins: [loyalty] }, dir);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.registry.plugins.length, 1);
  assert.ok(ok.registry.fields.percent && ok.registry.functions.discount && ok.registry.blocks['loyalty.award'] && ok.registry.transports.log);
  const none = await loadPlugins({}, dir);
  assert.equal(none.registry.plugins.length, 0);
  const bad = await loadPlugins({ plugins: ['./missing.mjs', 42, loyalty, loyalty] }, dir);
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors[0].message, /cannot load plugin "\.\/missing\.mjs"/);
  assert.equal(bad.errors[1].path, '/plugins/1'); assert.match(bad.errors[1].message, /a plugin is a path/);
  assert.match(bad.errors[2].message, /already registered/);
  const broken = writePlugin('broken.mjs', 'export default { blocks: { "x.y": 5 } };');
  const b = await loadPlugins({ plugins: [broken] }, dir);
  assert.match(b.errors[0].message, /must be an object/);
});

const graph = {
  app: 'plug', plugins: [loyalty],
  data: { User: { name: 'text!', tier: 'percent=10', points: 'int=0' }, Order: { customer: 'ref:User!', total: 'money=0', net: 'money := discount(total, customer.tier)', big: 'bool := net > 50' } },
  seed: { User: [{ name: 'Ann', tier: 25 }] },
  connectors: { audit: { kind: 'log', file: path.join(dir, 'audit.log') } },
  actions: [{ name: 'award', in: 'Order', after: '/Order/{id}', confirm: 'awarded {points}', do: [
    { block: 'loyalty.award', entity: 'User', id: '@row.customer', field: 'points', amount: '= net' },
    { block: 'connector.send', connector: 'audit', body: { order: '@row.id' } } ] }],
  override: { 'Order.list': { columns: ['customer', 'total', 'net', 'big'], filters: [{ field: 'total', range: true }], rowActions: ['award'] }, 'User.list': { columns: ['name', 'tier', 'points'], filters: [{ field: 'tier', range: true }] } },
};

test('the checker sees a plugin kind, function, block and transport as its own — and their contracts', async () => {
  const { registry } = await loadPlugins(graph, dir);
  assert.deepEqual(validate(graph, registry), []);
  assert.match(validate(graph).find((e) => e.path === '/data/User/tier').message, /unknown type "percent"/, 'without the plugin the kind is unknown');
  const at = (g, p) => validate(g, registry).find((e) => e.path === p) || {};
  assert.match(at({ ...graph, data: { ...graph.data, Order: { ...graph.data.Order, net: 'money := discount(customer.name, 1)' } } }, '/data/Order/net').message, /discount\(\) needs money first, got text/);
  assert.match(at({ ...graph, data: { ...graph.data, Order: { ...graph.data.Order, net: 'money := discount(total)' } } }, '/data/Order/net').message, /discount\(\) takes 2 argument/);
  assert.match(at({ ...graph, actions: [{ name: 'a', in: 'Order', do: [{ block: 'loyalty.award', entity: 'User', id: '@row.customer', field: 'name', amount: 1 }] }] }, '/actions/0/do/0/field').message, /needs a numeric field/);
  assert.match(at({ ...graph, actions: [{ name: 'a', in: 'Order', do: [{ block: 'loyalty.award', entity: 'User', id: '@row.customer' }] }] }, '/actions/0/do/0').message, /requires "field"/);
  assert.match(at({ ...graph, connectors: { audit: { kind: 'log' } } }, '/connectors/audit/file').message, /a log connector needs "file"/);
  assert.match(at({ ...graph, connectors: { audit: { kind: 'fax' } } }, '/connectors/audit/kind').hint, /kinds: http, mail, log/);
  assert.match(at({ ...graph, plugins: 'x' }, '/plugins').message, /plugins is a list/);
  assert.equal(at({ ...graph, override: { 'User.list': { filters: [{ field: 'tier', range: true }] } } }, '/override/User.list/filters/0').message, undefined, 'a numeric plugin kind takes a range filter');
});

test('the store, the interpreter, the renderer and the outbox use the plugin at run time', async () => {
  const s = await boot(tmpGraph(graph), {});
  try {
    const list = await s.get('/User');
    assert.match(list.html, /<td>25 %<\/td>/, 'the plugin formats its kind');
    const form = await s.get('/User/new');
    assert.match(form.html, /min="0" max="100"/, 'and renders its input');
    assert.equal((await s.post('/User', { name: 'Bob', tier: '150' })).status, 400, 'and validates it');
    assert.match((await s.post('/User', { name: 'Bob', tier: '150' })).html, /tier must be between 0 and 100/);
    assert.equal((await s.post('/User', { name: 'Bob', tier: '7.6' })).status, 303);
    assert.equal((await s.app.store.get('User', 2)).tier, 8, 'coerced by the plugin');
    const created = await s.post('/Order', { customer: 1, total: '80' });
    assert.equal(created.status, 303);
    const orders = await s.get('/Order');
    assert.match(orders.html, /<td>80\.00<\/td><td>60\.00<\/td><td>Yes<\/td>/, 'the plugin function computes a derived money field');
    assert.equal(rows((await s.get('/Order?total_from=100')).html).length, 0);
    const awarded = await s.post('/Order/1/action/award', {});
    assert.equal(awarded.location, '/Order/1?ok=awarded%2060', 'the plugin block ran and exposed its result');
    assert.equal((await s.app.store.get('User', 1)).points, 60);
    const line = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim();
    assert.equal(line, '{"order":1}', 'the plugin transport delivered');
    assert.equal((await s.app.store.outbox())[0].status, 'sent');
    assert.equal((await s.app.store.outbox())[0].kind, 'log', 'connector.send takes the kind from the connector');
    assert.equal((await s.app.store.outbox())[0].target, path.join(dir, 'audit.log'));
    const store = new Store(graph, ':memory:', s.app.perms ? (await loadPlugins(graph, dir)).registry : undefined);
    const patch = await deliver(store, graph, { id: 1, kind: 'log', connector: 'audit', payload: 1, attempts: 0 }, { registry: (await loadPlugins(graph, dir)).registry });
    assert.equal(patch, 'sent');
  } finally { s.close(); }
});

test('a plugin the graph cannot load makes the graph invalid, on the CLI and on the server', async () => {
  const file = tmpGraph({ ...graph, plugins: ['./nowhere.mjs'] });
  const s = await boot(file);
  try {
    assert.equal(s.app.invalid, true);
    const r = await s.get('/');
    assert.equal(r.status, 500);
    assert.match(r.html, /cannot load plugin/);
  } finally { s.close(); }
  const { main } = await import('../runtime/cli.mjs');
  const out = [];
  const code = (await main([file, '--check'], { log: (m) => out.push(m), err: (m) => out.push(m) })).code;
  assert.equal(code, 1);
  assert.match(out.join('\n'), /cannot load plugin/);
  const good = tmpGraph(graph);
  const ok = [];
  assert.equal((await main([good, '--check'], { log: (m) => ok.push(m), err: (m) => ok.push(m) })).code, 0);
  assert.match(ok.join('\n'), /plugins: .*loyalty\.mjs/);
});
