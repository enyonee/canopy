import { createHash, timingSafeEqual } from 'node:crypto';

export function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const orderId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(x);
export const minor = (x) => Number.isSafeInteger(x) && x > 0 && x <= 99_999_999_999;
const numeric = (x) => typeof x === 'string' && /^\d{1,15}$/.test(x);
const ledgerId = (row) => String(row.localId);
const PAYME_TTL = 43_200_000;

const paymeError = (code, message, data) => ({ error: { code, message: { ru: message, uz: message, en: message }, ...(data && { data }) } });
const paymeState = (x) => ({ create_time: x.created, perform_time: x.performed, cancel_time: x.cancelled, transaction: ledgerId(x), state: x.state, reason: x.reason });

function paymeOrder(store, p, existing) {
  const id = p.account?.order_id;
  const order = orderId(id) && store.order(id);
  if (!order || order.provider !== 'payme') return paymeError(-31050, 'Order not found', 'order_id');
  if (!minor(p.amount) || order.amount !== p.amount) return paymeError(-31001, 'Incorrect amount');
  if (!existing && store.active(id)) return paymeError(-31008, 'Order already has an active payment');
  return order;
}

function paymeCreate(store, p, x, now) {
  const order = paymeOrder(store, p, x);
  if (order.error) return order;
  if (!x) {
    if (!Number.isSafeInteger(p.time) || p.time <= 0) return paymeError(-32602, 'Invalid transaction time');
    x = store.create('payme', p.id, order.id, order.amount, p.time, now);
  }
  if (x.orderId !== order.id || x.amount !== order.amount || x.state < 0) return paymeError(-31008, 'Transaction cannot be used');
  if (x.state === 1 && now - x.created >= PAYME_TTL) {
    store.cancel(x, now, 4);
    return paymeError(-31008, 'Transaction expired');
  }
  return { create_time: x.created, transaction: ledgerId(x), state: x.state };
}

export function payme(store, request, now) {
  const { method, params: p = {} } = request;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return paymeError(-32602, 'Invalid parameters');
  if (method === 'CheckPerformTransaction') {
    const order = paymeOrder(store, p, null);
    return order.error ? order : { allow: true };
  }
  if (method === 'GetStatement') {
    if (!Number.isSafeInteger(p.from) || !Number.isSafeInteger(p.to) || p.from < 0 || p.to < p.from || p.to - p.from > 31 * 86400000)
      return paymeError(-32602, 'Invalid statement range');
    return { transactions: store.statement(p.from, p.to).map(x => ({ id: x.external, time: x.providerTime, amount: x.amount, account: { order_id: x.orderId }, ...paymeState(x) })) };
  }
  if (!['CreateTransaction', 'PerformTransaction', 'CancelTransaction', 'CheckTransaction'].includes(method)) return paymeError(-32601, 'Method not found');
  if (!orderId(p.id)) return paymeError(-32602, 'Invalid transaction id');
  const x = store.payment('payme', p.id);
  if (method === 'CreateTransaction') return paymeCreate(store, p, x, now);
  if (!x) return paymeError(-31003, 'Transaction not found');
  if (method === 'CheckTransaction') return paymeState(x);
  if (method === 'CancelTransaction') {
    if (!Number.isSafeInteger(p.reason)) return paymeError(-32602, 'Invalid reason');
    const cancelled = x.state < 0 ? x : store.cancel(x, now, p.reason);
    return { transaction: ledgerId(x), cancel_time: cancelled.cancelled, state: cancelled.state };
  }
  if (x.state < 0) return paymeError(-31008, 'Transaction cancelled');
  if (x.state === 1 && now - x.created >= PAYME_TTL) {
    store.cancel(x, now, 4);
    return paymeError(-31008, 'Transaction expired');
  }
  const paid = x.state === 2 ? x : store.pay(x, now);
  return { transaction: ledgerId(x), perform_time: paid.performed, state: paid.state };
}

const clickError = (error, note) => ({ error, error_note: note });
function clickProof(p, config) {
  const prefix = p.click_trans_id + p.service_id + config.clickSecret + p.merchant_trans_id;
  const signed = prefix + (p.action === '1' ? p.merchant_prepare_id : '') + p.amount + p.action + p.sign_time;
  return equal(createHash('md5').update(signed).digest('hex'), p.sign_string);
}

function clickMinor(s) {
  if (typeof s !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(s)) return 0;
  const [sum, cents = ''] = s.split('.');
  return Number(sum) * 100 + Number(cents.padEnd(2, '0'));
}

export function click(store, p, config, now) {
  if (!numeric(p.click_trans_id) || !orderId(p.merchant_trans_id) || !p.sign_time || !p.sign_string || p.service_id !== config.clickService)
    return clickError(-8, 'Invalid request');
  if (!['0', '1'].includes(p.action)) return clickError(-3, 'Action not found');
  if (p.action === '1' && (!numeric(p.merchant_prepare_id) || !/^-?\d{1,6}$/.test(p.error ?? '')))
    return clickError(-8, 'Invalid complete request');
  if (!clickProof(p, config)) return clickError(-1, 'Signature check failed');
  const order = store.order(p.merchant_trans_id);
  if (!order || order.provider !== 'click') return clickError(-5, 'Order not found');
  if (clickMinor(p.amount) !== order.amount) return clickError(-2, 'Incorrect amount');
  let row = store.payment('click', p.click_trans_id);
  const reply = { click_trans_id: Number(p.click_trans_id), merchant_trans_id: order.id };
  if (row && row.orderId !== order.id) return clickError(-6, 'Transaction not found');
  if (p.action === '0') {
    if (row?.state < 0) return clickError(-9, 'Transaction cancelled');
    const active = store.active(order.id);
    if (active && (!row || row.state === 2)) return clickError(-4, 'Order already has an active payment');
    row ??= store.create('click', p.click_trans_id, order.id, order.amount, 0, now);
    return { ...reply, merchant_prepare_id: row.localId, ...clickError(0, 'Success') };
  }
  if (!row || ledgerId(row) !== p.merchant_prepare_id) return clickError(-6, 'Transaction not found');
  if (row.state < 0) return clickError(-9, 'Transaction cancelled');
  if (row.state === 2) return clickError(-4, 'Already paid');
  if (Number(p.error) < 0) {
    store.cancel(row, now, Number(p.error));
    return clickError(-9, 'Transaction cancelled');
  }
  if (p.error !== '0') return clickError(-8, 'Invalid provider result');
  store.pay(row, now);
  return { ...reply, merchant_confirm_id: row.localId, ...clickError(0, 'Success') };
}

export function checkout(config, provider, id, amount) {
  if (provider === 'payme') {
    const data = `m=${config.paymeMerchant};ac.order_id=${id};a=${amount};c=${config.returnUrl}`;
    return 'https://checkout.paycom.uz/' + Buffer.from(data).toString('base64');
  }
  const query = new URLSearchParams({ merchant_id: config.clickMerchant, service_id: config.clickService,
    amount: (amount / 100).toFixed(2), transaction_param: id, return_url: config.returnUrl });
  return 'https://my.click.uz/services/pay?' + query;
}
