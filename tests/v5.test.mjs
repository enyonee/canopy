// Round R4 (the orchestrator's remediation batch, not the format's own "round
// N"): the 13 format gaps the 40 WebGen-Bench apps hit most. One rich fixture
// graph exercises the wiring end to end; small standalone graphs cover the
// checker messages a full boot would not reach.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate, formatErrors } from '../runtime/validate.mjs';
import { parse, check as checkExpr, evaluate } from '../runtime/expr.mjs';
import { FUNCTIONS } from '../runtime/functions.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { boot, rows, tmpGraph, tmpDir } from './helpers.mjs';

const graph = {
  app: 'v5', theme: { accent: 'navy' },
  data: {
    User: { email: 'text!', password: 'password!', role: 'enum[admin,member]=member', loginCount: 'int=0' },
    Profile: { user: 'ref:User!', bio: 'text?', viewedNotes: 'int=0' },
    Note: { profile: 'ref:Profile!', body: 'text!', views: 'int=0' },
    Order: { customer: 'ref:User!', amount: 'money=0', note: 'text?', archived: 'bool=false', code: "text := concat('ORD-', id)" },
    Message: { sender: 'ref:User!', recipient: 'ref:User!', body: 'text!' },
    Doc: { title: 'text!', attachment: 'file!' },
    Follow: { follower: 'ref:User!', category: 'text!' },
    Photo: { caption: 'text?', image: 'image?' },
    Shift: { start: 'time!', end: 'time!', durationHours: 'int := hours(end, start)', durationMinutes: 'int := minutes(end, start)' },
  },
  seed: {
    User: [{ email: 'admin@v5', password: 'pw', role: 'admin' }],
    Photo: [{ caption: 'Cover', image: { from: 'seed-photo.txt' } }],
  },
  roles: {
    entity: 'User', login: 'email', password: 'password', role: 'role', register: 'member', anonymous: 'guest',
    can: {
      admin: '*',
      guest: { Doc: ['view'] },
      member: {
        User: ['view'], Profile: ['view', 'create', 'edit'],
        Note: { own: 'profile.user', can: ['view', 'edit', 'create'] },
        Order: { own: 'customer', can: ['create', 'edit'], all: ['view'] },
        Message: { own: ['sender', 'recipient'], can: ['view', 'create'] },
        Doc: ['view', 'create', 'edit'], Follow: ['view', 'create', 'edit'], Photo: ['view'], Shift: ['view'],
      },
    },
  },
  actions: [{ name: 'archive', in: 'Order', title: 'Archive', by: ['member'], do: [{ block: 'db.toggle', field: 'archived' }] }],
  events: [
    { on: 'User.login', do: [{ block: 'db.update', set: { loginCount: '= loginCount + 1' } }] },
    { on: 'Note.viewed', do: [
      { block: 'db.update', set: { views: '= views + 1' } },
      { block: 'db.set', entity: 'Profile', id: '@row.profile', set: { bio: '@row.body' } },
    ] },
  ],
  rules: { Follow: [{ unique: ['follower', 'category'], message: 'Already following this category' }] },
  lists: [
    { id: 'recentOrders', entity: 'Order', title: 'Recent Orders', columns: ['note', 'amount'], roles: ['admin', 'member'] },
    { id: 'myMessages', entity: 'Message', title: 'My Messages', columns: ['body'], roles: ['member'] },
    { id: 'myNotes', entity: 'Note', title: 'My Notes', columns: ['body'], roles: ['member'] },
  ],
  pages: [{ id: 'home', title: 'Home', heading: 'Welcome', body: ['Some intro.'],
    sections: [{ text: 'A quick note.' }, { list: 'recentOrders', limit: 3 }, { form: 'Doc' }] }],
  search: { entities: ['Order', 'Doc'], title: 'Find' },
  override: {
    'Order.list': { search: ['note'], rowActions: ['view', 'edit', 'archive'] },
    'Order.detail': { actions: ['archive'] },
    'Order.form': { fields: ['amount', 'note'], byRole: { admin: { fields: ['amount', 'note', 'customer'] } } },
    'Doc.list': { search: ['title'] },
    'Follow.form': { fields: ['category'], fill: { follower: '@me' } },
    'Profile.detail': { related: [{ entity: 'Note', via: 'profile', title: 'Notes', form: [], fill: { body: '@row.bio' } }] },
  },
};

const graphFile = tmpGraph(graph);
fs.writeFileSync(path.join(path.dirname(graphFile), 'seed-photo.txt'), 'fake image bytes, not a real photo');
const s = await boot(graphFile);
after(() => s.close());

let memberId = null, member2Id = null;

