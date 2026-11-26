import { minor, orderId } from './providers.mjs';

const DAY = 86_400_000;
const UZT = 18_000_000;
const id = (value) => Number.isSafeInteger(value) && value > 0;
const rpcId = (value) => Number.isSafeInteger(value) || (typeof value === 'string' && value.length <= 128);
const standard = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const history = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{2} \d{2}:\d{2}:\d{2} [A-Z]{2,5} \d{4}$/;
const ok = (result) => ({ result });
const error = (code, message) => ({ error: { code, message } });
const missing = () => error(302, 'Order not found');
const stamp = (time) => new Date(time + UZT).toISOString().slice(0, 19).replace('T', ' ');
function parseDate(value) {
  if (typeof value !== 'string' || !standard.test(value)) return NaN;
  const ms = Date.parse(value.replace(' ', 'T') + '+05:00');
  return Number.isFinite(ms) && stamp(ms) === value ? ms : NaN;
}

const identity = (params, cfg) => params.fields?.[cfg.paynetOrderField];
const owned = (store, key) => {
  const order = orderId(key) ? store.order(key) : null;
  return order?.provider === 'paynet' ? order : null;
};

function customerOrder(store, params, cfg, now, perform) {
  const key = identity(params, cfg);
  if (!orderId(key)) return error(411, 'Order field required');
  const order = owned(store, key);
  if (!order) return missing();
  const fields = { [cfg.paynetOrderField]: key };
  if (!perform) return ok({ status: 0, timestamp: stamp(now), fields: { ...fields, amount: String(order.amount) } });
  if (!id(params.transactionId)) return error(-32602, 'Invalid transaction ID');
  if (!minor(params.amount) || params.amount !== order.amount) return error(413, 'Invalid amount');
  const found = store.payment('paynet', String(params.transactionId));
  if (found) {
    if (found.orderId !== key || found.amount !== params.amount) return error(201, 'Transaction ID already in use');
    return found.state === 2 ? error(201, 'Transaction already exists') : error(202, 'Transaction cancelled');
  }
  if (store.active(key)) return error(201, 'Order already paid');
  const row = store.pay(store.create('paynet', String(params.transactionId), key, params.amount, now, now), now);
  return ok({ providerTrnId: row.localId, fields, timestamp: stamp(now) });
}

function lookup(store, params, cfg, now, cancel) {
  if (!id(params.transactionId)) return error(-32602, 'Invalid transaction ID');
  if (cancel ? !Number.isFinite(parseDate(params.timestamp)) :
    (typeof params.timestamp !== 'string' || !history.test(params.timestamp))) return error(414, 'Invalid timestamp');
  let row = store.payment('paynet', String(params.transactionId));
  if (!row) return cancel ? error(203, 'Transaction not found') :
    ok({ transactionState: 3, timestamp: stamp(now), providerTrnId: 0 });
  if (cancel && row.state === 2) {
    if (!cfg.paynetCancelMs || now - row.performed > cfg.paynetCancelMs) return error(306, 'Cancellation not permitted');
    row = store.cancel(row, now, 0);
  }
  return ok({ transactionState: row.state === 2 ? 1 : 2, timestamp: stamp(row.cancelled || row.performed), providerTrnId: row.localId });
}

function statement(store, params) {
  const from = parseDate(params.dateFrom), to = parseDate(params.dateTo);
  if (!(to >= from && to - from <= 31 * DAY)) return error(414, 'Invalid statement period');
  const rows = store.paynetStatement(from, to + 999);
  if (rows.length > 5000) return error(101, 'Request a shorter statement period');
  return ok({ statements: rows.map((row) => ({ amount: row.amount, transactionId: Number(row.external),
    providerTrnId: row.localId, timestamp: stamp(row.performed) })) });
}

export function paynetReply(store, body, cfg, now) {
  const requestId = rpcId(body?.id) ? body.id : null;
  const respond = (message) => ({ jsonrpc: '2.0', id: requestId, ...message });
  if (requestId === null || body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
    !body.params || typeof body.params !== 'object' || Array.isArray(body.params))
    return respond(error(-32600, 'Invalid request'));
  const p = body.params;
  if (p.serviceId !== cfg.paynetService) return respond(error(100, 'Unknown service'));
  switch (body.method) {
    case 'GetInformation': return respond(customerOrder(store, p, cfg, now, false));
    case 'PerformTransaction': return respond(customerOrder(store, p, cfg, now, true));
    case 'CheckTransaction': return respond(lookup(store, p, cfg, now, false));
    case 'CancelTransaction': return respond(lookup(store, p, cfg, now, true));
    case 'GetStatement': return respond(statement(store, p));
    default: return respond(error(-32601, 'Unknown method'));
  }
}
