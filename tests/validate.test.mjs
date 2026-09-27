import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, formatErrors } from '../runtime/validate.mjs';

const base = { app: 'x', data: { Task: { title: 'text!', done: 'bool=false' } } };
const errs = (patch) => validate({ ...base, ...patch });
const paths = (patch) => errs(patch).map((e) => e.path);
const at = (patch, path) => errs(patch).find((e) => e.path === path) || {};

test('a minimal graph is valid', () => {
  assert.deepEqual(validate(base), []);
});

test('the shape of the graph itself', () => {
  assert.equal(validate(null)[0].message, 'graph must be an object');
  assert.equal(validate('nope')[0].message, 'graph must be an object');
  assert.ok(validate({ data: base.data }).some((e) => e.path === '/app'));
  assert.ok(validate({ app: 'x' }).some((e) => e.path === '/data'));
  assert.ok(validate({ app: 'x', data: {} }).some((e) => e.path === '/data'));
});

test('field specs and references are checked where they are written', () => {
  const e = validate({ app: 'x', data: { Task: { due: 'datetime!' }, Log: { who: 'ref:Ghost' } } });
  assert.ok(e.some((x) => x.path === '/data/Task/due' && /unknown type "datetime"/.test(x.message)));
  assert.ok(e.some((x) => x.path === '/data/Log/who' && /unknown entity "Ghost"/.test(x.message)));
});

test('views are derived, never listed', () => {
  assert.equal(at({ views: 'auto' }, '/views').message, undefined);
  assert.match(at({ views: ['list'] }, '/views').message, /only "auto" is supported/);
});

test('overrides name real entities, real views and real fields — with a suggestion', () => {
  assert.match(at({ override: { 'Ghost.list': {} } }, '/override/Ghost.list').message, /unknown entity "Ghost"/);
  assert.match(at({ override: { 'Task.grid': {} } }, '/override/Task.grid').message, /unknown view "grid"/);
  const typo = at({ override: { 'Task.list': { columns: ['titel'] } } }, '/override/Task.list/columns');
  assert.match(typo.message, /field "titel" does not exist on Task/);
  assert.match(typo.hint, /did you mean: title/);
  const far = at({ override: { 'Task.list': { columns: ['zzzzzzzz'] } } }, '/override/Task.list/columns');
  assert.match(far.hint, /known fields: title, done/, 'with no near match it lists what exists');
  assert.ok(paths({ override: { 'Task.list': { search: ['nope'] } } }).includes('/override/Task.list/search'));
  assert.ok(paths({ override: { 'Task.form': { fields: ['nope'] } } }).includes('/override/Task.form/fields'));
  assert.ok(paths({ override: { 'Task.list': { sort: { field: 'nope' } } } }).includes('/override/Task.list/sort/field'));
  assert.ok(paths({ override: { 'Task.form': { fill: { nope: '@me' } } } }).includes('/override/Task.form/fill/nope'));
  assert.ok(paths({ override: { 'Task.list': { labels: { nope: ['a', 'b'] } } } }).includes('/override/Task.list/labels/nope'));
});

test('filters need a field, and options unless the field can supply them', () => {
  assert.match(at({ override: { 'Task.list': { filters: [{}] } } }, '/override/Task.list/filters/0').message, /needs a "field"/);
  assert.match(at({ override: { 'Task.list': { filters: [{ field: 'title' }] } } }, '/override/Task.list/filters/0').message,
    /filter on "title" needs "options"/);
  assert.deepEqual(errs({ override: { 'Task.list': { filters: [{ field: 'done', options: [{ label: 'All' }] }] } } }), []);
  const withRef = validate({ app: 'x', data: { C: { name: 'text!' }, P: { c: 'ref:C', s: 'enum[a,b]' } },
    override: { 'P.list': { filters: [{ field: 'c' }, { field: 's' }] } } });
  assert.deepEqual(withRef, [], 'ref and enum filters derive their own options');
});

test('row actions are built-in or declared', () => {
  assert.deepEqual(errs({ override: { 'Task.list': { rowActions: ['view', 'edit', 'delete'] } } }), []);
  const e = at({ override: { 'Task.list': { rowActions: ['toggle'] } } }, '/override/Task.list/rowActions/0');
  assert.match(e.message, /unknown action "toggle"/);
  assert.match(e.hint, /\(none\)/);
});

test('related sections must point back at the parent', () => {
  const data = { Post: { title: 'text!' }, Reply: { post: 'ref:Post!', body: 'text!' }, Other: { post: 'text' } };
  const ok = validate({ app: 'x', data, override: { 'Post.detail': { related: [{ entity: 'Reply', via: 'post', columns: ['body'] }] } } });
  assert.deepEqual(ok, []);
  const noVia = validate({ app: 'x', data, override: { 'Post.detail': { related: [{ entity: 'Reply' }] } } });
  assert.match(noVia[0].message, /needs "via"/);
  const notRef = validate({ app: 'x', data, override: { 'Post.detail': { related: [{ entity: 'Other', via: 'post' }] } } });
  assert.match(notRef[0].message, /is text, not a reference/);
  const wrongTarget = validate({ app: 'x', data: { ...data, Third: { post: 'ref:Reply' } },
    override: { 'Post.detail': { related: [{ entity: 'Third', via: 'post' }] } } });
  assert.match(wrongTarget[0].message, /points at Reply, not Post/);
  const badCol = validate({ app: 'x', data, override: { 'Post.detail': { related: [{ entity: 'Reply', via: 'post', columns: ['nope'], fill: { nope: 1 } }] } } });
  assert.equal(badCol.length, 2);
  const ghost = validate({ app: 'x', data, override: { 'Post.detail': { related: [{ entity: 'Ghost', via: 'post' }] } } });
  assert.match(ghost[0].message, /unknown entity "Ghost"/);
});

