import { expand, expandUrl } from './template.mjs';

const operations = {
  createCheckout: (api, _input, body, options) => api.PaymentLinksApi.paymentLinks(body, options),
  getCheckout: (api, input, _body, options) => api.PaymentLinksApi.getPaymentLink(input.id, options),
  refundCheckout: (api, input, body, options) => api.ModificationsApi.refundCapturedPayment(input.paymentPspReference, body, options),
};

/** @param {typeof fetch} fetchImpl */
export async function fetchAdyen(fetchImpl, { op, scopes, idemKey, opName }, signal) {
  const { default: { Client, CheckoutAPI, EnvironmentEnum } } = await import('@adyen/api-library');
  const expectedUrl = new URL(expandUrl(op.request.url, scopes)).href;
  const headers = expand(op.request.headers, scopes);
  let response;
  const httpClient = {
    async request(endpoint, json, config, _needsKey, options) {
      // The SDK's generated methods target v72; existing Canopy graphs use v71.
      const url = endpoint.replace('/checkout/v72/', '/checkout/v71/');
      if (url !== expectedUrl || options.method !== op.request.method) throw new Error('Adyen SDK request differs from its descriptor');
      signal.throwIfAborted();
      const res = await fetchImpl(url, { method: options.method, redirect: 'manual', signal,
        headers: { 'X-API-Key': config.apiKey, 'content-type': 'application/json', ...(options.idempotencyKey && { 'idempotency-key': options.idempotencyKey }) },
        ...(options.method === 'POST' && { body: json }) });
      let raw;
      const text = () => (raw ??= res.text());
      response = { status: res.status, ok: res.ok, headers: res.headers, text };
      // Keep malformed replies away from the SDK's raw parse-error logger.
      return res.ok ? JSON.parse(await text()) : {};
    },
  };
  const config = { apiKey: headers['X-API-Key'], environment: EnvironmentEnum.LIVE, liveEndpointUrlPrefix: scopes.config.endpointPrefix };
  const api = new CheckoutAPI(new Client(config, httpClient));
  try {
    await operations[opName](api, scopes.input, expand(op.request.body, scopes), { idempotencyKey: idemKey });
  } catch (e) {
    if (!response) throw e;
  }
  return response;
}
