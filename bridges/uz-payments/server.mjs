import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { umask } from 'node:process';
import { openLedger } from './ledger.mjs';
import { checkout, click, equal, minor, orderId, payme } from './providers.mjs';

const CAP = 32 * 1024;
const goodId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x);

async function read(req, form = false) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > CAP) throw new Error('body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!form) return JSON.parse(raw);
  const pairs = [...new URLSearchParams(raw)];
  if (new Set(pairs.map(([k]) => k)).size !== pairs.length) throw new Error('duplicate field');
  return Object.fromEntries(pairs);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authenticated(req, expected) {
  return typeof req.headers.authorization === 'string' && equal(req.headers.authorization, expected);
}

function merchantApi(req, res, config, store, path) {
  if (!authenticated(req, 'Bearer ' + config.operatorToken)) return send(res, 401, { error: 'unauthorized' });
  if (path === '/orders' && req.method === 'POST') return register(req, res, config, store);
  const found = req.method === 'GET' && /^\/orders\/([A-Za-z0-9_-]{1,80})$/.exec(path);
  const order = found && store.order(found[1]);
  if (!order) return send(res, 404, { error: 'not found' });
  const row = store.status(order.id);
  return send(res, 200, { id: order.id, provider: order.provider, amountMinor: order.amount,
    state: ({ 1: 'pending', 2: 'paid', '-1': 'cancelled', '-2': 'reversed' })[row?.state] ?? 'unpaid',
    transaction: row?.external ?? null, updatedAt: row ? row.cancelled || row.performed || row.created : null });
}

async function register(req, res, config, store) {
  const p = await read(req);
  if (!p || !orderId(p.id) || !minor(p.amountMinor) || !['payme', 'click'].includes(p.provider))
    return send(res, 400, { error: 'invalid order' });
  if ((p.provider === 'payme' && !config.paymeKey) || (p.provider === 'click' && !config.clickSecret))
    return send(res, 400, { error: 'provider not configured' });
  if (!store.tx(() => store.register(p.id, p.provider, p.amountMinor))) return send(res, 409, { error: 'order has different immutable terms' });
  return send(res, 200, { id: p.id, currency: 'UZS', checkoutUrl: checkout(config, p.provider, p.id, p.amountMinor) });
}

async function paymeCallback(req, res, config, store, now) {
  const body = await read(req);
  const id = typeof body?.id === 'string' || Number.isSafeInteger(body?.id) ? body.id : null;
  const basic = 'Basic ' + Buffer.from('Paycom:' + config.paymeKey).toString('base64');
  if (!authenticated(req, basic))
    return send(res, 200, { id, error: { code: -32504, message: 'Insufficient privilege' } });
  if (!body || Array.isArray(body) || typeof body.method !== 'string')
    return send(res, 200, { id, error: { code: -32600, message: 'Invalid request' } });
  const reply = store.tx(() => payme(store, body, now()));
  return send(res, 200, { id, ...(reply.error ? reply : { result: reply }) });
}

function validateConfig(config) {
  if (typeof config.operatorToken !== 'string' || config.operatorToken.length < 24) throw new Error('operator token must be at least 24 characters');
  const url = new URL(config.returnUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.href.includes(';')) throw new Error('return URL must be HTTPS with no credentials or semicolon');
  if (!config.paymeKey && !config.clickSecret) throw new Error('configure at least one provider');
  if (config.paymeKey && !goodId(config.paymeMerchant)) throw new Error('Payme merchant ID required');
  if (config.clickSecret && (!goodId(config.clickMerchant) || !/^\d{1,15}$/.test(config.clickService))) throw new Error('CLICK merchant and service IDs required');
}

export function createBridge({ config, file, now = Date.now }) {
  validateConfig(config);
  const store = openLedger(file);
  const server = createServer(async (req, res) => {
    const path = req.url?.split('?')[0];
    try {
      if (path === '/payme' && req.method === 'POST' && config.paymeKey)
        return await paymeCallback(req, res, config, store, now);
      if (path === '/click' && req.method === 'POST' && config.clickSecret) {
        const form = await read(req, true);
        return send(res, 200, store.tx(() => click(store, form, config, now())));
      }
      if (path?.startsWith('/orders')) return await merchantApi(req, res, config, store, path);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const invalid = err instanceof SyntaxError || ['body too large', 'duplicate field'].includes(err.message);
      return send(res, invalid ? 400 : 500, { error: invalid ? 'invalid request' : 'internal error' });
    }
  });
  server.requestTimeout = 10_000;
  server.on('close', store.close);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env;
  umask(0o077);
  const file = e.UZ_PAYMENTS_DB;
  if (!file) throw new Error('UZ_PAYMENTS_DB is required');
  const server = createBridge({ file, config: {
    operatorToken: e.UZ_PAYMENTS_OPERATOR_TOKEN, returnUrl: e.UZ_PAYMENTS_RETURN_URL,
    paymeMerchant: e.PAYME_MERCHANT_ID, paymeKey: e.PAYME_KEY,
    clickMerchant: e.CLICK_MERCHANT_ID, clickService: e.CLICK_SERVICE_ID, clickSecret: e.CLICK_SECRET,
  } });
  server.listen(Number(e.UZ_PAYMENTS_PORT || 8899), '127.0.0.1');
}
