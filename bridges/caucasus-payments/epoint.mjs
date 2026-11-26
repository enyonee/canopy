import { createHash } from 'node:crypto';
import { asMinor, description, drift, https, invalid, money, providerJson, refused, textId } from './contract.mjs';

const base = 'https://epoint.az/api/1';
const statuses = new Set(['new', 'success', 'returned', 'error', 'server_error', 'failed']);

export function epointRoutes(config, fetchImpl) {
  const { publicKey, privateKey, successUrl, failUrl, checkoutOrigin = 'https://epoint.az' } = config;
  const origin = https(checkoutOrigin);
  if (![publicKey, privateKey].every((s) => typeof s === 'string' && s.length > 0) ||
    !origin || origin.pathname !== '/' || origin.search || !https(successUrl) || !https(failUrl))
    throw new Error('invalid Epoint configuration');
  function call(endpoint, params) {
    const data = Buffer.from(JSON.stringify({ public_key: publicKey, ...params })).toString('base64');
    const signature = createHash('sha1').update(privateKey + data + privateKey).digest('base64');
    return providerJson(fetchImpl, base + endpoint, { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ data, signature }).toString());
  }
  const status = async (param, expected) => {
    if (!textId(expected)) return invalid;
    const r = await call('/get-status', { [param]: expected });
    if (!textId(r.transaction) || !textId(r.order_id) || r[param] !== expected || !statuses.has(r.status)) return drift;
    const amountMinor = asMinor(r.amount);
    if (!money(amountMinor) || ![undefined, 'AZN', '944', 944].includes(r.currency)) return drift;
    return [200, { id: r.transaction, orderId: r.order_id, status: r.status, amountMinor, currency: 'AZN' }];
  };
  return {
    '/epoint/checkout': async (body) => {
      if (!textId(body.orderId) || !money(body.amountMinor) || !description(body.description)) return invalid;
      const r = await call('/request', { order_id: body.orderId, amount: body.amountMinor / 100,
        currency: 'AZN', description: body.description, language: 'az',
        success_redirect_url: successUrl, error_redirect_url: failUrl });
      if (r.status !== 'success') return refused;
      const url = https(r.redirect_url);
      if (!textId(r.transaction) || !url || url.origin !== origin.origin ||
        (r.order_id !== undefined && r.order_id !== body.orderId)) return drift;
      return [200, { id: r.transaction, orderId: body.orderId, status: 'registered', checkoutUrl: url.href }];
    },
    '/epoint/status': async ({ id }) => status('transaction', id),
    '/epoint/find': async ({ orderId }) => status('order_id', orderId),
  };
}
