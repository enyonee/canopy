import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const upstream = 'https://securepay.tinkoff.ru/v2/';
const orderId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,36}$/.test(x);
const paymentId = (x) => typeof x === 'string' && /^[1-9][0-9]{0,17}$/.test(x);
const money = (x) => Number.isSafeInteger(x) && x >= 1 && x <= 9999999999;
const checkoutUrl = (x) => typeof x === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*(?:tbank|tinkoff)\.ru\/[^\s]+$/.test(x);
const asId = (x) => Number.isSafeInteger(x) || typeof x === 'string' ? String(x) : '';
const state = (x) => typeof x === 'string' && /^[A-Z_]{1,40}$/.test(x);

function signature(fields, password) {
  const flat = Object.entries({ ...fields, Password: password })
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash('sha256').update(flat.map(([, value]) => String(value)).join('')).digest('hex');
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(header, key) {
  const left = Buffer.from(header || ''), right = Buffer.from('Bearer ' + key);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function read(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function route(path, body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (path === '/checkout' && money(body.amountMinor) && orderId(body.orderId) && typeof body.description === 'string' &&
    body.description.length >= 1 && body.description.length <= 250) {
    return ['Init', { OrderId: body.orderId, Amount: body.amountMinor, Description: body.description,
      PayType: 'O', SuccessURL: config.successUrl, FailURL: config.failUrl }];
  }
  if (path === '/status' && paymentId(body.id)) return ['GetState', { PaymentId: body.id }];
  if (path === '/refund' && paymentId(body.id) && money(body.amountMinor)) return ['Cancel', { PaymentId: body.id, Amount: body.amountMinor }];
  return null;
}

function project(operation, vendor, fields, terminalKey) {
  const id = asId(vendor.PaymentId);
  if (!paymentId(id) || (vendor.TerminalKey !== undefined && vendor.TerminalKey !== terminalKey) ||
    !state(vendor.Status) || !orderId(vendor.OrderId)) return null;
  const base = { id, orderId: vendor.OrderId, status: vendor.Status, currency: 'RUB' };
  if (operation === 'Init') {
    if (vendor.OrderId !== fields.OrderId || vendor.Amount !== fields.Amount || !checkoutUrl(vendor.PaymentURL)) return null;
    return { ...base, amountMinor: vendor.Amount, checkoutUrl: vendor.PaymentURL };
  }
  if (id !== fields.PaymentId) return null;
  if (operation === 'GetState') return money(vendor.Amount) ? { ...base, amountMinor: vendor.Amount } : null;
  if (!money(vendor.OriginalAmount) || !Number.isSafeInteger(vendor.NewAmount) || vendor.NewAmount < 0 ||
    vendor.OriginalAmount - vendor.NewAmount !== fields.Amount) return null;
  return { ...base, amountMinor: fields.Amount, remainingMinor: vendor.NewAmount };
}

async function forward(operation, input, config, fetchImpl) {
  const fields = { TerminalKey: config.terminalKey, ...input };
  const vendor = await fetchImpl(upstream + operation, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(4500),
    headers: { 'content-type': 'application/json', ...(config.apiToken && { authorization: 'Bearer ' + config.apiToken }) },
    body: JSON.stringify({ ...fields, Token: signature(fields, config.password) }),
  });
  if (!vendor.ok) return [502, { error: 'bank request failed' }];
  const data = await vendor.json();
  if (data?.Success !== true || data.ErrorCode !== '0') return [422, { error: 'bank rejected the request' }];
  const result = project(operation, data, fields, config.terminalKey);
  return result ? [200, result] : [502, { error: 'unexpected bank response' }];
}

function callbackUrl(value) {
  if (typeof value !== 'string') return false;
  const url = new URL(value);
  return value.length <= 300 && url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}

export function createBridge(config, fetchImpl = fetch) {
  if (typeof config.operatorToken !== 'string' || config.operatorToken.length < 24 ||
    typeof config.password !== 'string' || !config.password || !orderId(config.terminalKey) ||
    !callbackUrl(config.successUrl) || !callbackUrl(config.failUrl)) throw new Error('invalid merchant configuration');
  return createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, config.operatorToken)) return reply(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST' || !['/checkout', '/status', '/refund'].includes(req.url)) return reply(res, 404, { error: 'not found' });
    let body;
    try { body = await read(req); }
    catch { return reply(res, 400, { error: 'invalid request' }); }
    const routed = route(req.url, body, config);
    if (!routed) return reply(res, 400, { error: 'invalid request' });
    try {
      const [status, result] = await forward(...routed, config, fetchImpl);
      return reply(res, status, result);
    } catch { return reply(res, 502, { error: 'bank request failed' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { TBANK_TERMINAL_KEY, TBANK_PASSWORD, TBANK_OPERATOR_TOKEN, TBANK_API_TOKEN, TBANK_SUCCESS_URL, TBANK_FAIL_URL } = process.env;
  createBridge({ terminalKey: TBANK_TERMINAL_KEY, password: TBANK_PASSWORD, apiToken: TBANK_API_TOKEN,
    operatorToken: TBANK_OPERATOR_TOKEN, successUrl: TBANK_SUCCESS_URL, failUrl: TBANK_FAIL_URL }).listen(8900, '127.0.0.1');
}
