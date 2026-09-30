// The defensive branches: what happens on the paths nobody plans to walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { Store } from '../runtime/store.mjs';
import { CATALOG } from '../runtime/blocks.mjs';
import { validate } from '../runtime/validate.mjs';
import { listView } from '../runtime/render/list.mjs';
import { serve } from '../runtime/server.mjs';
import { boot, rows, flash, tmpDir, viewer } from './helpers.mjs';

test('an entity with no fields still gets a table, and unknown entities answer emptily', () => {
  const store = new Store({ app: 'x', data: { Empty: {}, A: { n: 'int' } } }, ':memory:');
  assert.deepEqual(store.drv.columns('empty').map((c) => c.name), ['id']);
  assert.equal(store.field('Ghost', 'x'), undefined);
  assert.equal(store.labelField('Ghost'), null, 'an unknown entity simply has no label field');
  assert.equal(store.labelField('A'), null, 'an entity without a text field has no label field');
});

test('random.pick survives weights that sum to zero', () => {
  const store = new Store({ app: 'x', data: { P: { name: 'text!', w: 'int=0' } } }, ':memory:');
  store.insert('P', { name: 'a', w: 0 });
  store.insert('P', { name: 'b', w: 0 });
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(CATALOG['random.pick'].run({ store, step: { from: 'P', weight: 'w' } }).picked.name);
  assert.equal(seen.size, 2, 'all-zero weights must not make the wheel unpickable');
});

test('the checker keeps its footing on entities that do not exist', () => {
  const e = validate({ app: 'x', data: { A: { n: 'int' } },
    dashboards: [{ id: 'd', tables: [{ entity: 'Ghost', metrics: [{ fn: 'count', as: 'n' }] }] }],
    lists: [{ id: 'l', entity: 'Ghost' }],
    events: [{ do: [{ block: 'db.delete' }] }],
    actions: [{ name: 'a', in: 'A', do: [{ block: 'db.createRow', entity: 'A', values: { n: 1 }, via: 'ghost' }] }] });
  const paths = e.map((x) => x.path);
  assert.ok(paths.includes('/dashboards/0/tables/0/entity'));
  assert.ok(paths.includes('/lists/0/entity'));
  assert.ok(paths.includes('/events/0/on'), 'an event without a trigger is reported, not thrown');
  assert.ok(paths.includes('/actions/0/do/0/via'));
  assert.ok(validate({ app: 'x', data: { A: { n: 'int' } },
    dashboards: [{ id: 'd', tables: [{ entity: 'A', metrics: [{ as: 'n' }] }] }] })
    .some((x) => x.path === '/dashboards/0/tables/0/metrics/0/fn'), 'a metric without a function is reported');
});

test('a list renders a column that is not a field, and a table without actions', () => {
  const graph = { app: 'x', data: { A: { name: 'text!' } },
    override: { 'A.list': { columns: ['name', 'ghost'], rowActions: [], create: false } } };
  const store = new Store(graph, ':memory:');
  store.insert('A', { name: 'one' });
  const html = listView(graph, store, 'A', store.fields.A, store.list('A', {}), { q: '', where: {} });
  assert.match(html, /<th><a href="[^"]*sort=ghost[^"]*">Ghost<\/a><\/th>/, 'column headers sort');
  assert.ok(!/Actions/.test(html));
  assert.ok(!/Add A/.test(html));
});

test('a filter falls back to its declared name, and an unknown row action to its own label', () => {
  const graph = { app: 'x', data: { A: { name: 'text!', k: 'enum[a,b]=a' } },
    override: { 'A.list': { filters: [{ field: 'k' }], rowActions: ['ghost'] } } };
  const store = new Store(graph, ':memory:');
  store.insert('A', { name: 'one' });
  const html = listView(graph, store, 'A', store.fields.A, store.list('A', {}), { q: '', where: {} });
  assert.match(html, /<strong>K<\/strong>/, 'a filter with no name is titled by its field');
  assert.match(html, />Ghost</, 'a row action with no declaration still renders its name');
});

test('an intro, a required number and a related section with all columns', () => {
  const graph = { app: 'x', data: { P: { name: 'text!', n: 'int!' }, C: { p: 'ref:P!', note: 'text!' } },
    override: { 'P.form': { intro: 'fill it in' },
                'P.detail': { related: [{ entity: 'C', via: 'p', form: true }] } } };
  const store = new Store(graph, ':memory:');
  const id = store.insert('P', { name: 'parent', n: 1 });
  store.insert('C', { p: id, note: 'child' });
  const form = viewer(graph, store).form('P', {}, 'new');
  assert.match(form, /fill it in/);
  assert.match(form, /type="number"[^>]*required/);
  const detail = viewer(graph, store).detail('P', store.get('P', id));
  assert.match(detail, /<th>Note<\/th>/, 'a related section with no declared columns shows every child field but the link');
  assert.ok(!/<th>P<\/th>/.test(detail.split('<h3>')[1]), 'the link column is not repeated');
  assert.match(detail, /method="post"/, 'form: true means the full child form');
});

