import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, rows, flash } from './helpers.mjs';

let s;
before(async () => { s = await boot(); });
after(() => s.close());

test('the root goes to the declared home, and pages render with their buttons', async () => {
  const root = await s.get('/');
  assert.equal(root.status, 303);
  assert.equal(root.location, '/page/home');
  const home = await s.get('/page/home');
  assert.equal(home.status, 200);
  assert.match(home.html, /Kitchen sink/);
  assert.match(home.html, /Everything the format can do/);
  assert.match(home.html, /action="\/action\/spin"/);
  assert.match(home.html, /href="\/Post"/);
  assert.equal((await s.get('/page/nope')).status, 404);
});

test('the theme reaches the page and nothing else styles it', async () => {
  const { html } = await s.get('/Post');
  assert.match(html, /body \{[^}]*background: seashell/);
  assert.match(html, /header \{[^}]*background: maroon/);
  assert.match(html, /button, \.btn \{[^}]*background: maroon/);
});

test('seed rows are inserted once, identity creates exactly one row', async () => {
  const topics = await s.get('/Topic');
  assert.equal(rows(topics.html).length, 2);
  const profiles = await s.get('/Profile');
  assert.equal(rows(profiles.html).length, 1);
  assert.match(profiles.html, /me@example.com/);
});

test('create: required fields are enforced before anything is written', async () => {
  const bad = await s.post('/Post', { title: '', topic: '', rank: 'abc', mood: 'furious' });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /title is required/);
  assert.match(bad.html, /topic is required/);
  assert.match(bad.html, /rank must be a number/);
  assert.match(bad.html, /mood must be one of: calm, loud/);
  assert.equal(rows((await s.get('/Post')).html).length, 0, 'nothing was stored');
  assert.ok(s.trace().some((e) => e.kind === 'rejected'), 'the refusal is recorded in the trace');
});

test('create: values are stored, "fill" applies, the confirmation is shown, the event fires', async () => {
  const r = await s.post('/Post', { title: 'First', body: 'hello world', topic: '1', rank: '5', mood: 'loud' });
  assert.equal(r.status, 303);
  assert.match(r.location, /^\/Post\?ok=/);
  const list = await s.get(r.location);
  assert.equal(flash(list.html), 'Post saved');
  const row = rows(list.html)[0];
  assert.match(row, /First/);
  assert.match(row, /first<\/a>/, 'the reference is rendered by its label');
  assert.match(row, />Me</, '"fill" put the current identity into the author');
  assert.match(row, /Not pinned/, 'declared labels replace Yes/No');
  const notes = await s.get('/Note');
  assert.equal(rows(notes.html).length, 1, 'the Post.created event created a note');
  assert.ok(s.trace().some((e) => e.kind === 'event' && e.on === 'Post.created'));
});

test('list: search, every kind of filter, declared sort', async () => {
  await s.post('/Post', { title: 'Second', body: 'other text', topic: '2', rank: '9', mood: 'calm' });
  await s.post('/Post', { title: 'Third', body: 'hello again', topic: '1', rank: '1', mood: 'calm' });
  const all = await s.get('/Post');
  assert.deepEqual(rows(all.html).map((r) => /<td>(\w+)<\/td>/.exec(r)[1]), ['Second', 'First', 'Third'], 'sorted by rank desc');
  const found = await s.get('/Post?q=hello');
  assert.equal(rows(found.html).length, 2, 'search looks at every declared field');
  const byRef = await s.get('/Post?topic=2');
  assert.equal(rows(byRef.html).length, 1);
  const byEnum = await s.get('/Post?mood=calm');
  assert.equal(rows(byEnum.html).length, 2);
  const byBool = await s.get('/Post?pinned=true');
  assert.equal(rows(byBool.html).length, 0);
  assert.match(all.html, /aria-current="true"/, 'the active filter is marked');
  assert.match(all.html, /<option value="1">first<\/option>|href="\/Post\?topic=1"/);
});

test('row action runs its blocks, flips the caption and confirms', async () => {
  const before = await s.get('/Post');
  const id = /\/Post\/(\d+)\/action\/pin/.exec(before.html)[1];
  const r = await s.follow(`/Post/${id}/action/pin`, {});
  assert.equal(flash(r.html), 'Pin state changed');
  const pinned = rows(r.html).find((x) => x.includes(`/Post/${id}/action/pin`));
  assert.match(pinned, />Pinned</);
  assert.match(pinned, />Unpin</, 'the caption flips with the value');
  await s.follow(`/Post/${id}/action/pin`, {});
  const again = await s.get('/Post');
  assert.match(rows(again.html).find((x) => x.includes(`/Post/${id}/action/pin`)), />Pin</);
  assert.equal((await s.post('/Post/1/action/ghost', {})).status, 404);
});

test('global action: picks, writes, interpolates the confirmation', async () => {
  const r = await s.post('/action/spin', {});
  assert.match(r.location, /^\/Win\?ok=You%20won%3A%20Mug/);
  const wins = await s.get(r.location);
  assert.equal(rows(wins.html).length, 1);
  assert.match(rows(wins.html)[0], /Mug/);
  assert.equal((await s.post('/action/ghost', {})).status, 404);
});

