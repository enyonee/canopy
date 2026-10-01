// The v2 surface end to end: roles and sessions, ownership, derived fields,
// rules, transitions, actions, events, the outbox, files, filters and dashboards.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, rows, flash, tmpGraph } from './helpers.mjs';

const s = await boot('tests/fixtures/v2.json');
after(() => s.close());
const lastCall = () => s.net.calls[s.net.calls.length - 1];
let memberId = null;

test('a guest sees what the anonymous role allows and is sent to login for the rest', async () => {
  const home = await s.get('/');
  assert.equal(home.status, 303); assert.equal(home.location, '/Project');
  const list = await s.get('/Project');
  assert.equal(list.status, 200);
  assert.match(list.html, /href="\/login"/); assert.match(list.html, /href="\/register"/);
  assert.doesNotMatch(list.html, /Add Project/, 'a guest cannot create');
  assert.doesNotMatch(list.html, /href="\/list\/mine"/, 'a role-gated list is not in the menu');
  assert.doesNotMatch(list.html, /href="\/outbox"/);
  assert.doesNotMatch(list.html, /href="\/User"/, 'entities the role cannot view are not in the menu');
  assert.equal((await s.get('/Project/new')).location, '/login?next=%2FProject%2Fnew');
  assert.equal((await s.post('/Project', { name: 'x' })).status, 403, 'a POST is refused, not redirected');
  for (const p of ['/list/mine', '/dashboard/d', '/page/about', '/outbox', '/Expense']) assert.match((await s.get(p)).location, /^\/login\?next=/, p);
  assert.equal((await s.get('/register')).status, 200);
  assert.equal((await s.get('/list/nope')).status, 404);
  assert.equal((await s.get('/page/nope')).status, 404);
  assert.equal((await s.get('/dashboard/nope')).status, 404);
});

test('registration validates, signs the member in, keeps the flash across the home redirect and refuses a duplicate', async () => {
  const form = await s.get('/register');
  assert.match(form.html, /type="password"/); assert.doesNotMatch(form.html, /name="role"/, 'the role is never chosen by the visitor');
  const empty = await s.post('/register', {});
  assert.equal(empty.status, 400); assert.match(empty.html, /email is required/); assert.match(empty.html, /password is required/);
  const r = await s.post('/register', { email: 'm@v2', password: 'pw', name: 'M' });
  assert.equal(r.status, 303); assert.match(r.location, /^\/\?ok=Welcome/);
  const home = await s.get(r.location);
  assert.equal(home.location, '/Project?ok=Welcome%2C%20m%40v2', 'the flash survives the home redirect');
  const list = await s.get('/Project');
  assert.match(list.html, /Signed in as m@v2 \(member\)/);
  assert.match(list.html, /href="\/list\/mine"/);
  assert.match(list.html, /Add Project/);
  const dup = await s.post('/register', { email: 'm@v2', password: 'x', name: 'again' });
  assert.equal(dup.status, 400); assert.match(dup.html, /email is already registered/);
  memberId = (await s.app.store.list('User', { where: { email: 'm@v2' } }))[0].id;
  assert.equal(s.trace().filter((e) => e.kind === 'register').length, 1);
});

test('login answers 401 on a wrong password, honours a safe "next" only, and logout clears the session', async () => {
  s.asGuest();
  assert.equal((await s.get('/login')).status, 200);
  const bad = await s.post('/login', { login: 'm@v2', password: 'nope' });
  assert.equal(bad.status, 401); assert.match(bad.html, /Wrong login or password/); assert.match(bad.html, /value="m@v2"/, 'the login is kept in the form');
  assert.equal((await s.post('/login', { login: 'ghost@v2', password: 'x' })).status, 401);
  const ok = await s.post('/login', { login: 'm@v2', password: 'pw', next: '/list/mine' });
  assert.equal(ok.status, 303); assert.match(ok.location, /^\/list\/mine\?ok=/);
  const evil = await s.post('/login', { login: 'm@v2', password: 'pw', next: 'http://evil.test' });
  assert.match(evil.location, /^\/\?ok=/, 'an absolute next is ignored');
  const out = await s.post('/logout', {});
  assert.equal(out.status, 303); assert.match(out.location, /Signed%20out/);
  assert.match((await s.get('/Project')).html, /href="\/login"/, 'signed out');
  assert.ok(s.trace().some((e) => e.kind === 'login' && e.ok === false));
  assert.ok(s.trace().some((e) => e.kind === 'logout'));
});

