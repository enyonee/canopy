// SEC1: a POST writes only what its form shows. A field the form does not offer — a default the app owns (a discount,
// a balance), a timestamp, a field the form fills, a related table without a form — is never set by posting it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, tmpGraph } from './helpers.mjs';

const json = { accept: 'application/json' };
const roles = (extra = {}) => ({ entity: 'User', login: 'email', password: 'password', role: 'role', register: 'customer', ...extra });
const user = async (s, email) => (await s.app.store.list('User', { where: { email } }))[0];

test('SEC1: /register shows only the fields without a default and writes nothing else, over HTML and JSON', async () => {
  const s = await boot(tmpGraph({
    app: 'reg', data: { User: { email: 'text!', password: 'password!', name: 'text!', nick: 'text', role: 'enum[admin,customer]=customer',
      balance: 'money=0', points: 'int=0', vip: 'bool=false', joined: 'time=now' } },
    roles: roles({ can: { admin: '*', customer: {} } }),
  }));
  try {
    const form = await s.get('/register');
    for (const f of ['email', 'password', 'name', 'nick']) assert.match(form.html, new RegExp(`name="${f}"`), f);
    for (const f of ['balance', 'points', 'vip', 'role', 'joined']) assert.doesNotMatch(form.html, new RegExp(`name="${f}"`), `${f} is the app's, not the visitor's`);
    const attack = { password: 'pw', name: 'E', nick: 'e', balance: '1000', points: '99999', vip: 'on', role: 'admin', joined: '2000-01-01T00:00:00.000Z' };
    const html = await s.post('/register', { email: 'h@reg', ...attack });
    assert.equal(html.status, 303);
    const viaJson = await s.post('/register', { email: 'j@reg', ...attack }, json);
    assert.equal(viaJson.status, 303);
    for (const email of ['h@reg', 'j@reg']) {
      const u = await user(s, email);
      assert.equal(u.nick, 'e', 'a shown optional field is written');
      assert.deepEqual([u.balance, u.points, u.vip, u.role], [0, 0, 0, 'customer'], `${email}: a posted default is dropped`);
      assert.notEqual(u.joined, attack.joined, `${email}: a timestamp is never posted`);
    }
    const bad = await s.post('/register', { email: 'h@reg', ...attack });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(bad.html, /name="balance"/, 'the re-rendered form still hides it');
    assert.doesNotMatch(bad.html, /99999/, 'and does not echo a dropped value');
  } finally { s.close(); }
});

test('SEC1: a declared User.form decides the sign-up fields — the register role\'s own list first — minus role, status and fill', async () => {
  const s = await boot(tmpGraph({
    app: 'reg2', data: { User: { email: 'text!', password: 'password!', name: 'text!', bio: 'text', team: 'ref:Team', score: 'int=0',
      tier: 'enum[free,gold]=free', role: 'enum[admin,customer,vendor]=customer', state: 'enum[new,ok]=new' }, Team: { name: 'text!' } },
    roles: roles({ can: { admin: '*', customer: {} } }),
    states: { User: { field: 'state', transitions: [{ name: 'approve', from: ['new'], to: 'ok', by: ['admin'] }] } },
    seed: { Team: [{ name: 'Red' }] },
    override: { 'User.form': { fields: ['email', 'password', 'name', 'bio', 'team', 'role', 'state', 'tier'], fill: { tier: 'gold' },
      byRole: { vendor: { fields: ['email', 'password', 'name', 'score'] }, customer: { fields: ['email', 'password', 'name', 'team', 'score', 'role', 'state', 'tier'] } } } },
  }));
  try {
    const form = await s.get('/register');
    for (const f of ['email', 'password', 'name', 'team', 'score']) assert.match(form.html, new RegExp(`name="${f}"`), f);
    assert.match(form.html, /Red/, 'a shown reference lists its options');
    for (const f of ['bio', 'role', 'state', 'tier']) assert.doesNotMatch(form.html, new RegExp(`name="${f}"`), f);
    const r = await s.post('/register', { email: 'c@reg', password: 'pw', name: 'C', team: '1', score: '7', bio: 'x', role: 'admin', state: 'ok', tier: 'gold' }, json);
    assert.equal(r.status, 303);
    const u = await user(s, 'c@reg');
    assert.deepEqual([u.team, u.score, u.bio, u.role, u.state, u.tier], ['1', 7, null, 'customer', 'new', 'free']);
  } finally { s.close(); }
});