test('item 11: a seeded file/image is copied into files/ at boot', async () => {
  const photo = s.app.store.get('Photo', 1);
  assert.match(photo.image, /seed-photo\.txt$/);
  await s.login('admin@v5', 'pw');
  const f = await s.get('/file/Photo/1/image');
  assert.equal(f.status, 200);
  s.asGuest();
});

test('item 1: own with "all" — view is unscoped, create/edit stay owned', async () => {
  await s.post('/register', { email: 'alice@v5', password: 'pw', name: 'a' });
  memberId = s.app.store.list('User', { where: { email: 'alice@v5' } })[0].id;
  const order = await s.post('/Order', { amount: '10', note: 'alice order' });
  assert.equal(order.status, 303, order.html);
  const formA = await s.get('/Order/new');
  assert.doesNotMatch(formA.html, /name="customer"/, 'own field is never on a member\'s form');

  s.asGuest();
  await s.post('/register', { email: 'bob@v5', password: 'pw', name: 'b' });
  member2Id = s.app.store.list('User', { where: { email: 'bob@v5' } })[0].id;
  // "view" is in "all": bob sees alice's order (and the whole list) despite not owning it.
  assert.equal((await s.get('/Order/1')).status, 200, 'view is unscoped by "all"');
  assert.equal(rows((await s.get('/Order')).html).length, 1, 'the list shows every order too — "all" is not narrowed');
  // "edit"/"create" stay owned: bob may not edit alice's order.
  assert.equal((await s.post('/Order/1', { amount: '99', note: 'hijack' })).status, 403);
  assert.doesNotMatch((await s.get('/Order/1')).html, /<a class="btn" href="\/Order\/1\/edit">/, 'no edit button on a row bob does not own');
});

test('item 2: a "by"-gated row action renders no button for a non-owner, and the POST agrees', async () => {
  s.asGuest(); await s.login('alice@v5', 'pw');
  const mine = await s.get('/Order');
  assert.match(mine.html, />Archive</, 'alice owns order 1: the button renders');
  const detail = await s.get('/Order/1');
  assert.match(detail.html, /action="\/Order\/1\/action\/archive"/);
  s.asGuest(); await s.login('bob@v5', 'pw');
  const theirs = await s.get('/Order');
  assert.doesNotMatch(theirs.html, />Archive</, 'bob does not own order 1: "view" being unscoped does not lift the action\'s own scope');
  assert.equal((await s.post('/Order/1/action/archive', {})).status, 403, 'the handler agrees with the button');
  assert.equal((await s.get('/Order/1')).html.includes('action="/Order/1/action/archive"'), false, 'detailView agrees too');
  s.asGuest(); await s.login('alice@v5', 'pw');
  assert.equal((await s.post('/Order/1/action/archive', {})).status, 303, 'the owner may run it');
});

test('item 10: byRole replaces the default field list, for rendering and writability', async () => {
  s.asGuest(); await s.login('admin@v5', 'pw');
  const form = await s.get('/Order/new');
  assert.match(form.html, /name="customer"/, 'admin\'s byRole adds "customer"');
  const created = await s.post('/Order', { amount: '5', note: 'admin-made', customer: String(memberId) });
  assert.equal(created.status, 303, created.html);
  const row = s.app.store.raw('Order', s.app.store.list('Order', { sort: { field: 'id', dir: 'desc' } })[0].id);
  assert.equal(String(row.customer), String(memberId), 'admin could set an arbitrary customer through byRole\'s field list');
  s.asGuest(); await s.login('alice@v5', 'pw');
  const memberForm = await s.get('/Order/new');
  assert.doesNotMatch(memberForm.html, /name="customer"/, 'a member keeps the default field list');
});

test('item 3: a related fill reads the parent row (@row.*)', async () => {
  s.asGuest(); await s.login('alice@v5', 'pw');
  const profileId = s.app.store.insert('Profile', { user: memberId, bio: 'parent bio value', viewedNotes: 0 });
  const added = await s.post(`/Profile/${profileId}/add/Note`, {});
  assert.equal(added.status, 303, added.html);
  const notes = s.app.store.list('Note', { where: { profile: profileId } });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, 'parent bio value', '"@row.bio" resolved against the parent Profile row, not nothing');
});

test('item 4: a compound unique rule falls back to the existing row for an untouched field', async () => {
  s.asGuest(); await s.login('alice@v5', 'pw');
  const f1 = await s.post('/Follow', { category: 'sports' });
  assert.equal(f1.status, 303, f1.html);
  const f2 = await s.post('/Follow', { category: 'tech' });
  assert.equal(f2.status, 303, f2.html);
  const dupe = await s.post('/Follow', { category: 'sports' });
  assert.equal(dupe.status, 400);
  assert.match(dupe.html, /Already following this category/);
  const b2 = s.app.store.list('Follow', { where: { category: 'tech' } })[0].id;
  // Editing only "category" (the form never shows "follower") still collides on the pair,
  // using the existing row's own follower — this is the fallback interp.mjs's "probe" gives.
  const editDupe = await s.post(`/Follow/${b2}`, { category: 'sports' });
  assert.equal(editDupe.status, 400);
  assert.match(editDupe.html, /Already following this category/);
});