test('a member creates a project that is theirs; rules and uniqueness answer 400; other members see nothing of it', async () => {
  await s.login('m@v2', 'pw');
  const form = await s.get('/Project/new');
  assert.doesNotMatch(form.html, /name="owner"/, 'the owner comes from the session');
  assert.doesNotMatch(form.html, /name="status"/, 'the status belongs to the transitions');
  assert.match(form.html, /type="date"/); assert.match(form.html, /step="0.01"/); assert.match(form.html, /type="file"/); assert.match(form.html, /enctype="multipart\/form-data"/);
  const r = await s.post('/Project', { name: 'Alpha', budget: '100' });
  assert.equal(r.status, 303); assert.equal(r.location, '/Project/1?ok=Project%20saved%20successfully');
  const d = await s.get('/Project/1');
  for (const re of [/<th>Owner<\/th><td><a href="\/User\/\d+">m@v2<\/a>/, /<th>Label<\/th><td>Alpha \(draft\)<\/td>/, /<th>Spent<\/th><td>0\.00<\/td>/,
    /<th>Left<\/th><td>100\.00<\/td>/, /<th>Over<\/th><td>No<\/td>/, /<th>Age<\/th><td>0<\/td>/, /status">Draft/]) assert.match(d.html, re);
  assert.match(d.html, /action="\/Project\/1\/go\/activate"/, 'the transition form is offered');
  assert.match(d.html, /name="budget"/, 'with its field');
  assert.doesNotMatch(d.html, /go\/close"/, 'a transition for another role is not');
  const dup = await s.post('/Project', { name: 'Alpha' });
  assert.equal(dup.status, 400); assert.match(dup.html, /name is already taken/);
  const neg = await s.post('/Project', { name: 'Neg', budget: '-1' });
  assert.equal(neg.status, 400); assert.match(neg.html, /Budget cannot be negative/);
  assert.equal((await s.post('/Project', { name: 'Bad', budget: 'abc' })).status, 400);
  assert.equal((await s.post('/Project', { name: 'Bad', start: '12/12/2026' })).status, 400, 'a date must be ISO');
  assert.equal(rows((await s.get('/list/mine')).html).length, 1);
  s.asGuest();
  await s.post('/register', { email: 'n@v2', password: 'pw', name: 'N' });
  assert.equal(rows((await s.get('/Project')).html).length, 0, 'own rows only');
  assert.equal((await s.get('/Project/1')).status, 403);
  assert.equal((await s.get('/Project/1/edit')).status, 403);
  assert.equal((await s.post('/Project/1', { name: 'Hijack' })).status, 403);
  assert.equal((await s.post('/Project/1/delete', {})).status, 403);
  assert.equal((await s.post('/Project/1/go/activate', { budget: '1' })).status, 403);
  assert.equal((await s.post('/Project/1/action/spend', {})).status, 403);
  assert.equal((await s.post('/Project/1/add/Expense', { amount: '1' })).status, 403);
  assert.equal((await s.get('/Project/999')).status, 404);
  assert.equal((await s.get('/Project/999/edit')).status, 404);
  assert.equal((await s.post('/Project/999', {})).status, 404);
  s.asGuest(); await s.login('m@v2', 'pw');
  assert.equal((await s.post('/Project/1/nonsense', {})).status, 404, 'an unknown sub-path on a real row');
  s.asGuest(); await s.login('n@v2', 'pw');
  assert.ok(s.trace().some((e) => e.kind === 'denied'));
});

test('expenses drive derived fields; creation fires an http event; editing lands back on the project', async () => {
  s.asGuest(); await s.login('m@v2', 'pw');
  const zero = await s.post('/Project/1/add/Expense', { amount: '0' });
  assert.equal(zero.status, 400); assert.match(zero.html, /Amount must be positive/);
  assert.equal((await s.post('/Project/1/add/Ghost', {})).status, 404);
  const r = await s.follow('/Project/1/add/Expense', { amount: '150', note: 'x' });
  assert.match(r.html, /<th>Spent<\/th><td>150\.00<\/td>/); assert.match(r.html, /<th>Left<\/th><td>-50\.00<\/td>/); assert.match(r.html, /<th>Over<\/th><td>Yes<\/td>/);
  assert.match(r.html, /<td>150\.00<\/td><td>[^<]*<\/td><td>Yes<\/td>/, 'the related row shows the derived big flag');
  const call = lastCall();
  assert.equal(call.url, 'http://sink.test/hook'); assert.equal(call.headers['x-k'], '1');
  assert.deepEqual(call.body, { expense: 1, amount: 150, big: true, project: 'Alpha' });
  const edit = await s.post('/Expense/1', { amount: '50' });
  assert.equal(edit.location, '/Project/1?ok=Expense%20updated%20successfully', 'afterEdit resolves {project}');
  const d = await s.get('/Project/1');
  assert.match(d.html, /<th>Spent<\/th><td>50\.00<\/td>/); assert.match(d.html, /<th>Over<\/th><td>No<\/td>/);
  assert.equal((await s.post('/Expense/1', { amount: '' })).status, 400, 'a required money field cannot be blanked');
});

test('updated and deleted events fire with the row; the outbox records the letter and the hook', async () => {
  const r = await s.post('/Project/1', { name: 'Alpha', budget: '100' });
  assert.equal(r.status, 303);
  const mail = (await s.app.store.outbox({ kind: 'mail' }))[0];
  assert.equal(mail.target, 'm@v2'); assert.equal(mail.payload.subject, 'Updated Alpha'); assert.equal(mail.status, 'sent');
  await s.post('/Project', { name: 'Beta' });
  const del = await s.post('/Project/2/delete', {});
  assert.equal(del.status, 303);
  assert.equal(lastCall().url, 'http://sink.test/hook/deleted'); assert.deepEqual(lastCall().body, { name: 'Beta' });
  assert.equal((await s.get('/Project/2')).status, 404);
});

test('transitions: required fields, confirmation with money, effects, 409 on a spent step, "by" roles and 404s', async () => {
  const missing = await s.post('/Project/1/go/activate', {});
  assert.equal(missing.status, 400); assert.match(missing.html, /budget is required/);
  const r = await s.post('/Project/1/go/activate', { budget: '200' });
  assert.equal(r.status, 303); assert.equal(r.location, '/Project/1?ok=Alpha%20active%20with%20200.00');
  assert.deepEqual(lastCall().body, { project: 1, budget: 200, owner: 'm@v2' });
  const active = await s.get('/Project/1');
  assert.match(active.html, /status">Active/);
  assert.doesNotMatch(active.html, /go\/close"/, 'a transition another role owns is not offered even when the status fits');
  assert.equal((await s.post('/Project/1/go/activate', { budget: '1' })).status, 409);
  assert.equal((await s.post('/Project/1/go/close', {})).status, 403, 'close is for admins');
  assert.equal((await s.post('/Project/1/go/reopen', {})).status, 403);
  assert.equal((await s.get('/Project/1/go/close')).status, 404, 'a GET is not a transition');
  assert.equal((await s.post('/Project/1/go/nope', {})).status, 404);
  assert.equal((await s.post('/Expense/1/go/nope', {})).status, 404, 'an entity without states has no transitions');
  s.asGuest(); await s.login('root@v2', 'root');
  const adminView = await s.get('/Project/1');
  assert.match(adminView.html, /go\/close"/); assert.doesNotMatch(adminView.html, /go\/freeze"/, '"by" excludes even a role with every right');
  assert.equal((await s.post('/Project/1/go/freeze', {})).status, 403, 'and the server agrees');
  const closed = await s.post('/Project/1/go/close', {});
  assert.equal(closed.location, '/Project/1?ok=Project%20is%20now%20closed');
  const letter = (await s.app.store.outbox({ kind: 'mail' }))[0];
  assert.equal(letter.payload.subject, 'Closed Alpha'); assert.equal(letter.payload.text, 'Spent 50.00 of 200.00'); assert.equal(letter.payload.from, 'v2@test');
  assert.equal((await s.post('/Project/1/go/reopen', {})).status, 303, 'from "*" reopens from anywhere');
  assert.match((await s.get('/Project/1')).html, /status">Draft/);
  assert.ok(s.trace().some((e) => e.kind === 'transition' && e.name === 'close' && e.from === 'active'));
});

test('actions: global with "*" rights, row actions with "by", ensure/each/adjust, and refusals answer 400', async () => {
  const bump = await s.post('/Project/1/action/bump', {});
  assert.equal(bump.status, 303, 'the admin may bump');
  assert.match((await s.get('/Project/1')).html, /<th>Budget<\/th><td>210\.00<\/td>/);
  s.asGuest(); await s.login('m@v2', 'pw');
  assert.equal((await s.post('/Project/1/action/bump', {})).status, 403, 'bump is by admin');
  assert.equal((await s.post('/Project/1/action/nope', {})).status, 404);
  const ping = await s.post('/action/ping', {});
  assert.equal(ping.status, 303); assert.match(ping.location, /^\/Project\?ok=pinged%20\d+$/);
  assert.equal(lastCall().url, 'http://sink.test/hook/ping');
  assert.equal(lastCall().body.who, memberId); assert.match(lastCall().body.at, /T/); assert.match(lastCall().body.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(lastCall().body.email, 'm@v2', '@me.field reads the session user'); assert.equal(lastCall().body.upper, 'M', 'and so does me.field in an expression');
  const spend = await s.post('/Project/1/action/spend', {});
  assert.equal(spend.location, '/Project/1?ok=spent%20on%20auto%20(new%3A%20true)');
  assert.match((await s.get('/Project/1')).html, /<th>Budget<\/th><td>209\.40<\/td>/, 'the expense was count(Expense) + 5 = 6; each adjusted the budget by -amount/10 in money');
  const again = await s.post('/Project/1/action/spend', { amount: '99' });
  assert.match(again.location, /new%3A%20false/, 'ensure found the row and did not create another');
  assert.match((await s.get('/Project/1')).html, /<th>Budget<\/th><td>208\.80<\/td>/);
  const clone = await s.post('/Project/1/action/clone', {});
  assert.match(decodeURIComponent(clone.location), /^\/Project\/1\?ok=expense \d+ added to Alpha, budget 209\.80$/, 'after db.createRow the current row is still the action\'s row (the created id is not the row id)');
  const drain = await s.post('/Project/1/action/drain', {});
  assert.equal(drain.status, 400); assert.match(drain.html, /Budget cannot go below zero/);
  assert.match((await s.get('/Project/1')).html, /<th>Budget<\/th><td>209\.80<\/td>/, 'the refused adjustment was rolled back');
  const boom = await s.post('/action/boom', {});
  assert.equal(boom.status, 400); assert.match(boom.html, /db.adjust: no Project #999/);
  assert.equal((await s.post('/action/nope', {})).status, 404);
  s.asGuest();
  assert.equal((await s.post('/action/ping', {})).status, 403, 'a guest has no do:ping');
  assert.ok(s.trace().filter((e) => e.kind === 'refused').length >= 2);
});

test('files: multipart upload, download with the original name, and every 404', async () => {
  await s.login('m@v2', 'pw');
  const up = await s.upload('/Project/1', { name: 'Alpha', budget: '209' }, { field: 'attachment', name: 'plan v1.txt', content: 'hello' });
  assert.equal(up.status, 303);
  const list = await s.get('/Project');
  assert.match(list.html, /<a href="\/file\/Project\/1\/attachment">plan_v1.txt<\/a>/);
  const file = await s.get('/file/Project/1/attachment');
  assert.equal(file.status, 200); assert.equal(file.html, 'hello');
  assert.equal(file.headers.get('content-disposition'), 'attachment; filename="plan_v1.txt"');
  const keep = await s.upload('/Project/1', { name: 'Alpha' }, { field: 'attachment', name: 'empty.txt', content: '' });
  assert.equal(keep.status, 303);
  assert.equal((await s.get('/file/Project/1/attachment')).html, 'hello', 'an empty upload keeps the old file');
  assert.equal((await s.get('/file/Project/1/nope')).status, 404);
  assert.equal((await s.get('/file/Project/1/name')).status, 404, 'not a file field');
  assert.equal((await s.get('/file/Ghost/1/attachment')).status, 404);
  assert.equal((await s.get('/file/Project/999/attachment')).status, 404);
  assert.equal((await s.get('/file/Project/1')).status, 404);
  s.asGuest();
  assert.equal((await s.get('/file/Project/1/attachment')).status, 200, 'a guest may view, so may download');
  await s.login('n@v2', 'pw');
  assert.equal((await s.get('/file/Project/1/attachment')).status, 403, 'another member owns nothing here');
  const stored = (await s.app.store.raw('Project', 1)).attachment;
  fs.unlinkSync(path.join(s.dir, 'files', stored));
  s.asGuest(); await s.login('m@v2', 'pw');
  assert.equal((await s.get('/file/Project/1/attachment')).status, 404, 'missing on disk');
  const gone = await s.post('/Project/1', { name: 'Alpha', attachment: '' });
  assert.equal(gone.status, 303);
});

test('list filters: enum, bool, date range, money range and search', async () => {
  await s.post('/Project', { name: 'Gamma', budget: '5', start: '2000-06-01' });
  const all = await s.get('/Project');
  assert.equal(rows(all.html).length, 2);
  assert.match(all.html, /name="start_from"/); assert.match(all.html, /name="budget_from"/);
  assert.equal(rows((await s.get('/Project?status=draft')).html).length, 2);
  assert.equal(rows((await s.get('/Project?status=active')).html).length, 0);
  assert.equal(rows((await s.get('/Project?over=0')).html).length, 2);
  assert.equal(rows((await s.get('/Project?over=1')).html).length, 0);
  assert.equal(rows((await s.get('/Project?start_from=2000-01-01&start_to=2000-12-31')).html).length, 1);
  assert.equal(rows((await s.get('/Project?start_from=2001-01-01')).html).length, 1);
  assert.equal(rows((await s.get('/Project?start_to=1999-12-31')).html).length, 0);
  assert.equal(rows((await s.get('/Project?budget_from=100')).html).length, 1);
  assert.equal(rows((await s.get('/Project?budget_to=10')).html).length, 1);
  assert.equal(rows((await s.get('/Project?q=gam')).html).length, 1);
  assert.match((await s.get('/Project?start_from=2000-01-01')).html, /value="2000-01-01"/, 'the range form keeps its values');
  const mine = await s.get('/list/mine');
  assert.equal(rows(mine.html).length, 2);
  assert.ok(rows(mine.html)[0].includes('Gamma'), 'sorted by the derived "left" ascending');
});

test('the admin dashboard: derived sums, month buckets, in-memory grouping, @me and the period filter', async () => {
  s.asGuest(); await s.login('root@v2', 'root');
  const d = await s.get('/dashboard/d');
  assert.equal(d.status, 200);
  assert.match(d.html, /<b>57\.00<\/b>Spent/);
  assert.match(d.html, /<b>0<\/b>Mine/, '@me resolves to the admin, who owns nothing');
  assert.match(d.html, /<b>157\.00<\/b>Left/, 'a sum over a derived money field');
  const month = new Date().toISOString().slice(0, 7);
  assert.match(d.html, new RegExp(`<td>${month}</td><td>57\\.00</td>`));
  assert.match(d.html, /<td>No<\/td><td>2<\/td><td>57\.00<\/td><td>78\.50<\/td><td>5\.00<\/td><td>152\.00<\/td>/, 'count, sum, avg, min, max over derived fields');
  assert.match(d.html, /<td>Draft<\/td><td>2<\/td>/);
  const past = await s.get('/dashboard/d?from=2000-01-01&to=2000-12-31');
  assert.match(past.html, /<b>0\.00<\/b>Spent/, 'no expenses in 2000');
  assert.match(past.html, /<td>Draft<\/td><td>1<\/td>/, 'one project started in 2000');
  assert.match(past.html, /value="2000-01-01"/);
  const from = await s.get('/dashboard/d?from=2001-01-01');
  assert.match(from.html, /<td>Draft<\/td><td>1<\/td>/);
  assert.equal((await s.get('/page/about')).status, 200);
  assert.match((await s.get('/Project')).html, /href="\/outbox"/);
  assert.equal((await s.get('/User')).status, 200);
  assert.doesNotMatch((await s.get('/User/1')).html, /scrypt/, 'a hash never reaches a page');
  assert.match((await s.get('/User/1/edit')).html, /type="password" id="f_password" name="password" value=""/);
  assert.equal((await s.post('/User/1', { name: 'Root', password: '' })).status, 303);
  s.asGuest();
  assert.equal((await s.login('root@v2', 'root')).status, 303, 'an empty password on edit keeps the old one');
  assert.equal((await s.post('/User/1', { password: 'r00t' })).status, 303);
  s.asGuest();
  assert.equal((await s.login('root@v2', 'root')).status, 401);
  assert.equal((await s.login('root@v2', 'r00t')).status, 303);
});

test('the outbox page lists deliveries; a failed one is retried; unknown ids are 404', async () => {
  const page = await s.get('/outbox');
  assert.equal(page.status, 200);
  assert.match(page.html, /<td>mail<\/td>/); assert.match(page.html, /<td>http<\/td>/); assert.match(page.html, /status">sent<\/span> 200/);
  assert.equal((await s.post('/outbox/999/retry', {})).status, 404);
  s.net.state.status = 500;
  s.asGuest(); await s.login('m@v2', 'pw');
  await s.post('/Project/1/add/Expense', { amount: '1', note: 'fails' });
  s.net.state.status = 200;
  s.asGuest(); await s.login('root@v2', 'r00t');
  let out = await s.get('/outbox');
  const top = rows(out.html)[0];
  assert.match(top, /status">failed<\/span> 500/); assert.match(top, /HTTP 500/); assert.match(top, /action="\/outbox\/(\d+)\/retry"/);
  const id = /\/outbox\/(\d+)\/retry/.exec(top)[1];
  const retry = await s.post(`/outbox/${id}/retry`, {});
  assert.equal(retry.status, 303); assert.match(decodeURIComponent(retry.location), /retried: sent/);
  out = await s.get('/outbox');
  assert.match(rows(out.html)[0], /status">sent<\/span> 200/);
  assert.doesNotMatch(rows(out.html)[0], /retry/, 'a sent delivery offers no retry');
});

test('a role with no rights is signed in and still gets nowhere', async () => {
  s.asGuest(); await s.login('none@v2', 'none');
  const home = await s.get('/');
  assert.equal(home.status, 403); assert.match(home.html, /Nothing here for your role/);
  assert.equal((await s.get('/Project')).status, 403);
  assert.equal((await s.get('/list/mine')).status, 403);
  assert.equal((await s.post('/action/ping', {})).status, 403);
});

test('the trace names every kind of thing that happened', async () => {
  const kinds = new Set(s.trace().map((e) => e.kind));
  for (const k of ['login', 'logout', 'register', 'denied', 'transition', 'delivery', 'refused', 'dashboard', 'rejected', 'event', 'step', 'create', 'update', 'delete', 'query'])
    assert.ok(kinds.has(k), `no "${k}" in the trace`);
});

test('a form that is landed on shows the flash; a related table shows only the viewer\'s own rows', async () => {
  const g = await boot(tmpGraph({
    app: 'g', data: { User: { email: 'text!', password: 'password!', role: 'enum[m]=m' }, Trip: { name: 'text!' }, Booking: { trip: 'ref:Trip!', who: 'ref:User', seat: 'int=1' } },
    roles: { entity: 'User', login: 'email', password: 'password', role: 'role', register: 'm',
      can: { m: { Trip: ['view', 'create'], Booking: { own: 'who', can: ['view', 'create'] } } } },
    seed: { Trip: [{ name: 'Rome' }] },
    override: { 'Trip.form': { after: '/Trip/new', confirm: 'Saved, add another' }, 'Trip.detail': { related: [{ entity: 'Booking', via: 'trip', columns: ['seat', 'who'], form: ['seat'] }] } },
  }));
  try {
    await g.post('/register', { email: 'a@g', password: 'a' });
    const landed = await g.follow('/Trip', { name: 'Oslo' });
    assert.match(landed.html, /class="flash">Saved, add another/, 'the form page renders the flash it was landed on with');
    assert.match(landed.html, /name="name"/);
    await g.post('/Trip/1/add/Booking', { seat: 7 });
    g.asGuest();
    await g.post('/register', { email: 'b@g', password: 'b' });
    await g.post('/Trip/1/add/Booking', { seat: 9 });
    const seenByB = await g.get('/Trip/1');
    assert.match(seenByB.html, /<td>9<\/td>/); assert.doesNotMatch(seenByB.html, /<td>7<\/td>/, "the related table hides another user's rows");
    assert.match(seenByB.html, /1 item\(s\)/);
  } finally { g.close(); }
});

test('a block that refuses inside a created/updated/deleted event answers 400 and rolls the write back', async () => {
  const g = await boot(tmpGraph({
    app: 'ev', data: { Stock: { name: 'text!', units: 'int=1' }, Sale: { stock: 'ref:Stock!', qty: 'int=1', note: 'text' } },
    seed: { Stock: [{ name: 'Cups', units: 1 }] },
    events: [
      { on: 'Sale.created', do: [{ block: 'db.adjust', entity: 'Stock', id: '@row.stock', field: 'units', by: '= -qty', min: 0, message: 'Not enough units' }] },
      { on: 'Sale.updated', do: [{ block: 'db.adjust', entity: 'Stock', id: '@row.stock', field: 'units', by: -100, min: 0, message: 'No edits after stock is gone' }] },
      { on: 'Sale.deleted', do: [{ block: 'db.adjust', entity: 'Stock', id: 999, field: 'units', by: 1 }] },
    ],
    override: { 'Stock.detail': { related: [{ entity: 'Sale', via: 'stock', form: ['qty'] }] } },
  }));
  try {
    const big = await g.post('/Sale', { stock: 1, qty: 5 });
    assert.equal(big.status, 400); assert.match(big.html, /Not enough units/); assert.match(big.html, /name="qty"/, 'the form comes back with the message');
    assert.equal(await g.app.store.count('Sale'), 0, 'the sale was rolled back with the refused adjustment');
    const viaRelated = await g.post('/Stock/1/add/Sale', { qty: 5 });
    assert.equal(viaRelated.status, 400); assert.match(viaRelated.html, /Not enough units/);
    assert.equal((await g.post('/Sale', { stock: 1, qty: 1 })).status, 303);
    assert.equal((await g.app.store.get('Stock', 1)).units, 0);
    const edit = await g.post('/Sale/1', { note: 'x' });
    assert.equal(edit.status, 400); assert.match(edit.html, /No edits after stock is gone/);
    assert.equal((await g.app.store.get('Sale', 1)).note, null, 'the edit was rolled back');
    const del = await g.post('/Sale/1/delete', {});
    assert.equal(del.status, 400); assert.match(del.html, /no Stock #999/);
    assert.equal(await g.app.store.count('Sale'), 1, 'the delete was rolled back');
  } finally { g.close(); }
});

test('without an anonymous role the home page itself asks for a login; pages and dashboards can be the home', async () => {
  const strict = await boot(tmpGraph({
    app: 'strict', data: { User: { email: 'text!', password: 'password!', role: 'enum[a]=a' }, T: { n: 'text' } },
    roles: { entity: 'User', login: 'email', password: 'password', role: 'role', can: { a: { T: ['view'] } } },
    seed: { User: [{ email: 'a@x', password: 'a' }] },
    pages: [{ id: 'p', title: 'P' }],
  }));
  try {
    assert.equal((await strict.get('/')).location, '/login?next=%2F');
    assert.match((await strict.get('/register')).location, /^\/login/, 'no self-registration without "register"');
    await strict.login('a@x', 'a');
    assert.equal((await strict.get('/')).location, '/page/p', 'the first visible page is the home');
    assert.equal((await strict.get('/T')).status, 200);
  } finally { strict.close(); }
  const dashOnly = await boot(tmpGraph({
    app: 'dash', data: { User: { email: 'text!', password: 'password!', role: 'enum[a]=a' }, T: { n: 'text' } },
    roles: { entity: 'User', login: 'email', password: 'password', role: 'role', can: { a: {} } },
    seed: { User: [{ email: 'a@x', password: 'a' }] },
    dashboards: [{ id: 'd', title: 'D', cards: [{ title: 'n', entity: 'T', fn: 'count' }] }],
  }));
  try {
    await dashOnly.login('a@x', 'a');
    assert.equal((await dashOnly.get('/')).location, '/dashboard/d', 'a dashboard is the home when nothing else is visible');
    assert.match((await dashOnly.get('/dashboard/d')).html, /<b>0<\/b>n/);
  } finally { dashOnly.close(); }
});
