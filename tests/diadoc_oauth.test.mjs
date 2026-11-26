import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { diadocProvider } from '../bridges/oauth-connectors/diadoc.mjs';
import { createBridge } from '../bridges/oauth-connectors/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { loadDescriptor } from './replay.mjs';

const boxId = '01234567-89ab-4cde-8f01-23456789abcd';
const messageId = '11234567-89ab-4cde-8f01-23456789abcd';
const entityId = '21234567-89ab-4cde-8f01-23456789abcd';
const redirectUri = 'https://merchant.example.test/callback';
const dataToken = 'diadoc-fixture-data-token-value', adminToken = 'diadoc-fixture-admin-token-value';
const after = 'fixture+next/index=';

async function start(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const send = (url, token, body = {}) => fetch(url, { method: 'POST',
  headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });

test('Diadoc reads only incoming document metadata from the configured box', async (t) => {
  const provider = diadocProvider({ boxId, clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri });
  const values = new Map(), calls = [];
  const secrets = { current: (name) => values.get(name), set: (name, value) => values.set(name, value) };
  const invoice = { MessageId: messageId, EntityId: entityId, DocumentDirection: 'Inbound', DocumentType: 'Invoice',
    DocumentNumber: '41', DocflowStatus: { PrimaryStatus: { StatusText: 'Awaiting signature' } },
    IndexKey: 'fixture-next', Content: { Data: 'never store' } };
  const fields = { messageId, entityId, type: 'Invoice', number: '41', status: 'Awaiting signature' };
  const { data, admin } = createBridge({ dataToken, adminToken, providers: [provider], secrets,
    fetchImpl: async (url, init) => {
      assert.equal(init.redirect, 'manual');
      if (url === 'https://identity.kontur.ru/connect/token') {
        assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), {
          grant_type: 'authorization_code', code: 'fixture-code', redirect_uri: redirectUri,
          client_id: 'fixture-client', client_secret: 'fixture-secret',
        });
        return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
      }
      assert.equal(init.headers.authorization, 'Bearer fixture-access');
      assert.equal(init.headers.accept, 'application/json');
      const u = new URL(url);
      assert.equal(u.origin, 'https://diadoc-api.kontur.ru');
      assert.equal(u.searchParams.get('boxId'), boxId);
      calls.push(u.pathname);
      if (u.pathname === '/V4/GetDocuments') {
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { DocumentCategory: 'Inbound', SortDirection: 'Descending',
          Count: '1', AfterIndexKey: after });
        return Response.json({ TotalCount: 3, Documents: [invoice] });
      }
      assert.equal(u.pathname, '/V3/GetDocument');
      assert.equal(init.method, 'GET');
      assert.deepEqual(Object.fromEntries(u.searchParams), { boxId, messageId, entityId });
      return Response.json(calls.length === 3 ? { ...invoice, DocumentDirection: 'Outbound' } : invoice);
    } });
  const [base, adm] = await Promise.all([start(data), start(admin)]);
  t.after(() => Promise.all([data, admin].map((server) => new Promise((resolve) => server.close(resolve)))));
  const auth = new URL((await (await send(adm + '/diadoc/begin', adminToken)).json()).url);
  assert.equal(auth.origin, 'https://identity.kontur.ru');
  assert.equal(auth.searchParams.get('scope'), 'openid offline_access Diadoc.PublicAPI');
  assert.match(auth.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/);
  const callback = redirectUri + '?state=' + auth.searchParams.get('state') + '&code=fixture-code';
  assert.equal((await send(adm + '/diadoc/finish', adminToken, { callback })).status, 200);
  const d = loadDescriptor('diadoc');
  d.base = base;
  for (const [op, input, expected] of [
    ['listDocuments', { limit: 1, after }, { documents: [fields], next: 'fixture-next' }],
    ['getDocument', { messageId, entityId }, fields],
  ]) {
    const row = { op, payload: prepare(d, {}, op, input).input };
    const offline = await deliverRow(d, row, {}, { mode: 'sandbox', fetchImpl: () => assert.fail('sandbox called Diadoc') });
    assert.equal(offline.status, 'sent');
    const live = await deliverRow(d, row, {}, { secret: () => dataToken });
    assert.equal(live.status, 'sent', op);
    assert.deepEqual(JSON.parse(live.result), expected);
    assert.equal(live.response, undefined);
  }
  assert.equal((await send(base + '/diadoc/document', dataToken, { messageId, entityId })).status, 502);
  assert.deepEqual(calls, ['/V4/GetDocuments', '/V3/GetDocument', '/V3/GetDocument']);
});