test('saved lists, dashboards and pages are checked field by field', () => {
  assert.ok(paths({ lists: [{ entity: 'Task' }] }).includes('/lists/0/id'));
  assert.ok(paths({ lists: [{ id: 'a', entity: 'Ghost' }] }).includes('/lists/0/entity'));
  assert.ok(paths({ lists: [{ id: 'a', entity: 'Task', columns: ['x'], where: { y: 1 }, sort: { field: 'z' } }] })
    .join() .includes('/lists/0/columns'));
  assert.ok(paths({ dashboards: [{ cards: [] }] }).includes('/dashboards/0/id'));
  assert.ok(paths({ dashboards: [{ id: 'd', cards: [{ entity: 'Ghost' }] }] }).includes('/dashboards/0/cards/0/entity'));
  assert.match(at({ dashboards: [{ id: 'd', cards: [{ entity: 'Task', fn: 'median' }] }] }, '/dashboards/0/cards/0/fn').message, /unknown function/);
  assert.match(at({ dashboards: [{ id: 'd', cards: [{ entity: 'Task', fn: 'sum' }] }] }, '/dashboards/0/cards/0/field').message, /needs a field/);
  assert.ok(paths({ dashboards: [{ id: 'd', cards: [{ entity: 'Task', fn: 'count', where: { ghost: 1 } }] }] })
    .includes('/dashboards/0/cards/0/where/ghost'));
  assert.ok(paths({ dashboards: [{ id: 'd', tables: [{ entity: 'Task', groupBy: 'ghost', metrics: [{ fn: 'count', as: 'n' }] }] }] })
    .includes('/dashboards/0/tables/0/groupBy'));
  assert.ok(paths({ dashboards: [{ id: 'd', tables: [{ entity: 'Task', metrics: [{ fn: 'count' }] }] }] })
    .includes('/dashboards/0/tables/0/metrics/0/as'));
  assert.ok(paths({ dashboards: [{ id: 'd', tables: [{ entity: 'Task', metrics: [{ fn: 'sum', as: 'v', field: 'ghost' }] }] }] })
    .includes('/dashboards/0/tables/0/metrics/0/field'));
  assert.match(at({ dashboards: [{ id: 'd', tables: [{ entity: 'Task', metrics: [{ fn: 'count', as: 'n' }], sort: { field: 'zz' } }] }] },
    '/dashboards/0/tables/0/sort/field').message, /sort must name a metric/);
  assert.ok(paths({ pages: [{ title: 'Home' }] }).includes('/pages/0/id'));
  assert.ok(paths({ pages: [{ id: 'home' }] }).includes('/pages/0/title'));
});

test('actions, blocks and their requirements', () => {
  assert.ok(paths({ actions: [{ in: 'Task', do: [{ block: 'db.delete' }] }] }).includes('/actions/0/name'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Ghost', do: [{ block: 'db.delete' }] }] }).includes('/actions/0/in'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task' }] }).includes('/actions/0/do'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [] }] }).includes('/actions/0/do'));
  const typo = at({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.togle', field: 'done' }] }] }, '/actions/0/do/0/block');
  assert.match(typo.hint, /did you mean: db.toggle/);
  const unknown = at({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'zzzzzz' }] }] }, '/actions/0/do/0/block');
  assert.match(unknown.hint, /catalog: db.create/);
  assert.match(at({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.toggle' }] }] }, '/actions/0/do/0').message, /requires "field"/);
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.toggle', field: 'ghost' }] }] }).includes('/actions/0/do/0/field'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.update', set: { ghost: 1 } }] }] }).includes('/actions/0/do/0/set/ghost'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'random.pick', from: 'Ghost' }] }] }).includes('/actions/0/do/0/from'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.createRow', entity: 'Ghost', values: {} }] }] }).includes('/actions/0/do/0/entity'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.createRow', entity: 'Task', values: { ghost: 1 } }] }] })
    .includes('/actions/0/do/0/values/ghost'));
  assert.ok(paths({ actions: [{ name: 'a', in: 'Task', do: [{ block: 'check.matchRef', ref: 'x', field: 'title', against: 'y', into: 'ghost' }] }] })
    .includes('/actions/0/do/0/into'));
  assert.deepEqual(errs({ actions: [{ name: 'a', do: [{ block: 'db.createRow', entity: 'Task', values: { title: 'x' } }] }] }), [],
    'an action without "in" is global and valid');
});

