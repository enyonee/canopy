import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { merchantServer } from '../merchant-http.mjs';

const origin = 'https://services.robokassa.ru/InvoiceServiceWebApi/api/';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const link = /^https:\/\/auth\.robokassa\.ru\/merchant\/invoice\/[a-z0-9_-]+$/i;
const currencies = { currency: 'RUB' };
const statuses = new Set(['NotPaid', 'Paid', 'Expired']);
const invoiceNumber = (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const amountMinor = (n) => Number.isSafeInteger(n) && n > 0 && n <= 99999999;
const invalid = [400, { error: 'invalid request' }];
const drift = [502, { error: 'unexpected invoice response' }];
const refused = [422, { error: 'provider rejected the invoice operation' }];

function minorFromAmount(amount) {
  if (typeof amount !== 'number') return null;
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(String(amount));
  return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : null;
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(payload, config) {
  const packed = encode({ typ: 'JWT', alg: 'HS256' }) + '.' + encode({ MerchantLogin: config.merchantLogin, ...payload });
  return packed + '.' + createHmac('sha256', config.merchantLogin + ':' + config.password).update(packed).digest('base64url');
}

export function createBridge(config, fetchImpl = fetch) {
  if (typeof config.merchantLogin !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(config.merchantLogin) ||
    typeof config.password !== 'string' || !config.password) throw new Error('invalid Robokassa configuration');
  async function call(method, payload) {
    const res = await fetchImpl(origin + method, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(4500),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(sign(payload, config)) });
    if (!res.ok) throw new Error('invoice API request failed');
    return res.json();
  }
  return merchantServer(config.operatorToken, {
    '/checkout': async ({ invoiceId, amountMinor: total, description }) => {
      if (!invoiceNumber(invoiceId) || !amountMinor(total) || typeof description !== 'string' ||
        description.length < 1 || description.length > 100) return invalid;
      const result = await call('CreateInvoice', { InvId: invoiceId, InvoiceType: 'OneTime', Culture: 'ru',
        OutSum: total / 100, Description: description });
      if (result?.isSuccess !== true) return refused;
      if (result.invId !== invoiceId || typeof result.id !== 'string' || !uuid.test(result.id) ||
        typeof result.url !== 'string' || !link.test(result.url)) return drift;
      return [200, { id: result.id, invoiceId, checkoutUrl: result.url, ...currencies }];
    },
    '/status': async ({ invoiceId }) => {
      if (!invoiceNumber(invoiceId)) return invalid;
      const result = await call('GetInvoiceInformation', { InvId: invoiceId });
      if (result?.isSuccess !== true) return refused;
      const invoice = result.invoiceInformation;
      const total = minorFromAmount(invoice?.outSum);
      if (invoice?.invId !== invoiceId || typeof invoice.id !== 'string' || !uuid.test(invoice.id) ||
        invoice.invoiceType !== 'OneTime' || !statuses.has(invoice.invoiceStatus) || !amountMinor(total)) return drift;
      return [200, { id: invoice.id, invoiceId, amountMinor: total, status: invoice.invoiceStatus, ...currencies }];
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ROBOKASSA_MERCHANT_LOGIN, ROBOKASSA_PASSWORD_1, ROBOKASSA_OPERATOR_TOKEN } = process.env;
  createBridge({ merchantLogin: ROBOKASSA_MERCHANT_LOGIN, password: ROBOKASSA_PASSWORD_1,
    operatorToken: ROBOKASSA_OPERATOR_TOKEN }).listen(8902, '127.0.0.1');
}
