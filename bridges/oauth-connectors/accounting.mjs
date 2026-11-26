const invalid = [400, { error: 'invalid invoice request' }];
const drift = [502, { error: 'unexpected invoice response' }];
const pageSize = 20;
const number = (n) => Number.isSafeInteger(n) && n > 0 && n <= 100000;
const digits = (s) => typeof s === 'string' && /^[1-9][0-9]{0,24}$/.test(s);
const uuid = (s) => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const currency = (s) => typeof s === 'string' && /^[A-Z]{3}$/.test(s);
const amount = (n) => typeof n === 'number' && Number.isFinite(n);
const invoice = (id, number, c, total, due) => typeof number === 'string' && number.length <= 100 &&
  currency(c) && amount(total) && amount(due) ? { id, number, currency: c, total, due } : null;

async function read(fetchImpl, url, accessToken, extra = {}) {
  const r = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4500),
    headers: { accept: 'application/json', authorization: 'Bearer ' + accessToken, ...extra } });
  if (!r.ok) throw new Error('accounting API request failed');
  return r.json();
}

function page(rows, project) {
  if (!Array.isArray(rows) || rows.length > pageSize) return drift;
  const invoices = rows.map(project);
  return invoices.includes(null) ? drift : [200, { invoices, hasMore: rows.length === pageSize }];
}

export function quickbooksProvider(config) {
  const { realmId, homeCurrency, clientId, clientSecret, redirectUri, sandbox } = config;
  if (!digits(realmId) || !currency(homeCurrency)) throw new Error('invalid QuickBooks configuration');
  const base = 'https://' + (sandbox ? 'sandbox-' : '') + 'quickbooks.api.intuit.com/v3/company/' + realmId;
  const project = (r) => digits(r?.Id) ?
    invoice(r.Id, r.DocNumber ?? '', r.CurrencyRef?.value ?? homeCurrency, r.TotalAmt, r.Balance) : null;
  return {
    name: 'quickbooks', mode: 'consent', clientId, clientSecret, redirectUri, authentication: 'basic',
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2', tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scopes: ['com.intuit.quickbooks.accounting'], account: [realmId, Boolean(sandbox), homeCurrency],
    callbackMeta: (params) => params.realmId === realmId ? { realmId } : null,
    routes(token, fetchImpl) {
      async function get(path) {
        const grant = await token();
        if (grant.meta?.realmId !== realmId) throw new Error('unexpected company authorization');
        const r = await read(fetchImpl, base + path, grant.accessToken);
        if (!r || r.Fault) throw new Error('QuickBooks rejected the request');
        return r;
      }
      return {
        '/quickbooks/invoice': async ({ id }) => {
          if (!digits(id)) return invalid;
          const row = project((await get('/invoice/' + id)).Invoice);
          return row?.id === id ? [200, row] : drift;
        },
        '/quickbooks/invoices': async ({ page: index }) => {
          if (!number(index)) return invalid;
          const query = 'SELECT * FROM Invoice ORDER BY Id STARTPOSITION ' + ((index - 1) * pageSize + 1) + ' MAXRESULTS ' + pageSize;
          const response = (await get('/query?' + new URLSearchParams({ query }))).QueryResponse;
          return response && typeof response === 'object' ? page(response.Invoice ?? [], project) : drift;
        },
      };
    },
  };
}

export function xeroProvider(config) {
  const { tenantId, clientId, clientSecret, redirectUri } = config;
  if (!uuid(tenantId)) throw new Error('invalid Xero tenant');
  const base = 'https://api.xero.com/api.xro/2.0/Invoices';
  const project = (r) => uuid(r?.InvoiceID) ?
    invoice(r.InvoiceID, r.InvoiceNumber ?? '', r.CurrencyCode, r.Total, r.AmountDue) : null;
  return {
    name: 'xero', mode: 'consent', clientId, clientSecret, redirectUri, authentication: 'basic',
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize', tokenUrl: 'https://identity.xero.com/connect/token',
    scopes: ['offline_access', 'accounting.invoices.read'], account: tenantId,
    routes(token, fetchImpl) {
      async function get(suffix) {
        const { accessToken } = await token();
        const r = await read(fetchImpl, base + suffix, accessToken, { 'xero-tenant-id': tenantId });
        if (r?.Status !== 'OK' || !Array.isArray(r.Invoices)) throw new Error('Xero rejected the request');
        return r.Invoices;
      }
      return {
        '/xero/invoice': async ({ id }) => {
          if (!uuid(id)) return invalid;
          const rows = await get('/' + id);
          const row = rows.length === 1 ? project(rows[0]) : null;
          return row?.id.toLowerCase() === id.toLowerCase() ? [200, row] : drift;
        },
        '/xero/invoices': async ({ page: index }) => {
          if (!number(index)) return invalid;
          return page(await get('?' + new URLSearchParams({ page: index, pageSize, order: 'InvoiceID ASC' })), project);
        },
      };
    },
  };
}