test('events trigger on created, updated and deleted of a real entity', () => {
  assert.match(at({ events: [{ on: 'Task.exploded', do: [] }] }, '/events/0/on').message, /unsupported trigger/);
  assert.deepEqual(errs({ events: [{ on: 'Task.updated', do: [{ block: 'db.update', set: { done: 'true' } }] }, { on: 'Task.deleted', do: [{ block: 'db.createRow', entity: 'Task', values: { title: 'gone' } }] }] }), []);
  assert.ok(paths({ events: [{ on: 'Ghost.created', do: [] }] }).includes('/events/0/on'));
  assert.deepEqual(errs({ events: [{ on: 'Task.created', do: [{ block: 'db.update', set: { done: 'true' } }] }] }), []);
  assert.ok(paths({ events: [{ on: 'Task.created', do: [{ block: 'nope' }] }] }).includes('/events/0/do/0/block'));
});

test('identity, seed and page buttons', () => {
  assert.ok(paths({ identity: { entity: 'Ghost' } }).includes('/identity/entity'));
  assert.ok(paths({ identity: { entity: 'Task', defaults: { ghost: 1 } } }).includes('/identity/defaults/ghost'));
  assert.ok(paths({ seed: { Ghost: [] } }).includes('/seed/Ghost'));
  assert.ok(paths({ seed: { Task: [{ ghost: 1 }] } }).includes('/seed/Task/0/ghost'));
  assert.deepEqual(errs({ seed: { Task: [{ title: 'a' }] } }), []);
  assert.match(at({ pages: [{ id: 'p', title: 'P', actions: ['nope'] }] }, '/pages/0/actions/0').message, /unknown action "nope"/);
  assert.match(at({ pages: [{ id: 'p', title: 'P', actions: ['a'] }],
    actions: [{ name: 'a', in: 'Task', do: [{ block: 'db.delete' }] }] }, '/pages/0/actions/0').message, /bound to Task/);
});

test('a seeded reference must resolve on a fresh table: self, identity, another seeded entity, or nothing', () => {
  const refData = { A: { name: 'text!' }, B: { a: 'ref:A!', self: 'ref:B' } };
  // B.a points at A, which the seed never touches at all: unproducible.
  const gone = validate({ app: 'x', data: refData, seed: { B: [{ a: 3 }] } }).find((e) => e.path === '/seed/B/0/a');
  assert.match(gone.message, /B\.a seeds a reference to A #3, but the seed produces no A row\(s\)/);
  assert.match(gone.hint, /add "A" to \/seed, or point at a row that already exists/);
  // A is seeded, but with fewer rows than the id asked for: producible, just short.
  const short = validate({ app: 'x', data: refData, seed: { A: [{ name: 'x' }], B: [{ a: 2 }] } }).find((e) => e.path === '/seed/B/0/a');
  assert.match(short.message, /produces only 1 A row\(s\)/);
  assert.match(short.hint, /use an id from 1 to 1/);
  // A self-reference is producible up to the entity's own seeded row count.
  assert.deepEqual(validate({ app: 'x', data: refData, seed: { B: [{}, { self: 2 }] } }).filter((e) => e.path.startsWith('/seed/B/1')), []);
  assert.match(validate({ app: 'x', data: refData, seed: { B: [{ self: 2 }] } }).find((e) => e.path === '/seed/B/0/self').message, /produces only 1 B row\(s\)/);
  // The /identity row is exactly one row, seeded before everything else.
  const withIdentity = { app: 'x', data: refData, identity: { entity: 'A' }, seed: { B: [{ a: 1 }] } };
  assert.deepEqual(validate(withIdentity).filter((e) => e.path === '/seed/B/0/a'), []);
  assert.match(validate({ ...withIdentity, seed: { B: [{ a: 2 }] } }).find((e) => e.path === '/seed/B/0/a').message, /produces only 1 A row\(s\)/);
  // A non-id-shaped or blank value is left for the store to judge at boot.
  assert.deepEqual(validate({ app: 'x', data: refData, seed: { B: [{ a: '' }, { a: 0 }] } }).filter((e) => e.path.startsWith('/seed/B')), []);
});

test('errors are formatted so the repair loop can act on them', () => {
  const text = formatErrors(validate({ app: 'x', data: { Task: { title: 'text!' } }, override: { 'Task.list': { columns: ['titel'] } } }));
  assert.match(text, /✗ \/override\/Task.list\/columns: field "titel" does not exist on Task/);
  assert.match(text, /→ did you mean: title/);
  assert.equal(formatErrors([]), '');
});

test('every shipped graph is valid, with the plugins it declares', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { loadPlugins } = await import('../runtime/registry.mjs');
  const apps = fs.readdirSync('apps');
  assert.ok(apps.length >= 35);
  for (const app of apps) {
    const graph = JSON.parse(fs.readFileSync(`apps/${app}/app.json`, 'utf8'));
    const { registry, errors } = await loadPlugins(graph, path.resolve('apps', app));
    assert.deepEqual([...errors, ...validate(graph, registry)], [], `apps/${app}/app.json must stay valid`);
  }
});
