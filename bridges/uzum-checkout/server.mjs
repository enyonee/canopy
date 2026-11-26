import { pathToFileURL } from 'node:url';
import { merchantServer } from '../merchant-http.mjs';

const uuid = (s) => typeof s === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(s);
const reference = (s, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length <= max;
const minor = (n, min = 1) => Number.isSafeInteger(n) && n >= min && n <= 999999999999;
const invalid = [400, { error: 'invalid request' }];
const refused = [422, { error: 'bank rejected the operation' }];
const drift = [502, { error: 'unexpected bank response' }];
const states = new Set(['REGISTERED', 'AUTHORIZED', 'COMPLETED', 'REFUNDED', 'REVERSED', 'DECLINED']);

function https(s) {
  if (typeof s !== 'string' || s.length > 2083 || /[\x00-\x20\\]/.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash ? u : null;
  } catch { return null; }
}

function origin(s) {
  const u = https(s);
  return u && u.pathname === '/' && !u.search ? u.origin : null;
}

function amounts(result, id) {
  if (result.orderId !== id || !reference(result.merchantOrderId, 36) || !states.has(result.status) ||
    !minor(result.amount) || !minor(result.totalAmount) || !minor(result.completedAmount, 0) ||
    !minor(result.refundedAmount, 0) || !minor(result.reversedAmount, 0) ||
    result.refundedAmount > result.completedAmount) return null;
  return { id, orderId: result.merchantOrderId, currency: 'UZS', status: result.status, amountMinor: result.amount,
    totalMinor: result.totalAmount, completedMinor: result.completedAmount, refundedMinor: result.refundedAmount,
    reversedMinor: result.reversedAmount };
}

export function createBridge(config, fetchImpl = fetch) {
  const upstream = origin(config.apiOrigin), checkout = origin(config.checkoutOrigin);
  if (!upstream || !checkout || !https(config.successUrl) || !https(config.failureUrl) ||
    !reference(config.terminalId, 128) || typeof config.apiKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(config.apiKey))
    throw new Error('invalid Uzum Checkout configuration');
  async function call(endpoint, body) {
    const r = await fetchImpl(upstream + '/api/v1/' + endpoint, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', 'X-Terminal-Id': config.terminalId, 'X-API-Key': config.apiKey,
        'Content-Language': 'uz-UZ' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4500) });
    if (!r.ok) throw new Error('bank HTTP failure');
    const payload = await r.json();
    if (payload?.errorCode !== 0) return null;
    if (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result))
      throw new Error('missing bank result');
    return payload.result;
  }
  return merchantServer(config.operatorToken, {
    '/checkout': async ({ orderId, customerRef, amountMinor }) => {
      if (!reference(orderId, 36) || !reference(customerRef, 80) || !minor(amountMinor)) return invalid;
      const result = await call('payment/register', { orderNumber: orderId, clientId: customerRef, amount: amountMinor,
        currency: 860, viewType: 'REDIRECT', paymentParams: { operationType: 'PAYMENT', payType: 'ONE_STEP' },
        successUrl: config.successUrl, failureUrl: config.failureUrl, sessionTimeoutSecs: 900 });
      if (!result) return refused;
      const url = https(result.paymentRedirectUrl);
      if (!uuid(result.orderId) || !url || url.origin !== checkout) return drift;
      return [200, { id: result.orderId, orderId, checkoutUrl: url.href }];
    },
    '/status': async ({ id }) => {
      if (!uuid(id)) return invalid;
      const result = await call('payment/getOrderStatus', { orderId: id });
      if (!result) return refused;
      const projected = amounts(result, id);
      return projected ? [200, projected] : drift;
    },
    '/refund': async ({ id, amountMinor }) => {
      if (!uuid(id) || !minor(amountMinor)) return invalid;
      const result = await call('acquiring/refund', { orderId: id, amount: amountMinor });
      if (!result) return refused;
      return uuid(result.operationId) ? [200, { id, operationId: result.operationId, status: 'accepted' }] : drift;
    },
    '/refund-status': async ({ id, operationId }) => {
      if (!uuid(id) || !uuid(operationId)) return invalid;
      const result = await call('payment/getOrderStatus', { orderId: id });
      if (!result) return refused;
      const projected = amounts(result, id);
      if (!projected || !Array.isArray(result.operations)) return drift;
      const matches = result.operations.filter((o) => o?.operationId === operationId && o.operationType === 'REFUND');
      if (matches.length !== 1 || !['IN_PROGRESS', 'SUCCESS', 'FAIL'].includes(matches[0].state)) return drift;
      return [200, { id, operationId, status: matches[0].state, refundedMinor: projected.refundedMinor }];
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  createBridge({ apiOrigin: env.UZUM_CHECKOUT_API_ORIGIN, checkoutOrigin: env.UZUM_CHECKOUT_PAGE_ORIGIN,
    successUrl: env.UZUM_CHECKOUT_SUCCESS_URL, failureUrl: env.UZUM_CHECKOUT_FAILURE_URL,
    terminalId: env.UZUM_CHECKOUT_TERMINAL_ID, apiKey: env.UZUM_CHECKOUT_API_KEY,
    operatorToken: env.UZUM_CHECKOUT_OPERATOR_TOKEN }).listen(8904, '127.0.0.1');
}