test('item 5/8: db.set + a "viewed" event write inside the GET, best-effort, still shows the page', async () => {
  const profileId = s.app.store.insert('Profile', { user: memberId, bio: '', viewedNotes: 0 });
  const noteId = s.app.store.insert('Note', { profile: profileId, body: 'a secret note', views: 0 });
  s.asGuest(); await s.login('alice@v5', 'pw');
  const first = await s.get(`/Note/${noteId}`);
  assert.equal(first.status, 200);
  assert.match(first.html, /<th>Views<\/th><td>1<\/td>/, 'the viewed event ran before the page rendered');
  await s.get(`/Note/${noteId}`);
  assert.equal(s.app.store.get('Note', noteId).views, 2, 'a second view counts again');
  assert.equal(s.app.store.get('Profile', profileId).bio, 'a secret note', 'db.set wrote an arbitrary row (Profile) from @row.*');
});

test('item 1 (one-hop own): a different member cannot reach a note through someone else\'s profile', async () => {
  const profileId = s.app.store.insert('Profile', { user: memberId, bio: 'x', viewedNotes: 0 });
  const noteId = s.app.store.insert('Note', { profile: profileId, body: 'still secret', views: 0 });
  s.asGuest(); await s.login('bob@v5', 'pw');
  assert.equal((await s.get(`/Note/${noteId}`)).status, 403);
  assert.equal(rows((await s.get('/list/myNotes')).html).length, 0, 'a one-hop own list shows none of it either');
  s.asGuest(); await s.login('alice@v5', 'pw');
  assert.equal((await s.get(`/Note/${noteId}`)).status, 200);
  assert.ok(rows((await s.get('/list/myNotes')).html).length >= 1, 'and shows the owner\'s own notes');
});

test('item 1 (several own fields, OR): a message is owned by its sender or its recipient', async () => {
  const m = await s.post('/Message', { recipient: String(member2Id), body: 'hi bob' });
  assert.equal(m.status, 303, m.html);
  s.asGuest(); await s.login('bob@v5', 'pw');
  assert.equal(rows((await s.get('/list/myMessages')).html).length, 1, 'bob is the recipient, not the sender, and still owns it');
  s.asGuest(); await s.login('admin@v5', 'pw');
  const third = await s.post('/register', { email: 'carol@v5', password: 'pw', name: 'c' });
  void third;
  s.asGuest(); await s.login('carol@v5', 'pw');
  assert.equal(rows((await s.get('/list/myMessages')).html).length, 0, 'carol is neither: sees nothing');
});

test('item 6: page sections — text, an embedded saved list, and an embedded create form', async () => {
  s.asGuest(); await s.login('alice@v5', 'pw');
  const home = await s.get('/page/home');
  assert.match(home.html, /A quick note\./);
  assert.match(home.html, /Recent Orders/);
  assert.match(home.html, /action="\/Doc"/, 'the embedded form posts to the normal route');
  const posted = await s.post('/Doc', {}); // no file — item 13 covers the required-upload error itself
  assert.equal(posted.status, 400);
  s.asGuest();
  const guestHome = await s.get('/page/home');
  assert.doesNotMatch(guestHome.html, /action="\/Doc"/, 'a viewer without "create" on Doc gets no embedded form');
});

test('item 7: /search finds rows by each entity\'s own search fields, scoped by permission', async () => {
  await s.post('/Doc', {}); // still nothing valid; search must still work over what does exist
  s.asGuest(); await s.login('admin@v5', 'pw');
  await s.post('/Order', { amount: '1', note: 'zebra crossing', customer: String(memberId) });
  const found = await s.get('/search?q=zebra');
  assert.equal(found.status, 200);
  assert.match(found.html, /zebra crossing|1\.00/);
  const noQuery = await s.get('/search');
  assert.doesNotMatch(noQuery.html, /zebra crossing/, 'no query means no results, not everything');
  s.asGuest();
  const guestSearch = await s.get('/search?q=zebra');
  assert.doesNotMatch(guestSearch.html, /zebra crossing/, 'a guest without "view" on Order gets no Order results from search');
  s.asGuest(); await s.login('admin@v5', 'pw');
  const order = await s.get('/Order');
  assert.match(order.html, /placeholder="Find"/, 'the header search box is present');
  // JSON: the same query, decided by "accept" like every other route (item 7's route reuses it).
  const loginRes = await fetch(`${s.base}/login`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login: 'admin@v5', password: 'pw' }).toString() });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const jsonFound = await fetch(`${s.base}/search?q=zebra`, { headers: { accept: 'application/json', cookie } });
  assert.equal(jsonFound.status, 200);
  const body = await jsonFound.json();
  const orderResult = body.results.find((r) => r.entity === 'Order');
  assert.ok(orderResult.rows.some((r) => r.note === 'zebra crossing'));
});

