// Stripe builds the provider request. Canopy still owns its signal, response
// projection and delivery policy, including retries after a lost connection.
import { expand } from './template.mjs';

const operations = {
  createCheckout: (sdk, _input, body, opts) => sdk.checkout.sessions.create(body, opts),
  getCheckout: (sdk, input, _body, opts) => sdk.checkout.sessions.retrieve(input.id, {}, opts),
  refundCheckout: (sdk, _input, body, opts) => sdk.refunds.create(body, opts),
  createPaymentIntent: (sdk, _input, body, opts) => sdk.paymentIntents.create(body, opts),
  retrievePaymentIntent: (sdk, input, _body, opts) => sdk.paymentIntents.retrieve(input.id, {}, opts),
  confirmPaymentIntent: (sdk, input, body, opts) => sdk.paymentIntents.confirm(input.id, body, opts),
  createRefund: (sdk, _input, body, opts) => sdk.refunds.create(body, opts),
};

// The previous form encoding omitted null, while Stripe treats it as an
// explicit empty value. Keep array indices stable when omitting null entries.
function omitNull(value) {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(omitNull);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, omitNull(v)]));
  return value;
}

/** @param {typeof fetch} fetchImpl */
export async function fetchStripe(fetchImpl, { op, scopes, timeout, idemKey, opName }, signal) {
  const { default: Stripe } = await import('stripe');
  const apiKey = expand(op.request.headers.authorization, scopes).slice('Bearer '.length);
  const apiVersion = op.request.headers['stripe-version'];
  const body = omitNull(expand(op.request.body, scopes));
  let response, networkError;
  const httpClient = Stripe.createFetchHttpClient(async (url, request) => {
    try {
      signal.throwIfAborted();
      const res = await fetchImpl(url, { ...request, redirect: 'manual', signal });
      let text;
      const read = () => (text ??= res.text());
      response = { ok: res.ok, status: res.status, headers: res.headers, text: read };
      return /** @type {Response} */ ({ ...response });
    } catch (e) {
      networkError = e;
      // The SDK retries ECONNRESET/EPIPE even at zero retries. Keep the original
      // error for Canopy, without passing its code to the SDK's retry logic.
      throw new Error('Stripe request failed');
    }
  });
  const sdk = new Stripe(apiKey, { apiVersion, timeout, maxNetworkRetries: 0, telemetry: false, httpClient });
  try {
    await operations[opName](sdk, scopes.input, body, { idempotencyKey: idemKey });
  } catch (e) {
    if (!response) throw networkError ?? e;
  }
  // Feed even non-JSON and non-2xx responses through the descriptor mapper.
  return response;
}
