import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { amoProvider } from '../bridges/oauth-connectors/amocrm.mjs';
import { createBridge } from '../bridges/oauth-connectors/server.mjs';
import { googleSheetsProvider } from '../bridges/oauth-connectors/google-sheets.mjs';
import { shopifyProvider } from '../bridges/oauth-connectors/shopify.mjs';
import { tokenBroker } from '../bridges/oauth-connectors/tokens.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { noReplay } from '../runtime/settle.mjs';
import { openSecrets } from '../runtime/secrets.mjs';
import { loadDescriptor } from './replay.mjs';

const dataToken = 'fixture-connector-access-credential';
const adminToken = 'fixture-administrator-credential';
const redirectUri = 'https://merchant.example.test/callback';
const provider = { name: 'test-grant', mode: 'consent', clientId: 'client-fixture', clientSecret: 'secret-fixture',
  tokenUrl: 'https://issuer.example.test/token', authorizeUrl: 'https://issuer.example.test/authorize', redirectUri,
  pkce: true, scopes: ['read'], authentication: 'basic',
  callbackMeta: (params) => params.realmId === '123' ? { realm: '123' } : null,
  routes: (token) => ({ '/test-grant/read': async () => {
    const grant = await token();
    return [200, { realm: grant.meta.realm }];
  } }),
};

async function onLoopback(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const send = (url, token, body = {}) => fetch(url, { method: 'POST',
  headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
const close = (server) => new Promise((resolve) => server.close(resolve));
const mem = () => { const values = new Map(); return { current: (k) => values.get(k), set: (k, v) => values.set(k, v) }; };

test('OAuth uses separate admin authority, a bound single-use PKCE code and encrypted rotating grants', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'canopy-oauth-'));
  const secrets = openSecrets({ dir, env: {}, app: 'fixture' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  let time = 1_000_000, calls = 0, challenge;
  const now = () => time;
  const fetchImpl = async (url, init) => {
    assert.equal(url, provider.tokenUrl);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Basic ' + Buffer.from('client-fixture:secret-fixture').toString('base64'));
    const form = new URLSearchParams(init.body);
    if (++calls === 1) {
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), redirectUri);
      assert.equal(form.get('code'), 'fixture-code');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge);
    } else {
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-1');
    }
    return Response.json({ access_token: 'access-' + calls, refresh_token: 'refresh-' + calls, expires_in: 900 });
  };
  const { data, admin } = createBridge({ dataToken, adminToken, providers: [provider], secrets, fetchImpl, now });
  const dataUrl = await onLoopback(data), adminUrl = await onLoopback(admin);
  t.after(() => Promise.all([close(data), close(admin)]));
  const begin = '/test-grant/begin', finish = '/test-grant/finish';
  assert.equal((await send(dataUrl + begin, dataToken)).status, 404);
  assert.equal((await send(adminUrl + begin, dataToken)).status, 401);
  assert.equal((await send(dataUrl + '/test-grant/read', adminToken)).status, 401);
  assert.equal((await send(dataUrl + '/test-grant/read', dataToken)).status, 502);
  assert.equal(calls, 0);
  const start = new URL((await (await send(adminUrl + begin, adminToken)).json()).url);
  const state = start.searchParams.get('state');
  challenge = start.searchParams.get('code_challenge');
  assert.equal(start.origin, 'https://issuer.example.test');
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(start.searchParams.get('scope'), 'read');
  const wrong = redirectUri + '?realmId=123&code=fixture-code&state=wrong';
  const valid = redirectUri + '?realmId=123&code=fixture-code&state=' + state;
  for (const callback of [wrong, valid.replace('merchant.', 'other.'), valid + '&state=duplicate', valid.replace('realmId=123', 'realmId=999')])
    assert.equal((await send(adminUrl + finish, adminToken, { callback })).status, 400);
  assert.equal(calls, 0);
  const accepted = await send(adminUrl + finish, adminToken, { callback: valid });
  assert.deepEqual(await accepted.json(), { connected: true });
  assert.equal((await send(adminUrl + finish, adminToken, { callback: valid })).status, 400);
  assert.deepEqual(await (await send(dataUrl + '/test-grant/read', dataToken)).json(), { realm: '123' });
  assert.equal(calls, 1);
  const encrypted = await readFile(join(dir, 'secrets.enc'), 'utf8');
  assert.ok(!encrypted.includes('refresh-1') && !encrypted.includes('access-1'));
  time += 850_000;
  const restarted = tokenBroker(openSecrets({ dir, env: {}, app: 'fixture' }), provider, fetchImpl, now);
  const expected = { accessToken: 'access-2', meta: { realm: '123' } };
  assert.deepEqual(await Promise.all([restarted.token(), restarted.token()]), [expected, expected]);
  assert.equal(calls, 2);
  assert.match(secrets.current('oauth_test-grant'), /refresh-2/);
  const other = tokenBroker(secrets, { ...provider, clientId: 'changed' }, fetchImpl, now);
  await assert.rejects(other.token(), /consent/);
});

