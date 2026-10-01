// A sandbox card gateway, as a plugin any app may list. Authorisation is a pure
// check that runs inside the transaction (a declined card refuses the action);
// the capture is an outbox delivery like every other effect that leaves the app.
const luhn = (digits) => {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0, double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d; double = !double;
  }
  return sum % 10 === 0;
};
export const DECLINED_CARD = '4000000000000002';

export default {
  async: true, // its blocks await store.*, resolve and text (docs/FORMAT.md "Plugins")
  transports: {
    payment: {
      summary: 'a sandbox gateway: captures what payment.charge authorised; needs "currency"',
      validate: (c) => (/^[A-Z]{3}$/.test(String(c.currency || '')) ? [] : [['currency', 'a payment connector needs "currency" (three letters, e.g. USD)']]),
      deliver: async () => ({ status: 'sent', code: 200, error: null }),
    },
  },
  blocks: {
    'payment.charge': {
      summary: 'authorise "amount" on "card" (sandbox: Luhn-valid, 4000000000000002 is declined) and queue the capture to the payment "connector"; refuses on decline; exposes @authorization and @payment',
      effects: ['payment'], requires: ['connector', 'amount', 'card'], connector: 'payment',
      run: async ({ store, graph, step, resolve }) => {
        const card = String((await resolve({ v: step.card })).v ?? '').replace(/[\s-]/g, '');
        const amount = Number((await resolve({ v: step.amount })).v);
        if (!(amount > 0)) throw new Error('payment.charge: the amount must be positive');
        if (!luhn(card)) throw new Error('Card number is not valid');
        if (card === DECLINED_CARD) throw new Error('Card declined');
        const authorization = `AUTH-${card.slice(-4)}-${Date.now().toString(36).toUpperCase()}`;
        const payment = await store.enqueue({ kind: 'payment', connector: step.connector, target: `**** ${card.slice(-4)}`,
          payload: { amount, currency: graph.connectors[step.connector].currency, authorization } });
        return { payment, authorization };
      },
    },
  },
};