test('SEC1: a create or edit never writes a timestamp, a derived value or a field the form fills, over HTML and JSON', async () => {
  const s = await boot(tmpGraph({
    app: 'w', data: { User: { email: 'text!', password: 'password!', role: 'enum[admin,m]=m' },
      Bid: { price: 'int!', placedAt: 'time=now', by: 'ref:User', note: 'text', twice: 'int := price * 2' } },
    roles: roles({ register: 'm', can: { admin: '*', m: { Bid: ['view', 'create', 'edit'] } } }),
    seed: { User: [{ email: 'other@w', password: 'x', role: 'm' }] },
    override: { 'Bid.form': { fill: { by: '@me' } } },
  }));
  try {
    await s.post('/register', { email: 'me@w', password: 'pw' });
    const me = (await user(s, 'me@w')).id, forged = '2000-01-01T00:00:00.000Z';
    for (const [i, extra] of [[1, {}], [2, json]]) {
      const r = await s.post('/Bid', { price: '5', placedAt: forged, by: '1', twice: '999' }, extra);
      assert.ok(r.status === 303 || r.status === 200, `create ${i}: ${r.status}`);
      const bid = await s.app.store.get('Bid', i);
      assert.notEqual(bid.placedAt, forged, 'the clock, not the client, says when');
      assert.deepEqual([bid.by, bid.twice], [String(me), 10]);
      const e = await s.post(`/Bid/${i}`, { price: '6', note: 'n', placedAt: forged, by: '1' }, extra);
      assert.ok(e.status === 303 || e.status === 200, `edit ${i}: ${e.status}`);
      const after = await s.app.store.get('Bid', i);
      assert.deepEqual([after.price, after.note, after.by], [6, 'n', String(me)], 'a filled field is not re-chosen on edit');
      assert.equal(after.placedAt, bid.placedAt);
    }
  } finally { s.close(); }
});

test('SEC1: a related table without a form takes no POST; `form: true` offers and takes every field', async () => {
  const s = await boot(tmpGraph({
    app: 'rel', data: { Trip: { name: 'text!' }, Note: { trip: 'ref:Trip!', body: 'text', secret: 'int=0' }, Seat: { trip: 'ref:Trip!', row: 'int=1', vip: 'int=0' } },
    seed: { Trip: [{ name: 'Rome' }] },
    override: { 'Trip.detail': { related: [{ entity: 'Note', via: 'trip', form: false }, { entity: 'Seat', via: 'trip', form: true }] } },
  }));
  try {
    const detail = await s.get('/Trip/1');
    assert.doesNotMatch(detail.html, /action="\/Trip\/1\/add\/Note"/, 'no add form is shown');
    assert.match(detail.html, /action="\/Trip\/1\/add\/Seat"/);
    for (const extra of [{}, json]) {
      const r = await s.post('/Trip/1/add/Note', { body: 'x', secret: '7' }, extra);
      assert.equal(r.status, 404, 'nothing to post to');
    }
    assert.equal((await s.app.store.list('Note', {})).length, 0);
    const seat = await s.post('/Trip/1/add/Seat', { row: '4', vip: '1' }, json);
    assert.equal(seat.status, 200, seat.html);
    const [made] = await s.app.store.list('Seat', {});
    assert.deepEqual([made.trip, made.row, made.vip], ['1', 4, 1], '`form: true` is every input of the child');
  } finally { s.close(); }
});