test('expired consent and redirect responses fail closed', async () => {
  let time = 1_000_000, calls = 0;
  const broker = tokenBroker(mem(), provider, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://unexpected.example.test' } });
  }, () => time);
  const callback = () => redirectUri + '?realmId=123&code=fixture&state=' + new URL(broker.begin()).searchParams.get('state');
  const old = callback();
  time += 600_001;
  assert.equal(await broker.finish(old), false);
  const fresh = callback();
  await assert.rejects(broker.finish(fresh), /rejected/);
  assert.equal(await broker.finish(fresh), false);
  assert.equal(calls, 1);
});

test('Shopify polls orders and stock using the correct GraphQL API and reuses its app token', async (t) => {
  const shop = shopifyProvider({ shop: 'fixture-store', clientId: 'fixture-client', clientSecret: 'fixture-secret' });
  const shopUrl = 'https://fixture-store.myshopify.com';
  const id = 'gid://shopify/Order/41', itemId = 'gid://shopify/InventoryItem/5', locationId = 'gid://shopify/Location/7';
  const order = { id, name: '#1041', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', email: 'not stored' };
  const projection = { id, name: '#1041', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED' };
  const cases = [
    ['listOrders', {}, { first: 20, after: null },
      { orders: { nodes: [order], pageInfo: { hasNextPage: true, endCursor: 'fixture-cursor' } } },
      { rows: [projection], next: 'fixture-cursor' }],
    ['getOrder', { id }, { id }, { order }, projection],
    ['getStock', { itemId, locationId }, { item: itemId, location: locationId },
      { inventoryItem: { id: itemId, inventoryLevel: { quantities: [{ name: 'available', quantity: 12 }] } } },
      { itemId, locationId, available: 12 }],
  ];
  let requests = 0, exchanges = 0;
  const { data, admin } = createBridge({ dataToken, providers: [shop], secrets: mem(), fetchImpl: async (url, req) => {
    assert.equal(req.redirect, 'manual');
    if (url === shopUrl + '/admin/oauth/access_token') {
      exchanges++;
      assert.deepEqual(Object.fromEntries(new URLSearchParams(req.body)), {
        grant_type: 'client_credentials', client_id: 'fixture-client', client_secret: 'fixture-secret',
      });
      return Response.json({ access_token: 'fixture-access', expires_in: 86400 });
    }
    assert.equal(url, shopUrl + '/admin/api/2026-10/graphql.json');
    assert.equal(req.headers['X-Shopify-Access-Token'], 'fixture-access');
    const [, , vars, data] = cases[requests++];
    const parsed = JSON.parse(req.body);
    assert.deepEqual(parsed.variables, vars);
    assert.match(parsed.query, /^query /);
    assert.doesNotMatch(parsed.query, /email|fixture/);
    return Response.json({ data });
  } });
  assert.equal(admin, null);
  const descriptor = loadDescriptor('shopify');
  descriptor.base = await onLoopback(data);
  t.after(() => close(data));
  for (const [op, params, , , expected] of cases) {
    const { input } = prepare(descriptor, {}, op, params);
    const row = { op, payload: input };
    const sandbox = await deliverRow(descriptor, row, {}, { mode: 'sandbox', fetchImpl: () => assert.fail('sandbox called network') });
    assert.equal(sandbox.status, 'sent', op);
    const result = await deliverRow(descriptor, row, {}, { secret: () => dataToken });
    assert.equal(result.status, 'sent', op);
    assert.equal(result.response, undefined);
    assert.deepEqual(JSON.parse(result.result), expected);
  }
  assert.equal(exchanges, 1);
  assert.equal(requests, 3);
});

test('Google Sheets uses offline consent and bounded RAW operations for the configured sheet', async (t) => {
  const spreadsheetId = 'fixture-sheet-id';
  const google = googleSheetsProvider({ spreadsheetId, sheet: "Owner's Sheet",
    clientId: 'sheets-fixture', clientSecret: 'sheets-secret', redirectUri });
  const root = 'https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/';
  const accesses = [];
  const row = ['=NOT_A_FORMULA', 42, true];
  let codeChallenge;
  const { data, admin } = createBridge({ dataToken, adminToken, providers: [google], secrets: mem(), fetchImpl: async (url, req) => {
    assert.equal(req.redirect, 'manual');
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(req.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), 'sheets-fixture');
      assert.equal(form.get('client_secret'), 'sheets-secret');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), codeChallenge);
      return Response.json({ access_token: 'sheets-token', refresh_token: 'sheets-refresh', expires_in: 3600 });
    }
    assert.equal(req.headers.authorization, 'Bearer sheets-token');
    accesses.push(url);
    if (req.method === 'GET') {
      assert.equal(decodeURIComponent(url), root + "'Owner''s Sheet'!A3:T4?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS");
      return Response.json({ majorDimension: 'ROWS', values: [row] });
    }
    assert.equal(req.method, 'POST');
    assert.equal(decodeURIComponent(url), root + "'Owner''s Sheet'!A:T:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
    assert.deepEqual(JSON.parse(req.body), { majorDimension: 'ROWS', values: [row] });
    return Response.json({ spreadsheetId, updates: { updatedRange: "'Owner''s Sheet'!A5:C5", updatedRows: 1,
      updatedData: { values: [['not exposed']] } } });
  } });
  const [base, adm] = await Promise.all([onLoopback(data), onLoopback(admin)]);
  t.after(() => Promise.all([close(data), close(admin)]));
  const descriptor = loadDescriptor('google-sheets');
  descriptor.base = base;
  const url = new URL((await (await send(adm + '/google-sheets/begin', adminToken)).json()).url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  codeChallenge = url.searchParams.get('code_challenge');
  const callback = redirectUri + '?code=fixture-code&state=' + url.searchParams.get('state');
  assert.equal((await send(adm + '/google-sheets/finish', adminToken, { callback })).status, 200);
  const cases = [
    ['readRows', { firstRow: 3, limit: 2 }, { firstRow: 3, rows: [row] }],
    ['appendRow', { row }, { updatedRange: "'Owner''s Sheet'!A5:C5" }],
  ];
  for (const [op, params, expected] of cases) {
    const prepared = prepare(descriptor, {}, op, params);
    const delivery = { kind: 'google-sheets', op, payload: prepared.input };
    const offline = await deliverRow(descriptor, delivery, {}, {
      mode: 'sandbox', fetchImpl: () => assert.fail('sandbox connected to Google'),
    });
    assert.equal(offline.status, 'sent', op);
    const result = await deliverRow(descriptor, delivery, {}, { secret: () => dataToken });
    assert.equal(result.status, 'sent', op);
    assert.equal(result.response, undefined);
    assert.deepEqual(JSON.parse(result.result), expected);
    assert.equal(noReplay({ descriptors: { 'google-sheets': descriptor } }, delivery), op === 'appendRow');
  }
  assert.equal((await send(base + '/google-sheets/append', dataToken, { row: [{ formula: '=TEST()' }] })).status, 400);
  assert.equal((await send(base + '/google-sheets/read', dataToken, { firstRow: 1, limit: 26 })).status, 400);
  assert.equal(accesses.length, 2);
});

