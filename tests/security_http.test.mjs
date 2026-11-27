import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, tmpGraph } from './helpers.mjs';

const graph = {
  app: 'security', data: { User: { email: 'text!', password: 'password!', role: 'enum[admin,member]=member' }, Note: { title: 'text!' } },
  roles: { entity: 'User', login: 'email', password: 'password', role: 'role',
    register: 'member', anonymous: 'guest', can: { admin: '*', member: { Note: ['view'] }, guest: { Note: ['view'] } } },
  seed: { User: [{ email: 'admin@example.test', password: 'secret', role: 'admin' }] },
};

test('browser forms refuse foreign origins and retain the same-origin and CLI contracts', async () => {
  const s = await boot(tmpGraph(graph));
  try {
    const login = { login: 'admin@example.test', password: 'secret' };
    for (const headers of [{ origin: 'https://another.test' }, { referer: 'https://another.test/form' }, { 'sec-fetch-site': 'same-site' }]) {
      const denied = await fetch(s.base + '/login', { method: 'POST', redirect: 'manual', headers,
        body: new URLSearchParams(login) });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('set-cookie'), null);
    }
    const accepted = await s.post('/login', login, { origin: s.base, 'sec-fetch-site': 'same-origin' });
    assert.equal(accepted.status, 303);
    assert.equal((await s.post('/Note', { title: 'foreign' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await s.post('/Note', { title: 'local client' })).status, 303);
    assert.equal((await s.app.store.list('Note')).length, 1);
    const page = await s.get('/Note');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.equal((await fetch(s.base + '/login', { method: 'PUT' })).status, 404);
  } finally { s.close(); }
});

test('buffered form bodies are bounded and aborted request setup stays private', async () => {
  const s = await boot(tmpGraph(graph));
  try {
    await s.login('admin@example.test', 'secret');
    assert.equal((await s.post('/Note', { title: 'a'.repeat(1024 * 1024) })).status, 413);
    assert.deepEqual(await s.app.store.list('Note'), []);
    const malformed = await new Promise((resolve, reject) => {
      const req = http.get(s.base + '/', { headers: { host: 'invalid host' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(malformed, 400);
    s.app.store.get = () => { throw new Error('request setup detail'); };
    const failed = await s.get('/Note');
    assert.equal(failed.status, 500);
    assert.equal(failed.html, 'Internal server error');
    assert.ok(s.trace().some((e) => e.kind === 'error' && /request setup detail/.test(e.message)));
  } finally { s.close(); }
});
