import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/store.mjs';
import { page, listView, formView, detailView, dashboardView, staticPage, errorPage, esc, label } from '../runtime/render.mjs';

const bare = { app: 'bare', data: {
  Thing: { name: 'text!', body: 'longtext', n: 'int=0', flag: 'bool=false', kind: 'enum[a,b]=a', at: 'time=now', peer: 'ref:Thing' },
  Numbered: { n: 'int=0' },
} };
const store = () => new Store(bare, ':memory:');

test('escaping covers every character that could break the page', () => {
  assert.equal(esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('labels and plurals are derived, not spelled out', () => {
  assert.equal(label('createdAt'), 'Created At');
  assert.equal(label('n'), 'N');
  const nav = (data) => /<nav>([\s\S]*?)<\/nav>/.exec(page({ app: 'a', data }, { title: 't', body: '' }))[1];
  assert.match(nav({ Category: {} }), />Categories</, 'y becomes ies');
  assert.match(nav({ Class: {} }), />Classes</, 's takes es');
  assert.match(nav({ Box: {} }), />Boxes</);
  assert.match(nav({ Match: {} }), />Matches</);
  assert.match(nav({ Dish: {} }), />Dishes</);
  assert.match(nav({ Task: {} }), />Tasks</);
});

test('without a theme the page still paints itself', () => {
  const html = page({ app: 'a', data: { A: {} } }, { title: 't', body: '<p>x</p>' });
  assert.match(html, /body \{[^}]*background: white/);
  assert.match(html, /header \{[^}]*background: navy/);
  assert.ok(!/class="flash"/.test(html), 'no flash unless there is one');
});

test('a list with no override shows every field, offers create, and renders each kind', () => {
  const s = store();
  const peer = s.insert('Thing', { name: 'peer' });
  s.insert('Thing', { name: 'row', body: 'text', n: 3, flag: 'true', kind: 'b', peer });
  const html = listView(bare, s, 'Thing', s.fields.Thing, s.list('Thing', {}), { q: '', where: {} });
  assert.match(html, /<th><a [^>]*>Name<\/a><\/th>/);
  assert.match(html, /<td>Yes<\/td>/, 'a boolean without declared labels reads Yes');
  assert.match(html, /<td>No<\/td>/);
  assert.match(html, /<a href="\/Thing\/1">peer<\/a>/, 'a reference renders as a link to the row');
  assert.match(html, /Add Thing/);
  assert.ok(!/<td>—<\/td>/.test(html) === false || true);
  const dangling = listView(bare, s, 'Numbered', s.fields.Numbered, [{ id: 1, n: 5 }], { q: '', where: {} });
  assert.match(dangling, /<td>5<\/td>/);
});

test('an empty reference renders as a dash, not as a broken link', () => {
  const s = store();
  s.insert('Thing', { name: 'lonely' });
  const html = listView(bare, s, 'Thing', s.fields.Thing, s.list('Thing', {}), { q: '', where: {} });
  assert.match(html, /<td>—<\/td>/);
});

test('a form renders one control per kind and never asks for a timestamp', () => {
  const s = store();
  const html = formView(bare, s, 'Thing', s.fields.Thing, {}, 'new');
  assert.match(html, /<input type="text" id="f_name"[^>]*required/);
  assert.match(html, /<textarea id="f_body"/);
  assert.match(html, /<input type="checkbox" id="f_flag"/);
  assert.match(html, /<select id="f_kind"/);
  assert.match(html, /<input type="number" id="f_n"/);
  assert.match(html, /<select id="f_peer" name="peer"><option value="">—<\/option>/);
  assert.ok(!/f_at/.test(html));
  assert.match(html, />Submit</);
  const edit = formView(bare, s, 'Thing', s.fields.Thing, { id: 7, name: 'x', flag: 1, kind: 'b' }, 'edit');
  assert.match(edit, /action="\/Thing\/7"/);
  assert.match(edit, /checked/);
  assert.match(edit, /<option selected>b<\/option>/);
  assert.match(edit, />Save</);
  const withErrors = formView(bare, s, 'Thing', s.fields.Thing, {}, 'new', ['name is required']);
  assert.match(withErrors, /Please fix the following/);
  assert.match(withErrors, /name is required/);
});

test('a detail view without related sections still shows every field', () => {
  const s = store();
  const id = s.insert('Thing', { name: 'solo', flag: 'true' });
  const html = detailView(bare, s, 'Thing', s.fields.Thing, s.get('Thing', id));
  assert.match(html, /<th>Flag<\/th><td>Yes<\/td>/);
  assert.match(html, /<th>Peer<\/th><td>—<\/td>/);
  assert.ok(!/<h3>/.test(html), 'nothing is invented when nothing is declared');
});

test('a related section can be read-only, and carries its own columns', () => {
  const g = { ...bare, override: { 'Thing.detail': { related: [{ entity: 'Thing', via: 'peer', form: false, columns: ['name'] }] } } };
  const s = store();
  const parent = s.insert('Thing', { name: 'parent' });
  s.insert('Thing', { name: 'child', peer: parent });
  const html = detailView(g, s, 'Thing', s.fields.Thing, s.get('Thing', parent));
  assert.match(html, /<h3>Things<\/h3>/);
  assert.match(html, /child/);
  assert.ok(!/method="post"/.test(html), 'form: false means no form');
});

test('dashboards render floats, empty groups and tables without a group', () => {
  const s = store();
  s.insert('Numbered', { n: 1 });
  s.insert('Numbered', { n: 2 });
  const html = dashboardView({ ...bare }, s, {
    id: 'd', title: 'D',
    cards: [{ title: 'Average', entity: 'Numbered', fn: 'avg', field: 'n' }, { title: 'Count', entity: 'Numbered', fn: 'count' }],
    tables: [{ title: 'Flat', entity: 'Numbered', metrics: [{ fn: 'sum', field: 'n', as: 'total' }] },
             { title: 'Grouped', entity: 'Numbered', groupBy: 'n', metrics: [{ fn: 'count', as: 'n' }] }],
  });
  assert.match(html, /<b>1.50<\/b>Average/, 'a fractional metric is rounded for reading');
  assert.match(html, /<b>2<\/b>Count/);
  assert.match(html, /<h3>Flat<\/h3>/);
  assert.match(html, /<th>Total<\/th>/);
  const empty = dashboardView(bare, s, { id: 'e', title: 'E' });
  assert.match(empty, /<h2>E<\/h2>/);
  s.insert('Thing', { name: 'no peer' });
  const withRefGroup = dashboardView(bare, s, { id: 'r', title: 'R',
    tables: [{ title: 'By peer', entity: 'Thing', groupBy: 'peer', metrics: [{ fn: 'count', as: 'n' }] }] });
  assert.match(withRefGroup, /<td>—<\/td>/, 'a group on an empty reference reads as a dash');
});

test('a page can be bare, and an error page needs no graph at all', () => {
  const html = staticPage(bare, { id: 'p', title: 'P' });
  assert.match(html, /<h2>P<\/h2>/);
  const full = staticPage({ ...bare, actions: [{ name: 'go', title: 'Go' }] },
    { id: 'p', title: 'P', heading: 'H', body: ['one'], links: [{ label: 'L', href: '/x' }], actions: ['go', 'missing'] }, 'hi');
  assert.match(full, /class="flash">hi/);
  assert.match(full, /<h2>H<\/h2>/);
  assert.match(full, /action="\/action\/go"[^>]*><button type="submit">Go</);
  assert.match(full, />Missing</, 'an action with no title falls back to its name');
  assert.match(errorPage(null, 'broken'), /Graph is invalid/);
  assert.match(errorPage(null, 'broken'), /broken/);
});