test('detail: related rows, inline form, and what it refuses', async () => {
  const id = /\/Post\/(\d+)/.exec((await s.get('/Post')).html)[1];
  const detail = await s.get(`/Post/${id}`);
  assert.match(detail.html, /<h3>Replies<\/h3>/);
  assert.match(detail.html, /action="\/Post\/\d+\/add\/Reply"/);
  const added = await s.follow(`/Post/${id}/add/Reply`, { body: 'a reply' });
  assert.equal(flash(added.html), 'Reply added');
  assert.match(added.html, /a reply/);
  const empty = await s.post(`/Post/${id}/add/Reply`, { body: '' });
  assert.equal(empty.status, 400, 'the child is validated too');
  assert.equal((await s.post(`/Post/${id}/add/Note`, { text: 'x' })).status, 404, 'only declared relations accept writes');
  assert.equal((await s.get('/Post/9999')).status, 404);
  assert.equal((await s.get('/Post/9999/edit')).status, 404);
});

test('edit: partial validation, booleans that were unchecked, confirmation', async () => {
  const id = /\/Post\/(\d+)/.exec((await s.get('/Post')).html)[1];
  const form = await s.get(`/Post/${id}/edit`);
  assert.match(form.html, /value="Second"|value="First"|value="Third"/);
  assert.match(form.html, /<textarea/);
  assert.match(form.html, /<select id="f_topic"/);
  assert.match(form.html, /<select id="f_mood"/);
  assert.match(form.html, /type="number"/);
  assert.ok(!/name="createdAt"/.test(form.html), 'timestamps are not asked from the user');
  const bad = await s.post(`/Post/${id}`, { title: '', rank: 'x' });
  assert.equal(bad.status, 400);
  const good = await s.follow(`/Post/${id}`, { title: 'Renamed', topic: '1', rank: '3', mood: 'calm' });
  assert.match(flash(good.html), /updated successfully/);
  assert.match(good.html, /Renamed/);
});

test('delete removes the row and says so', async () => {
  const id = /\/Post\/(\d+)\/delete/.exec((await s.get('/Post')).html)[1];
  const r = await s.follow(`/Post/${id}/delete`, {});
  assert.match(flash(r.html), /deleted/);
  assert.ok(!rows(r.html).some((x) => x.includes(`/Post/${id}/delete`)));
});

test('saved lists resolve @me, apply their own where, sort and search', async () => {
  const mine = await s.get('/list/mine');
  assert.ok(rows(mine.html).length >= 1);
  assert.match(mine.html, /My posts/);
  const quiet = await s.get('/list/quiet?q=Renamed');
  assert.ok(rows(quiet.html).every((r) => r.includes('Renamed')));
  assert.equal((await s.get('/list/ghost')).status, 404);
});

test('dashboard computes from the same rows the lists show', async () => {
  const d = await s.get('/dashboard/stats');
  const metric = (t) => Number(new RegExp(`<b>([\\d.]+)</b>${t}`).exec(d.html)[1]);
  const posts = rows((await s.get('/Post')).html).length;
  assert.equal(metric('Posts'), posts);
  assert.match(d.html, /<h3>By topic<\/h3>/);
  assert.match(d.html, /<h3>By mood<\/h3>/);
  assert.match(d.html, /Average rank/);
  assert.equal((await s.get('/dashboard/ghost')).status, 404);
});

test('failures are contained: unknown routes 404, a broken block 500, both traced', async () => {
  assert.equal((await s.get('/Ghost')).status, 404);
  assert.equal((await s.post('/Post/1/nonsense', {})).status, 303, 'an unknown sub-path falls through to update');
  const put = await fetch(`${s.base}/Post`, { method: 'PUT' });
  assert.equal(put.status, 404);
  const boom = await s.post('/action/boom', {});
  assert.equal(boom.status, 500);
  assert.match(boom.html, /Empty is empty/);
  assert.ok(s.trace().some((e) => e.kind === 'error'));
});

test('an invalid graph is served as an error page, not a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-bad-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, JSON.stringify({ app: 'bad', data: { A: { x: 'date!' } } }));
  const bad = await boot(file);
  try {
    assert.equal(bad.app.invalid, true);
    const r = await bad.get('/anything');
    assert.equal(r.status, 500);
    assert.match(r.html, /Graph is invalid/);
    assert.match(r.html, /unknown type &quot;date&quot;/, 'the checker output reaches the page, escaped');
  } finally { bad.close(); }
});

test('the trace records every effect with its kind', async () => {
  const kinds = new Set(s.trace().map((e) => e.kind));
  for (const k of ['create', 'update', 'delete', 'query', 'step', 'event', 'rejected', 'error'])
    assert.ok(kinds.has(k), `the trace has no "${k}" entries`);
  const step = s.trace().find((e) => e.kind === 'step' && e.block === 'db.toggle');
  assert.deepEqual(step.effects, ['db.write'], 'the trace carries the declared effects');
});