test('a dashboard card without a function counts, and a missing metric reads zero', () => {
  const graph = { app: 'x', data: { A: { name: 'text!' } } };
  const store = new Store(graph, ':memory:');
  store.insert('A', { name: 'one' });
  const html = viewer(graph, store).dashboard({ id: 'd', title: 'D',
    cards: [{ title: 'Rows', entity: 'A' }],
    tables: [{ title: 'T', entity: 'A', groupBy: 'name', metrics: [{ fn: 'count', as: 'n' }, { fn: 'count', as: 'missing' }] }] });
  assert.match(html, /<b>1<\/b>Rows/);
  assert.match(html, /<th>Missing<\/th>/);
});

test('seed and identity happen once, not on every boot', async () => {
  const dir = tmpDir('ag-seed-');
  const db = path.join(dir, 'd.sqlite');
  const open = async () => {
    const app = serve({ graphFile: 'tests/fixtures/kitchen.json', dbFile: db, traceFile: null, port: 0 });
    await once(app.server, 'listening');
    return app;
  };
  const first = await open();
  const topics = first.store.count('Topic');
  const profiles = first.store.count('Profile');
  first.server.close();
  const second = await open();
  // finally: a failing assertion must not leave the second server listening — that
  // hangs the whole file (the event loop never drains), not just this one test.
  try {
    assert.equal(second.store.count('Topic'), topics, 'seed rows are not duplicated');
    assert.equal(second.store.count('Profile'), profiles, 'the identity row is reused');
  } finally { second.server.close(); }
});

test('seed order: identity before seed, and a self-reference patched once every row exists', async () => {
  const graph = {
    app: 'x', identity: { entity: 'Customer', defaults: { name: 'Alex' } },
    data: { Customer: { name: 'text!' }, User: { name: 'text!', manager: 'ref:User' },
      Order: { customer: 'ref:Customer!', item: 'text!' } },
    // Order seeds before Customer is ever declared in /seed at all: only the identity
    // row (created before seeding) makes "customer: 1" resolvable. Ada and Bo manage
    // each other: neither self-reference exists yet when its own row is inserted.
    seed: { User: [{ name: 'Ada', manager: 2 }, { name: 'Bo', manager: 1 }], Order: [{ customer: 1, item: 'widget' }] },
  };
  const dir = tmpDir('ag-seedorder-');
  const app = serve({ graphFile: (() => { const f = path.join(dir, 'app.json'); fs.writeFileSync(f, JSON.stringify(graph)); return f; })(),
    dbFile: path.join(dir, 'd.sqlite'), traceFile: null, port: 0 });
  await once(app.server, 'listening');
  // finally: a failing assertion must not leave the server listening — that hangs
  // the whole file (the event loop never drains), not just this one test.
  try {
    assert.equal(app.store.count('Order'), 1, 'the order referencing the identity customer was seeded');
    const users = app.store.list('User', { sort: { field: 'id', dir: 'asc' } });
    assert.deepEqual(users.map((u) => u.manager), ['2', '1'], 'Ada and Bo each manage the other, patched in after both rows exist');
  } finally { app.server.close(); }
});

test('an app that declares nothing beyond its data still works end to end', async () => {
  const dir = tmpDir('ag-bare-');
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'bare', data: { Note: { text: 'text!', done: 'bool=false' } } }));
  const s = await boot(file);
  try {
    const root = await s.get('/');
    assert.equal(root.location, '/Note', 'with no home and no pages the first entity is home');
    const created = await s.follow('/Note', { text: 'hello' });
    assert.match(flash(created.html), /Note saved successfully/, 'the default confirmation');
    assert.equal(rows(created.html).length, 1);
    const id = /\/Note\/(\d+)\/delete/.exec(created.html)[1];
    const edited = await s.follow(`/Note/${id}`, { text: 'changed' });
    assert.match(flash(edited.html), /Note updated successfully/);
    assert.match(edited.html, /changed/);
    assert.equal(rows((await s.get('/Note?q=anything')).html).length, 1, 'a query with no declared search fields filters nothing');
  } finally { s.close(); }
});

test('interpolation and references resolve, or resolve to nothing', async () => {
  const s = await boot();
  try {
    const spin = await s.post('/action/spin', {});
    assert.match(decodeURIComponent(spin.location), /You won: Mug/);
    const r = await s.post('/Post', { title: 'with author', topic: '1', mood: 'calm', rank: '0' });
    const list = await s.get(r.location);
    assert.match(list.html, />Me</, '@me resolved to the identity row');
    assert.equal(flash(list.html), 'Post saved', 'a declared confirmation replaces the default one');
  } finally { s.close(); }
});