test('item 8: a login event runs inside its own row (row = the signed-in user)', async () => {
  s.asGuest();
  const before = s.app.store.list('User', { where: { email: 'alice@v5' } })[0].loginCount;
  await s.login('alice@v5', 'pw');
  const after1 = s.app.store.list('User', { where: { email: 'alice@v5' } })[0].loginCount;
  assert.equal(after1, before + 1);
});

test('item 9: hours()/minutes() over a full timestamp', async () => {
  const id = s.app.store.insert('Shift', { start: '2026-01-01T10:00:00.000Z', end: '2026-01-01T13:00:00.000Z' });
  s.asGuest(); await s.login('admin@v5', 'pw');
  const d = await s.get(`/Shift/${id}`);
  assert.match(d.html, /<th>Duration Hours<\/th><td>3<\/td>/);
  assert.match(d.html, /<th>Duration Minutes<\/th><td>180<\/td>/);
});

test('item 12: an expression may read "id"', async () => {
  const row = s.app.store.get('Order', 1);
  assert.equal(row.code, 'ORD-1');
});

test('item 13: a required file with an empty upload is a validation error, on create and on edit', async () => {
  s.asGuest(); await s.login('alice@v5', 'pw');
  const empty = await s.upload('/Doc', { title: 'no file' });
  assert.equal(empty.status, 400);
  assert.match(empty.html, /attachment is required/);
  const real = await s.upload('/Doc', { title: 'has file' }, { field: 'attachment', content: 'bytes', name: 'a.txt' });
  assert.equal(real.status, 303, real.html);
  const docId = s.app.store.list('Doc', { sort: { field: 'id', dir: 'desc' } })[0].id;
  // A real browser always submits the <input type=file>'s part, empty or not
  // (an unselected file is still a zero-byte part, not a missing key) — mimic
  // that here rather than simply omitting "attachment".
  const editBlank = await s.upload(`/Doc/${docId}`, { title: 'renamed' }, { field: 'attachment', content: '', name: '' });
  assert.equal(editBlank.status, 400, 'leaving a required file blank on edit is refused, not silently kept');
  assert.match(editBlank.html, /attachment is required/);
});

test('item 13: an optional upload left blank on edit keeps the old value', async () => {
  s.asGuest(); await s.login('admin@v5', 'pw');
  const before = s.app.store.get('Photo', 1).image;
  const edited = await s.upload('/Photo/1', { caption: 'still cover' });
  assert.equal(edited.status, 303, edited.html);
  assert.equal(s.app.store.get('Photo', 1).image, before);
});

// ---------------------------------------------------------------------------
// Checker-only edges a full boot cannot reach without a second, invalid graph.
// ---------------------------------------------------------------------------
test('checker: own — several fields, a one-hop path, and the errors around both', () => {
  const base = { app: 'x', data: { User: { name: 'text!' }, Profile: { user: 'ref:User!' }, Note: { profile: 'ref:Profile!', body: 'text!' },
    Message: { sender: 'ref:User!', recipient: 'ref:User!', body: 'text!' } },
    roles: { entity: 'User', login: 'name', password: 'name', role: 'name', can: {} } };
  // password/role must really be the right kinds — reuse a minimal valid shape below instead.
  const g = (can) => ({ app: 'x',
    data: { User: { name: 'text!', pass: 'password!', role: 'enum[m]=m' }, Profile: { user: 'ref:User!' },
      Note: { profile: 'ref:Profile!', body: 'text!' }, Message: { sender: 'ref:User!', recipient: 'ref:User!', body: 'text!' } },
    roles: { entity: 'User', login: 'name', password: 'pass', role: 'role', can: { m: can } } });
  void base;
  assert.deepEqual(validate(g({ Message: { own: ['sender', 'recipient'], can: ['view'] } })), []);
  assert.deepEqual(validate(g({ Note: { own: 'profile.user', can: ['view'] } })), []);
  const badHop = validate(g({ Note: { own: 'profile.user.extra', can: ['view'] } }));
  assert.ok(badHop.some((e) => /more than one hop/.test(e.message)), formatErrors(badHop));
  const notRef = validate(g({ Note: { own: 'body', can: ['view'] } }));
  assert.ok(notRef.some((e) => /ref:User/.test(e.message)));
  const badFirstHop = validate(g({ Note: { own: 'nope.user', can: ['view'] } }));
  assert.ok(badFirstHop.some((e) => /does not exist/.test(e.message)));
  const wildOwn = validate(g({ '*': { own: 'name', can: ['view'] } }));
  assert.ok(wildOwn.some((e) => /needs a concrete entity/.test(e.message)));
  const emptyOwn = validate(g({ Message: { own: [], can: ['view'] } }));
  assert.ok(emptyOwn.some((e) => /at least one field/.test(e.message)));
  const badAll = validate(g({ Message: { can: ['view'], all: ['nonsense'] } }));
  assert.ok(badAll.some((e) => /unknown operation/.test(e.message)));
});

