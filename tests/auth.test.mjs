import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashPassword, isHashed, verifyPassword, sessions, permissions } from '../runtime/auth.mjs';

test('passwords are salted hashes that verify only against their own plain text', () => {
  const h = hashPassword('secret');
  assert.ok(isHashed(h));
  assert.notEqual(h, hashPassword('secret'), 'two hashes of the same password differ by salt');
  assert.equal(verifyPassword('secret', h), true);
  assert.equal(verifyPassword('Secret', h), false);
  assert.equal(verifyPassword('secret', 'secret'), false, 'a plain stored value never verifies');
  assert.equal(verifyPassword(null, h), false);
  assert.equal(verifyPassword(undefined, h), false);
  assert.equal(isHashed('scrypt$zz$yy'), false);
  assert.equal(isHashed(42), false);
  assert.equal(verifyPassword('x', `scrypt$${h.split('$')[1]}$abcd`), false, 'a hash of the wrong length never verifies');
});

test('sessions sign and verify, keep their key on disk, and read the cookie header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-auth-'));
  const keyFile = path.join(dir, 'session.key');
  const a = sessions(keyFile);
  assert.ok(fs.existsSync(keyFile), 'the key is written next to the database');
  const token = a.sign(7);
  assert.equal(a.verify(token), 7);
  assert.equal(a.verify('7.deadbeef'), null, 'a forged signature is rejected');
  assert.equal(a.verify('7'), null);
  assert.equal(a.verify(''), null);
  assert.equal(a.verify(null), null);
  assert.equal(a.verify(`${token}0`), null, 'a signature of the wrong length is rejected');
  const b = sessions(keyFile);
  assert.equal(b.verify(token), 7, 'a restart with the same key keeps sessions valid');
  assert.equal(a.read(`x=1; ag_session=${encodeURIComponent(token)}; y=2`), 7);
  assert.equal(a.read('x=1'), null);
  assert.equal(a.read(undefined), null);
  assert.match(a.setCookie(7), /^ag_session=.+; Path=\/; HttpOnly; SameSite=Lax$/);
  assert.match(a.clearCookie(), /Max-Age=0/);
  const c = sessions(null);
  assert.equal(c.verify(c.sign(1)), 1, 'without a key file the key lives in memory');
  assert.equal(c.verify(token), null, 'and differs from every other instance');
});

const graph = {
  roles: {
    entity: 'User', login: 'email', password: 'password', role: 'role', anonymous: 'guest',
    can: {
      admin: '*',
      sales: { Lead: { own: 'owner', can: ['view', 'create', 'edit', 'go:*'] }, Activity: ['view', 'do:log'], '*': ['view'] },
      guest: { Product: ['view'] },
      nobody: {},
    },
  },
};

test('the permission matrix: wildcards, per-entity operations, ownership and the anonymous role', () => {
  const p = permissions(graph);
  const admin = { id: 1, role: 'admin' }, sales = { id: 2, role: 'sales' }, nobody = { id: 3, role: 'nobody' };
  assert.equal(p.enabled, true);
  assert.equal(p.roleOf(admin), 'admin');
  assert.equal(p.roleOf(null), 'guest', 'no session means the anonymous role');
  assert.equal(p.isAdmin(admin), true);
  assert.equal(p.isAdmin(sales), false);
  assert.equal(p.can(admin, 'Anything', 'delete'), true);
  assert.equal(p.can(sales, 'Lead', 'view'), true);
  assert.equal(p.can(sales, 'Lead', 'delete'), false);
  assert.equal(p.can(sales, 'Lead', 'go:win'), true, 'go:* covers every transition');
  assert.equal(p.can(sales, 'Activity', 'do:log'), true);
  assert.equal(p.can(sales, 'Activity', 'do:other'), false);
  assert.equal(p.can(sales, 'Company', 'view'), true, '"*" is the fallback entity');
  assert.equal(p.can(sales, 'Company', 'edit'), false);
  assert.equal(p.can(sales, 'Lead', 'view', { owner: 2 }), true);
  assert.equal(p.can(sales, 'Lead', 'view', { owner: '2' }), true, 'ids compare as strings');
  assert.equal(p.can(sales, 'Lead', 'edit', { owner: 9 }), false, 'own rows only');
  assert.equal(p.can(sales, 'Lead', 'create', { owner: 9 }), true, 'create is not scoped by a row');
  assert.equal(p.ownField(sales, 'Lead'), 'owner');
  assert.equal(p.ownField(sales, 'Activity'), null);
  assert.equal(p.ownField(admin, 'Lead'), null);
  assert.equal(p.can(null, 'Product', 'view'), true, 'a guest may look at products');
  assert.equal(p.can(null, 'Lead', 'view'), false);
  assert.equal(p.can(nobody, 'Lead', 'view'), false, 'a role with no entry has no rights');
  assert.equal(p.can({ id: 4, role: 'ghost' }, 'Lead', 'view'), false, 'an unknown role has no rights');
  assert.equal(p.canSee(sales, { roles: ['sales'] }), true);
  assert.equal(p.canSee(sales, { roles: ['admin'] }), false);
  assert.equal(p.canSee(sales, {}), true, 'no roles list means everyone');
  assert.equal(p.canSee(null, { roles: ['guest'] }), true);
  const ownGuest = permissions({ roles: { ...graph.roles, can: { guest: { Lead: { own: 'owner', can: ['view'] } } } } });
  assert.equal(ownGuest.can(null, 'Lead', 'view', { owner: 1 }), false, 'an anonymous viewer owns nothing');
});

test('without /roles everything is allowed and nothing is scoped', () => {
  const p = permissions({});
  assert.equal(p.enabled, false);
  assert.equal(p.can(null, 'X', 'delete'), true);
  assert.equal(p.ownField(null, 'X'), null);
  assert.equal(p.canSee(null, { roles: ['admin'] }), true);
  assert.equal(p.isAdmin(null), false);
  const noAnon = permissions({ roles: { ...graph.roles, anonymous: undefined } });
  assert.equal(noAnon.roleOf(null), null);
  assert.equal(noAnon.can(null, 'Product', 'view'), false, 'without an anonymous role a guest has no rights');
});