test('the last defensive paths: no options, no metrics, no actions, missing values', async () => {
  const graph = { app: 'x', data: { A: { name: 'text!', k: 'enum[a,b]=a' } },
    override: { 'A.list': { filters: [{ field: 'k', options: [] }], rowActions: [] } } };
  const store = new Store(graph, ':memory:');
  store.insert('A', { name: 'one' });
  const html = listView(graph, store, 'A', store.fields.A, store.list('A', {}), { q: '', where: {} });
  assert.match(html, /<strong>K<\/strong><div><\/div>/, 'a filter with an empty option list renders no links');
  assert.ok(!/<td><\/td>/.test(html));

  const empty = new Store({ app: 'x', data: { B: { n: 'int' } } }, ':memory:');
  const dash = viewer({ app: 'x', data: { B: { n: 'int' } } }, empty).dashboard({ id: 'd', title: 'D',
    cards: [{ title: 'Sum of nothing', entity: 'B', fn: 'sum', field: 'n' }],
    tables: [{ title: 'T', entity: 'B', groupBy: 'n' }] });
  assert.match(dash, /<b>0<\/b>Sum of nothing/, 'an aggregate over no rows reads zero, not blank');
  assert.match(dash, /<h3>T<\/h3>/, 'a table with no metrics still renders its heading');
  empty.insert('B', { n: 1 });
  const dashRows = viewer({ app: 'x', data: { B: { n: 'int' } } }, empty).dashboard(
    { id: 'd', title: 'D', tables: [{ title: 'T', entity: 'B', groupBy: 'n' }] });
  assert.match(dashRows, /<tr><td>1<\/td><\/tr>/, 'a grouped table with no metrics lists its groups and nothing else');
});

test('resolution of @now, of a path that leads nowhere, and of a plain value', async () => {
  const dir = tmpDir('ag-res-');
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({
    app: 'res', data: { A: { name: 'text!', at: 'text', ghost: 'text' } },
    actions: [
      { name: 'stamp', confirm: 'made {created} at {nothing.deep}', after: '/A?x=1',
        do: [{ block: 'db.createRow', entity: 'A', values: { name: 'literal', at: '@now', ghost: '@values.ghost' } }] },
      { name: 'quiet', do: [{ block: 'db.createRow', entity: 'A', values: { name: 'no confirm' } }] },
    ],
  }));
  const s = await boot(file);
  try {
    const r = await s.post('/action/stamp', {});
    assert.match(r.location, /^\/A\?x=1&ok=/, 'a confirmation joins a target that already has a query');
    assert.match(decodeURIComponent(r.location), /made \d+ at $/, 'a path that leads nowhere interpolates to nothing');
    const list = await s.get('/A');
    const row = rows(list.html)[0];
    assert.match(row, /\d{4}-\d{2}-\d{2}T/, '@now became a timestamp');
    assert.match(row, /literal/, 'a plain value passes through untouched');
    assert.ok(validate({ app: 'r', data: { A: { n: 'text' } }, actions: [{ name: 'x', do: [{ block: 'db.createRow', entity: 'A', values: { n: '@nothing.deep' } }] }] })
      .some((e) => e.path === '/actions/0/do/0/values/n' && /unknown reference/.test(e.message)), 'a reference that leads nowhere is a checker error, not a silent null');
    const quiet = await s.post('/action/quiet', {});
    assert.ok(!quiet.location.includes('ok='), 'an action without a confirmation redirects silently');
  } finally { s.close(); }
});

test('the strikethrough row, a page whose graph declares no actions, an identity without defaults', async () => {
  const graph = { app: 'x', data: { T: { title: 'text!', done: 'bool=false' } } };
  const store = new Store(graph, ':memory:');
  store.insert('T', { title: 'finished', done: 'true' });
  store.insert('T', { title: 'open' });
  const html = listView(graph, store, 'T', store.fields.T, store.list('T', {}), { q: '', where: {} });
  assert.equal((html.match(/<tr class="done">/g) || []).length, 1, 'exactly the finished row is struck through');
  assert.equal((html.match(/<tr class="">/g) || []).length, 1);

  const { staticPage } = await import('../runtime/render/pages.mjs');
  const bareGraph = { app: 'x', data: { T: {} } };
  const page = staticPage(bareGraph, { id: 'p', title: 'P', actions: ['ghost'] });
  assert.match(page, />Ghost</, 'a page button survives a graph that declares no actions at all');

  const dir = tmpDir('ag-id-');
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'id', data: { Me: { name: 'text' } }, identity: { entity: 'Me' } }));
  const s = await boot(file);
  try {
    assert.equal(s.app.store.count('Me'), 1, 'an identity without defaults still gets its row');
  } finally { s.close(); }
});