test('checker: byRole needs a real role and a "fields" array', () => {
  const g = (byRole) => ({ app: 'x', data: { E: { name: 'text!' } },
    override: { 'E.form': { fields: ['name'], byRole } } });
  assert.deepEqual(validate(g({})), []);
  const noRole = validate(g({ ghost: { fields: ['name'] } }));
  assert.ok(noRole.some((e) => /is not a role/.test(e.message)));
});

test('checker: pages.sections — exactly one key, a known list, a positive limit, a real entity', () => {
  const g = (sections) => ({ app: 'x', data: { E: { name: 'text!' } }, lists: [{ id: 'l', entity: 'E' }],
    pages: [{ id: 'p', title: 'P', sections }] });
  assert.deepEqual(validate(g([{ text: 'hi' }])), []);
  assert.deepEqual(validate(g([{ list: 'l', limit: 5 }])), []);
  assert.deepEqual(validate(g([{ form: 'E' }])), []);
  assert.ok(validate(g([{}])).some((e) => /needs one of/.test(e.message)));
  assert.ok(validate(g([{ text: 'a', list: 'l' }])).some((e) => /exactly one of/.test(e.message)));
  assert.ok(validate(g([{ list: 'nope' }])).some((e) => /unknown list/.test(e.message)));
  assert.ok(validate(g([{ list: 'l', limit: 0 }])).some((e) => /positive integer/.test(e.message)));
  assert.ok(validate(g([{ form: 'Ghost' }])).some((e) => /unknown entity/.test(e.message)));
  assert.ok(validate(g([{ text: 42 }])).some((e) => /text must be a string/.test(e.message)));
});

test('checker: /search needs entities, and a real title type', () => {
  const g = (search) => ({ app: 'x', data: { E: { name: 'text!' } }, search });
  assert.deepEqual(validate(g({ entities: ['E'] })), []);
  assert.ok(validate(g({ entities: [] })).some((e) => /non-empty array/.test(e.message)));
  assert.ok(validate(g({ entities: ['Ghost'] })).some((e) => /unknown entity/.test(e.message)));
  assert.ok(validate(g({ entities: ['E'], title: 3 })).some((e) => /title must be a string/.test(e.message)));
});

test('checker: events — login only on the roles entity, viewed on any entity', () => {
  const g = (on) => ({ app: 'x', data: { E: { name: 'text!' }, User: { name: 'text!', pass: 'password!', role: 'enum[m]=m' } },
    roles: { entity: 'User', login: 'name', password: 'pass', role: 'role', can: { m: {} } },
    events: [{ on, do: [] }] });
  assert.deepEqual(validate(g('User.login')), []);
  assert.deepEqual(validate(g('E.viewed')), []);
  const wrongEntity = validate(g('E.login'));
  assert.ok(wrongEntity.some((e) => /fires on the roles entity/.test(e.message)));
  const badTrigger = validate(g('E.bogus'));
  assert.ok(badTrigger.some((e) => /unsupported trigger/.test(e.message)));
});

test('checker: seed { "from": … } only on a file/image field, and needs a real path', () => {
  const g = (v) => ({ app: 'x', data: { P: { name: 'text!', photo: 'image?' } }, seed: { P: [{ name: 'x', photo: v }] } });
  assert.deepEqual(validate(g({ from: 'a.jpg' })), []);
  const wrongField = validate({ app: 'x', data: { P: { name: 'text!' } }, seed: { P: [{ name: { from: 'a.jpg' } }] } });
  assert.ok(wrongField.some((e) => /only a file or image field/.test(e.message)));
  const noFrom = validate(g({}));
  assert.ok(noFrom.some((e) => /needs "from"/.test(e.message)));
});

test('checker: db.set validates "entity", "id" and every "set" field against it', () => {
  const g = (step) => ({ app: 'x', data: { A: { n: 'int!' }, B: { n: 'int!' } },
    events: [{ on: 'A.created', do: [step] }] });
  assert.deepEqual(validate(g({ block: 'db.set', entity: 'B', id: '@row.n', set: { n: 1 } })), []);
  const badField = validate(g({ block: 'db.set', entity: 'B', id: '@row.n', set: { ghost: 1 } }));
  assert.ok(badField.some((e) => /does not exist on B/.test(e.message)));
});

