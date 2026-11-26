import { asMinor, description, drift, https, invalid, money, providerJson, refused, textId } from './contract.mjs';

const host = 'https://services.ameriabank.am/VPOS';
const sandbox = 'https://servicestest.ameriabank.am/VPOS';
const currencies = { AMD: '051', EUR: '978', USD: '840', RUB: '643' };
const alpha = new Map(Object.entries(currencies).flatMap(([name, code]) => [[name, name], [code, name]]));
const lang = ['am', 'en', 'ru'];
const order = (n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const orderNumber = (n) => typeof n === 'string' && /^[1-9][0-9]{0,9}$/.test(n) ? Number(n) : n;

export function ameriaRoutes(config, fetchImpl) {
  const { clientId, username, password, returnUrl, test } = config;
  if (![clientId, username, password].every((s) => typeof s === 'string' && s.length > 0) || !https(returnUrl))
    throw new Error('invalid Ameriabank configuration');
  const base = test ? sandbox : host;
  const call = (op, payload) => providerJson(fetchImpl, base + '/api/VPOS/' + op,
    { 'content-type': 'application/json', accept: 'application/json' },
    JSON.stringify({ ...payload, ClientID: clientId, Username: username, Password: password }));
  return {
    '/ameriabank/checkout': async (body) => {
      if (!order(body.orderId) || !money(body.amountMinor) || typeof body.currency !== 'string' || !Object.hasOwn(currencies, body.currency) ||
        !description(body.description) || !lang.includes(body.language)) return invalid;
      const r = await call('InitPayment', { OrderID: body.orderId, Amount: body.amountMinor / 100,
        Currency: currencies[body.currency], Description: body.description, BackURL: returnUrl });
      if (r.ResponseCode !== 1) return refused;
      if (!textId(r.PaymentID)) return drift;
      const checkoutUrl = new URL(base + '/Payments/Pay');
      checkoutUrl.search = new URLSearchParams({ id: r.PaymentID, lang: body.language }).toString();
      return [200, { id: r.PaymentID, orderId: body.orderId, status: 'registered', checkoutUrl: checkoutUrl.href }];
    },
    '/ameriabank/status': async ({ id }) => {
      if (!textId(id)) return invalid;
      const r = await call('GetPaymentDetails', { PaymentID: id });
      const orderId = orderNumber(r.OrderID), currency = alpha.get(r.Currency);
      const amounts = [r.Amount, r.DepositedAmount, r.RefundedAmount].map(asMinor);
      if (!order(orderId) || !currency || !money(amounts[0]) || amounts.includes(null) ||
        typeof r.ResponseCode !== 'string' || (r.PaymentID !== undefined && r.PaymentID !== id)) return drift;
      const [amountMinor, depositedMinor, refundedMinor] = amounts;
      if (depositedMinor > amountMinor || refundedMinor > depositedMinor) return drift;
      const status = refundedMinor > 0 ? 'refunded' :
        r.ResponseCode === '00' && depositedMinor === amountMinor ? 'paid' : 'not_paid';
      return [200, { id, orderId, currency, amountMinor, depositedMinor, refundedMinor, status }];
    },
    '/ameriabank/find': async ({ orderId }) => {
      if (!order(orderId)) return invalid;
      const r = await call('GetPaymentId', { OrderID: orderId });
      if (r.ResponseCode !== '00') return refused;
      return textId(r.PaymentId) ? [200, { id: r.PaymentId, orderId }] : drift;
    },
    '/ameriabank/refund': async ({ id, amountMinor }) => {
      if (!textId(id) || !money(amountMinor)) return invalid;
      const r = await call('RefundPayment', { PaymentID: id, Amount: amountMinor / 100 });
      return r.ResponseCode === '00' ? [200, { id, amountMinor, status: 'accepted' }] : refused;
    },
  };
}