test('the checker survives a step written against an entity that does not exist', () => {
  const e = validate({ app: 'x', data: { A: { n: 'int' } },
    actions: [{ name: 'a', in: 'Ghost', do: [{ block: 'db.toggle', field: 'n' }] }],
    dashboards: [{ id: 'd', tables: [
      { title: 'no metrics', entity: 'A' },
      { title: 'sorted by group', entity: 'A', groupBy: 'n', metrics: [{ fn: 'count', as: 'c' }], sort: { field: 'grp' } },
      { title: 'sorted, no metrics', entity: 'A', groupBy: 'n', sort: { field: 'nothing' } }] }] });
  const paths = e.map((x) => x.path);
  assert.ok(paths.includes('/actions/0/in'));
  assert.ok(paths.includes('/actions/0/do/0/field'), 'the field is still checked, against nothing');
  assert.ok(!paths.includes('/dashboards/0/tables/1/sort/field'), 'sorting by the group column is allowed');
  assert.ok(paths.includes('/dashboards/0/tables/2/sort/field'), 'sorting by nothing at all is not');
});

test('a row action on a graph without actions, and an action that declares no target', async () => {
  const dir = tmpDir('ag-noact-');
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'noact', data: { A: { name: 'text!', done: 'bool=false' } } }));
  const s = await boot(file);
  try {
    const id = s.app.store.insert('A', { name: 'x' });
    assert.equal((await s.post(`/A/${id}/action/anything`, {})).status, 404,
      'a graph with no actions answers 404, it does not crash');
  } finally { s.close(); }

  const file2 = path.join(dir, 'app2.json');
  fs.writeFileSync(file2, JSON.stringify({ app: 'plain', data: { A: { name: 'text!', done: 'bool=false' } },
    actions: [{ name: 'finish', in: 'A', do: [{ block: 'db.toggle', field: 'done' }] }],
    override: { 'A.list': { rowActions: ['finish'] } } }));
  const s2 = await boot(file2);
  try {
    const id = s2.app.store.insert('A', { name: 'y' });
    const r = await s2.post(`/A/${id}/action/finish`, {});
    assert.equal(r.location, '/A', 'without "after" the action returns to the list');
    assert.ok(!r.location.includes('ok='), 'without "confirm" it says nothing');
    assert.equal(s2.app.store.get('A', id).done, 1);
  } finally { s2.close(); }
});

test('a wheel whose arithmetic runs off the end still returns a prize', async (t) => {
  const store = new Store({ app: 'x', data: { P: { name: 'text!', w: 'int=1' } } }, ':memory:');
  store.insert('P', { name: 'only', w: 1 });
  const real = Math.random;
  Math.random = () => 1;                       // the value Math.random never returns
  try {
    const { picked } = CATALOG['random.pick'].run({ store, step: { from: 'P', weight: 'w' } });
    assert.equal(picked.name, 'only', 'the fallback catches the edge of the range');
  } finally { Math.random = real; }
});


test('an unchecked box means false, even when the declared default says true', async () => {
  // The gap the mutation gate found: a browser sends nothing for an unchecked box,
  // and "nothing" must not be read as "apply the declared default".
  const dir = tmpDir('ag-box-');
  const file = path.join(dir, 'app.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'box',
    data: { Job: { title: 'text!', active: 'bool=true' }, Task: { job: 'ref:Job!', title: 'text!', urgent: 'bool=true' } },
    override: { 'Job.list': { labels: { active: ['Closed', 'Active'] } },
                'Job.detail': { related: [{ entity: 'Task', via: 'job', form: ['title', 'urgent'] }] } } }));
  const s = await boot(file);
  try {
    await s.post('/Job', { title: 'left unchecked' });
    await s.post('/Job', { title: 'ticked', active: 'on' });
    const list = await s.get('/Job');
    assert.match(rows(list.html).find((r) => r.includes('left unchecked')), /Closed/,
      'a box the user did not tick must be stored as false');
    assert.match(rows(list.html).find((r) => r.includes('ticked')), /Active/);

    const id = /\/Job\/(\d+)\/delete/.exec(list.html)[1];
    await s.post(`/Job/${id}/add/Task`, { title: 'child left unchecked' });
    const detail = await s.get(`/Job/${id}`);
    const child = rows(detail.html).find((r) => r.includes('child left unchecked'));
    assert.match(child, /<td>No<\/td>/, 'the same rule applies to a related form');

    // A block writing directly still gets the declared default: only forms mean "unchecked".
    const direct = s.app.store.insert('Job', { title: 'written by a block' });
    assert.equal(s.app.store.get('Job', direct).active, 1);
  } finally { s.close(); }
});