test('checker: rules.unique may be a compound array', () => {
  const g = (unique) => ({ app: 'x', data: { F: { a: 'text!', b: 'text!' } }, rules: { F: [{ unique, message: 'dup' }] } });
  assert.deepEqual(validate(g(['a', 'b'])), []);
  assert.ok(validate(g([])).some((e) => /at least one field/.test(e.message)));
  assert.ok(validate(g(['a', 'ghost'])).some((e) => /does not exist/.test(e.message)));
});

test('item 16 (checker): "null" is only meaningful on "ne"', () => {
  const g = (cmp) => ({ app: 'x', data: { E: { n: 'int?' } }, lists: [{ id: 'l', entity: 'E', where: { n: cmp } }] });
  assert.deepEqual(validate(g({ ne: null })), []);
  const bad = validate(g({ gte: null }));
  assert.ok(bad.some((e) => /is never true/.test(e.message)), formatErrors(bad));
});

// ---------------------------------------------------------------------------
// Pure functions: hours()/minutes() kind-checking and null propagation.
// ---------------------------------------------------------------------------
test('hours()/minutes(): reject non-time arguments, and null propagates', () => {
  assert.equal(FUNCTIONS.hours.run(['2026-01-01T12:00:00.000Z', '2026-01-01T10:00:00.000Z']), 2);
  assert.equal(FUNCTIONS.minutes.run(['2026-01-01T12:30:00.000Z', '2026-01-01T12:00:00.000Z']), 30);
  assert.equal(FUNCTIONS.hours.run([null, '2026-01-01T10:00:00.000Z']), null);
  const scope = { field: () => 'number' };
  assert.throws(() => checkExpr(parse('hours(a, b)', FUNCTIONS), scope, FUNCTIONS), /hours\(\) needs times/);
  const dateScope = { field: () => 'date' };
  assert.doesNotThrow(() => checkExpr(parse('hours(a, b)', FUNCTIONS), dateScope, FUNCTIONS));
});

test('item 14: a created event fires for a row a block makes (db.createRow, on another entity)', async () => {
  const g = {
    app: 'blockcreate',
    data: { Order: { n: 'int=0' }, Log: { note: 'text!' } },
    events: [{ on: 'Order.created', do: [{ block: 'db.createRow', entity: 'Log', values: { note: 'an order was made' } }] },
      { on: 'Log.created', do: [{ block: 'db.update', set: { note: '= concat(note, \'!\')' } }] }],
  };
  const s2 = await boot(tmpGraph(g));
  try {
    const r = await s2.post('/Order', { n: '1' });
    assert.equal(r.status, 303, r.html);
    assert.equal(s2.app.store.count('Log'), 1, 'db.createRow\'s own created event fired too');
    assert.equal(s2.app.store.get('Log', 1).note, 'an order was made!', 'Log.created ran (its own "current row" set, not Order\'s)');
  } finally { s2.close(); }
});

test('item 14 (direct): fireEvents refuses past the nesting limit instead of recursing forever', async () => {
  const g = {
    app: 'cycle2',
    data: { Foo: { n: 'int=0' } },
    events: [{ on: 'Foo.created', do: [{ block: 'db.createRow', entity: 'Foo', values: { n: 1 } }] }],
  };
  const s2 = await boot(tmpGraph(g));
  try {
    const r = await s2.post('/Foo', { n: '1' });
    assert.equal(r.status, 400, 'the cycle is refused, not left to recurse forever');
    assert.match(r.html, /too many nested &quot;created&quot; events/);
    assert.equal(s2.app.store.count('Foo'), 0, 'the whole action rolled back, including every nested create');
  } finally { s2.close(); }
});

test('item 14 (settles): a "created" event that db.ensures a fixed default row settles after one extra round', async () => {
  const g = {
    app: 'settles',
    data: { Foo: { category: 'text!' } },
    events: [{ on: 'Foo.created', do: [{ block: 'db.ensure', entity: 'Foo', where: { category: 'default' } }] }],
  };
  const s2 = await boot(tmpGraph(g));
  try {
    const r = await s2.post('/Foo', { category: 'special' });
    assert.equal(r.status, 303, r.html);
    assert.equal(s2.app.store.count('Foo'), 2, 'the original row plus exactly one default row');
    const again = await s2.post('/Foo', { category: 'special-2' });
    assert.equal(again.status, 303);
    assert.equal(s2.app.store.count('Foo'), 3, 'the default row is found, not remade, from then on');
  } finally { s2.close(); }
});