test('amoCRM binds consent and refresh to one portal and reconciles the actual deal stage', async (t) => {
  const amo = amoProvider({ portal: 'fixture', clientId: 'amo-client', clientSecret: 'amo-secret', redirectUri });
  const domain = 'https://fixture.amocrm.ru';
  const cases = [
    ['createContact', { name: 'Demo', email: 'demo@example.test' }, 'POST', 'contacts', [
      { name: 'Demo', custom_fields_values: [{ field_code: 'EMAIL', values: [{ value: 'demo@example.test', enum_code: 'WORK' }] }] },
    ], { _embedded: { contacts: [{ id: 41 }] } }, { id: 41 }],
    ['getContact', { id: 41 }, 'GET', 'contacts/41', undefined, { id: 41, name: 'Demo', private: 'ignored' }, { id: 41, name: 'Demo' }],
    ['createDeal', { name: 'Order', pipelineId: 6, stageId: 7 }, 'POST', 'leads', [
      { name: 'Order', pipeline_id: 6, status_id: 7 },
    ], { _embedded: { leads: [{ id: 42 }] } }, { id: 42 }],
    ['setDealStage', { id: 42, stageId: 9 }, 'PATCH', 'leads', [{ id: 42, status_id: 9 }],
      { _embedded: { leads: [{ id: 42 }] } }, { id: 42 }],
    ['getDeal', { id: 42 }, 'GET', 'leads/42', undefined, { id: 42, pipeline_id: 6, status_id: 9 }, { id: 42, pipelineId: 6, stageId: 9 }],
  ];
  let time = 1_000_000, calls = 0, exchanges = 0;
  const { data, admin } = createBridge({ dataToken, adminToken, providers: [amo], secrets: mem(), now: () => time,
    fetchImpl: async (url, req) => {
      assert.equal(req.redirect, 'manual');
      const body = req.body ? JSON.parse(req.body) : undefined;
      if (url === domain + '/oauth2/access_token') {
        assert.equal(req.headers['content-type'], 'application/json');
        const common = { redirect_uri: redirectUri, client_id: 'amo-client', client_secret: 'amo-secret' };
        if (++exchanges === 1) assert.deepEqual(body, { grant_type: 'authorization_code', code: 'amo-code', ...common });
        else assert.deepEqual(body, { grant_type: 'refresh_token', refresh_token: 'amo-refresh-1', ...common });
        return Response.json({ access_token: 'amo-token-' + exchanges, refresh_token: 'amo-refresh-' + exchanges, expires_in: 300 });
      }
      const [, , method, endpoint, expected, reply] = cases[calls++];
      assert.equal(url, domain + '/api/v4/' + endpoint);
      assert.equal(req.method, method);
      assert.equal(req.headers.authorization, 'Bearer amo-token-' + exchanges);
      assert.deepEqual(body, expected);
      return Response.json(reply);
    } });
  const [base, adm] = await Promise.all([onLoopback(data), onLoopback(admin)]);
  t.after(() => Promise.all([close(data), close(admin)]));
  const descriptor = loadDescriptor('amocrm');
  descriptor.base = base;
  const start = new URL((await (await send(adm + '/amocrm/begin', adminToken)).json()).url);
  assert.equal(start.origin + start.pathname, 'https://www.amocrm.ru/oauth');
  assert.equal(start.searchParams.get('mode'), 'post_message');
  assert.equal(start.searchParams.has('response_type'), false);
  const callback = redirectUri + '?code=amo-code&state=' + start.searchParams.get('state') + '&platform=1&referer=';
  assert.equal((await send(adm + '/amocrm/finish', adminToken, { callback: callback + 'other.amocrm.ru' })).status, 400);
  assert.equal(exchanges, 0);
  assert.equal((await send(adm + '/amocrm/finish', adminToken, { callback: callback + 'fixture.amocrm.ru' })).status, 200);
  for (const [op, input, method, , , , expected] of cases) {
    const row = { kind: 'amocrm', op, payload: prepare(descriptor, {}, op, input).input };
    const offline = await deliverRow(descriptor, row, {}, {
      mode: 'sandbox', fetchImpl: () => assert.fail('sandbox called amoCRM'),
    });
    assert.equal(offline.status, 'sent', op);
    if (op === 'getDeal') time += 250_000;
    const result = await deliverRow(descriptor, row, {}, { secret: () => dataToken });
    assert.equal(result.status, 'sent', op);
    assert.deepEqual(JSON.parse(result.result), expected, op);
    assert.equal(result.response, undefined);
    assert.equal(noReplay({ descriptors: { amocrm: descriptor } }, row), method !== 'GET');
  }
  assert.equal(calls, cases.length);
  assert.equal(exchanges, 2);
});
