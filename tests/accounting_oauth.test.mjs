import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { quickbooksProvider, xeroProvider } from '../bridges/oauth-connectors/accounting.mjs';
import { createBridge } from '../bridges/oauth-connectors/server.mjs';
import { deliverRow, prepare } from '../runtime/connectors/engine.mjs';
import { loadDescriptor } from './replay.mjs';

const dataToken = 'accounting-fixture-data-token';
const adminToken = 'accounting-fixture-admin-token';
const redirectUri = 'https://merchant.example.test/callback';
const shared = { clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri };
const realmId = '12345678901234';
const tenantId = '01234567-89ab-4cde-8f01-23456789abcd';
const xeroInvoiceId = '81234567-89ab-4cde-8f01-23456789abcd';
const common = { number: 'INV-41', total: 125.5, due: 55.5 };

const providers = [
  [quickbooksProvider({ ...shared, realmId, homeCurrency: 'USD', sandbox: true }),
    'https://appcenter.intuit.com', 'com.intuit.quickbooks.accounting',
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    'https://sandbox-quickbooks.api.intuit.com/v3/company/' + realmId,
    '41', 'USD', { Id: '41', DocNumber: 'INV-41', TotalAmt: 125.5, Balance: 55.5, CustomerRef: { name: 'not stored' } }],
  [xeroProvider({ ...shared, tenantId }), 'https://login.xero.com', 'offline_access accounting.invoices.read',
    'https://identity.xero.com/connect/token', 'https://api.xero.com/api.xro/2.0/Invoices', xeroInvoiceId, 'NZD',
    { InvoiceID: xeroInvoiceId, InvoiceNumber: 'INV-41', CurrencyCode: 'NZD', Total: 125.5, AmountDue: 55.5,
      Contact: { Name: 'not stored' }, LineItems: [{ Description: 'not stored' }] }],
];
async function start(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const send = (url, token, body = {}) => fetch(url, { method: 'POST',
  headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
const close = (server) => new Promise((resolve) => server.close(resolve));

for (const [provider, authority, scope, tokenEndpoint, upstream, id, currency, fixture] of providers) {
  test(`${provider.name}: tenant-bound OAuth and read-only invoice projections`, async (t) => {
    const quick = provider.name === 'quickbooks';
    const values = new Map(), calls = [];
    const secrets = { current: (name) => values.get(name), set: (name, value) => values.set(name, value) };
    let exchanges = 0;
    const fetchImpl = async (url, init) => {
      assert.equal(init.redirect, 'manual');
      if (url === tokenEndpoint) {
        exchanges++;
        assert.equal(init.headers.authorization, 'Basic ' + Buffer.from('fixture-client:fixture-secret').toString('base64'));
        assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)),
          { grant_type: 'authorization_code', code: 'fixture-code', redirect_uri: redirectUri });
        return Response.json({ access_token: 'accounting-token', refresh_token: 'accounting-refresh', expires_in: 3600 });
      }
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.authorization, 'Bearer accounting-token');
      assert.equal(init.headers['xero-tenant-id'], quick ? undefined : tenantId);
      assert.equal(init.headers.accept, 'application/json');
      assert.ok(url.startsWith(upstream));
      const tail = url.slice(upstream.length);
      calls.push(tail);
      if (quick) {
        if (tail === '/invoice/' + id) return Response.json({ Invoice: fixture });
        const query = new URL(url).searchParams.get('query');
        assert.equal(query, 'SELECT * FROM Invoice ORDER BY Id STARTPOSITION 21 MAXRESULTS 20');
        return Response.json({ QueryResponse: { Invoice: [fixture] } });
      }
      if (tail === '/' + id) return Response.json({ Status: 'OK', Invoices: [fixture] });
      assert.deepEqual(Object.fromEntries(new URL(url).searchParams), { page: '2', pageSize: '20', order: 'InvoiceID ASC' });
      return Response.json({ Status: 'OK', Invoices: [fixture] });
    };
    const { data, admin } = createBridge({ dataToken, adminToken, providers: [provider], secrets, fetchImpl });
    const [base, adm] = await Promise.all([start(data), start(admin)]);
    t.after(() => Promise.all([close(data), close(admin)]));
    const add = '/' + provider.name;
    const grant = new URL((await (await send(adm + add + '/begin', adminToken)).json()).url);
    assert.equal(grant.origin, authority);
    assert.equal(grant.searchParams.get('scope'), scope);
    const callback = redirectUri + '?state=' + grant.searchParams.get('state') + '&code=fixture-code';
    if (quick) {
      assert.equal((await send(adm + add + '/finish', adminToken, { callback: callback + '&realmId=1' })).status, 400);
      assert.equal(exchanges, 0);
    }
    assert.equal((await send(adm + add + '/finish', adminToken, { callback: callback + (quick ? '&realmId=' + realmId : '') })).status, 200);
    const descriptor = loadDescriptor(provider.name);
    descriptor.base = base;
    const row = { id, currency, ...common };
    for (const [op, input, expected] of [
      ['getInvoice', { id }, row],
      ['listInvoices', { page: 2 }, { invoices: [row], hasMore: false }],
    ]) {
      const delivery = { op, payload: prepare(descriptor, {}, op, input).input };
      const offline = await deliverRow(descriptor, delivery, {}, {
        mode: 'sandbox', fetchImpl: () => assert.fail('sandbox called the API'),
      });
      assert.equal(offline.status, 'sent', op);
      const live = await deliverRow(descriptor, delivery, {}, { secret: () => dataToken });
      assert.equal(live.status, 'sent', op);
      assert.equal(live.response, undefined);
      assert.deepEqual(JSON.parse(live.result), expected);
    }
    assert.equal((await send(base + add + '/invoice', dataToken, { id: id + '/other' })).status, 400);
    assert.equal((await send(base + add + '/invoices', dataToken, { page: 0 })).status, 400);
    assert.equal(exchanges, 1);
    assert.equal(calls.length, 2);
  });
}