test('item 15: Entity.form\'s confirm/confirmEdit interpolate the just-written row', async () => {
  const g = {
    app: 'confirms',
    data: { Task: { title: 'text!' } },
    override: { 'Task.form': { confirm: '{row.title} was created as #{id}', confirmEdit: 'now called {row.title}' } },
  };
  const s2 = await boot(tmpGraph(g));
  try {
    const created = await s2.post('/Task', { title: 'Write docs' });
    assert.match(created.location, /ok=Write%20docs%20was%20created%20as%20%231/);
    const edited = await s2.post('/Task/1', { title: 'Ship it' });
    assert.match(edited.location, /ok=now%20called%20Ship%20it/);
  } finally { s2.close(); }
});

// ---------------------------------------------------------------------------
// Items 16-19: more gaps confirmed by app agents, addressed after 1-15.
// ---------------------------------------------------------------------------
const widgetDir = tmpDir('ag-r4-widget-');
const cardsPlugin = path.join(widgetDir, 'cards.mjs');
fs.writeFileSync(cardsPlugin, `export default {
  widgets: { cards: { summary: 'shows hole cards', client: './cards.client.mjs', props: ['fen'] } },
};`);
fs.writeFileSync(path.join(widgetDir, 'cards.client.mjs'), 'export default function mount() {}\n');

const graph1719 = {
  app: 'r1719', plugins: [cardsPlugin],
  data: {
    User: { email: 'text!', password: 'password!', role: 'enum[admin,member]=member' },
    // "code" (not "holeCards") is deliberately the first plain-text field: a row's label
    // (store.label()) always reads the first text field, and "private" does not cover
    // that path — a private field must never double as the entity's own label.
    Hand: { code: 'text!', player: 'ref:User!', holeCards: 'text?', note: 'text?' },
    Feedback: { message: 'text!' },
  },
  roles: { entity: 'User', login: 'email', password: 'password', role: 'role', register: 'member',
    can: { admin: '*', member: { Hand: ['view', 'create', 'do:annotate'], '*': ['do:sendFeedback'] } } },
  actions: [
    { name: 'annotate', in: 'Hand', title: 'Annotate', fields: ['note'], do: [{ block: 'db.update', set: { note: '@values.note' } }] },
    { name: 'sendFeedback', title: 'Send feedback', fields: ['message'], do: [{ block: 'db.createRow', entity: 'Feedback', values: { message: '@values.message' } }] },
  ],
  override: { 'Hand.detail': { private: { holeCards: 'player' }, widget: { use: 'cards', fen: '@row.holeCards' }, actions: ['annotate'] } },
  pages: [{ id: 'home', title: 'Home', actions: ['sendFeedback'] }],
  lists: [{ id: 'dealt', entity: 'Hand', title: 'Dealt', where: { holeCards: { ne: null } }, roles: ['admin', 'member'] }],
};

test('item 17: a private field is redacted from everyone but the user it names (and admins), everywhere', async () => {
  const s2 = await boot(tmpGraph(graph1719));
  try {
    await s2.post('/register', { email: 'alice@r1719', password: 'pw' });
    const aliceId = s2.app.store.list('User', { where: { email: 'alice@r1719' } })[0].id;
    const handId = s2.app.store.insert('Hand', { code: 'H1', player: aliceId, holeCards: 'AsKs' });
    const asAlice = await s2.get(`/Hand/${handId}`);
    assert.match(asAlice.html, /<th>Hole Cards<\/th><td>AsKs<\/td>/, 'the owner sees their own hole cards');
    assert.match(asAlice.html, /data-widget="cards"[^>]*data-props='[^']*AsKs/, 'the widget prop resolved "@row.holeCards" for the owner');
    s2.asGuest(); await s2.post('/register', { email: 'bob@r1719', password: 'pw' });
    const asBob = await s2.get(`/Hand/${handId}`);
    assert.match(asBob.html, /<th>Hole Cards<\/th><td><span class="muted">Hidden<\/span><\/td>/, 'a different member never sees it');
    assert.doesNotMatch(asBob.html, /AsKs/, 'not even inside the widget\'s props');
    const loginBob = await fetch(`${s2.base}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ login: 'bob@r1719', password: 'pw' }).toString() });
    const cookie = (loginBob.headers.get('set-cookie') || '').split(';')[0];
    const jsonBob = await (await fetch(`${s2.base}/Hand/${handId}`, { headers: { accept: 'application/json', cookie } })).json();
    assert.equal(jsonBob.holeCards, null, 'JSON redacts it too');
  } finally { s2.close(); }
});

test('item 19: row and global actions render a real input form for declared "fields", and require them', async () => {
  const s2 = await boot(tmpGraph(graph1719));
  try {
    await s2.post('/register', { email: 'carol@r1719', password: 'pw' });
    const carolId = s2.app.store.list('User', { where: { email: 'carol@r1719' } })[0].id;
    const handId = s2.app.store.insert('Hand', { code: 'H2', player: carolId, holeCards: '2h2c' });
    const detail = await s2.get(`/Hand/${handId}`);
    assert.match(detail.html, new RegExp(`<form class="card inline-block" method="post" action="/Hand/${handId}/action/annotate">[\\s\\S]*name="note"`), 'the row action gets a real field, not a bare button');
    const missing = await s2.post(`/Hand/${handId}/action/annotate`, {});
    assert.equal(missing.status, 400);
    assert.match(missing.html, /note is required/);
    const ok = await s2.post(`/Hand/${handId}/action/annotate`, { note: 'strong hand' });
    assert.equal(ok.status, 303);
    assert.equal(s2.app.store.get('Hand', handId).note, 'strong hand');
    const home = await s2.get('/page/home');
    assert.match(home.html, /<form class="card" method="post" action="\/action\/sendFeedback">[\s\S]*name="message"/, 'the global action gets a real field too');
    const noMsg = await s2.post('/action/sendFeedback', {});
    assert.equal(noMsg.status, 400);
    const sent = await s2.post('/action/sendFeedback', { message: 'great app' });
    assert.equal(sent.status, 303);
    assert.equal(s2.app.store.list('Feedback', {}).length, 1);
    assert.equal(s2.app.store.list('Feedback', {})[0].message, 'great app');
  } finally { s2.close(); }
});

test('item 16 + item 19 (list): "ne: null" filters a saved list, admin sees only dealt hands', async () => {
  const s2 = await boot(tmpGraph(graph1719));
  try {
    await s2.post('/register', { email: 'dana@r1719', password: 'pw' });
    const danaId = s2.app.store.list('User', { where: { email: 'dana@r1719' } })[0].id;
    s2.app.store.insert('Hand', { code: 'H3', player: danaId }); // holeCards omitted: a real NULL, not the text "null"
    s2.app.store.insert('Hand', { code: 'H4', player: danaId, holeCards: 'JhJd' });
    const dealt = await s2.get('/list/dealt');
    assert.equal(rows(dealt.html).length, 1, 'only the hand with real hole cards is "dealt"');
  } finally { s2.close(); }
});

test('checker: item 17/18 edges — private needs roles and a real ref field; @row.* needs a row and a real field', async () => {
  const g = (override) => ({ app: 'x',
    data: { U: { name: 'text!', pass: 'password!', role: 'enum[m]=m' }, E: { owner: 'ref:U!', secretish: 'text?' } },
    roles: { entity: 'U', login: 'name', password: 'pass', role: 'role', can: { m: {} } },
    override });
  assert.deepEqual(validate(g({ 'E.detail': { private: { secretish: 'owner' } } })), []);
  const badOwner = validate(g({ 'E.detail': { private: { secretish: 'nope' } } }));
  assert.ok(badOwner.some((e) => /does not exist/.test(e.message)));
  const noRoles = validate({ app: 'x', data: { E: { owner: 'ref:E!' } }, override: { 'E.detail': { private: { owner: 'owner' } } } });
  assert.ok(noRoles.some((e) => /no \/roles declared/.test(e.message)));
  const rowGraph = { app: 'x', data: { E: { n: 'text!' } }, plugins: [cardsPlugin],
    pages: [{ id: 'p', title: 'P', widget: { use: 'cards', fen: '@row.n' } }] };
  const { registry } = await loadPlugins(rowGraph, path.dirname(cardsPlugin));
  const noRow = validate(rowGraph, registry);
  assert.ok(noRow.some((e) => /needs a row/.test(e.message)), formatErrors(noRow));
});

test('checker: item 19 edges — row action fields are typed against the entity, global action fields just need a name', () => {
  const g = (a) => ({ app: 'x', data: { E: { n: 'text!' } }, actions: [a] });
  assert.deepEqual(validate(g({ name: 'a', in: 'E', fields: ['n'], do: [{ block: 'db.update', set: { n: '@values.n' } }] })), []);
  const badField = validate(g({ name: 'a', in: 'E', fields: ['ghost'], do: [{ block: 'db.update', set: { n: '1' } }] }));
  assert.ok(badField.some((e) => /does not exist/.test(e.message)));
  assert.deepEqual(validate(g({ name: 'a', fields: ['msg'], do: [{ block: 'db.update', set: { n: '1' } }, { block: 'db.createRow', entity: 'E', values: { n: '@values.msg' } }] })), []);
  const notArray = validate(g({ name: 'a', fields: 'oops', do: [{ block: 'db.update', set: { n: '1' } }] }));
  assert.ok(notArray.some((e) => /must be an array/.test(e.message)));
});

test('checker: a derived field may read "id", but not hop through it', () => {
  const g = (src) => ({ app: 'x', data: { E: { code: `text := ${src}` } } });
  assert.deepEqual(validate(g("concat('X-', id)")), []);
  const bad = validate(g('id.x'));
  assert.ok(bad.some((e) => /cannot read/.test(e.message)), formatErrors(bad));
});
