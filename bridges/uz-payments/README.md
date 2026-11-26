# Payme, CLICK and Paynet merchant bridge

This Node 22 process implements merchant callbacks and keeps a durable SQLite
ledger separate from the Canopy application database. Run it alongside
Canopy on the same loopback network. Only forward `POST /payme` and
`POST /click` or `POST /uws` for the configured providers from a public HTTPS
reverse proxy. Keep `/orders` private.
Do not log request bodies, authorization headers or callbacks at the proxy.

Required environment: `UZ_PAYMENTS_DB` (persistent private SQLite path),
`UZ_PAYMENTS_OPERATOR_TOKEN` (random token, at least 24 characters). Payme
and CLICK also require `UZ_PAYMENTS_RETURN_URL`, an HTTPS return page.
Configure at least one of:

- Payme: `PAYME_MERCHANT_ID` and `PAYME_KEY`; use `order_id` as the merchant
  account field during Payme onboarding.
- CLICK: `CLICK_MERCHANT_ID`, `CLICK_SERVICE_ID` and `CLICK_SECRET`. Point
  both Prepare and Complete notifications at the same callback URL.
- Paynet: `PAYNET_USER`, `PAYNET_PASSWORD`, `PAYNET_SERVICE_ID`, and
  `PAYNET_ORDER_FIELD` (the string field agreed during UWS onboarding).
  Forward only `POST /uws` from Paynet's allowlisted IPs using TLS 1.3.
  Set `PAYNET_CANCEL_MS` to the permitted automatic cancellation window in
  milliseconds (up to one day), only for products whose fulfillment is
  reversible under that policy. Unset or zero declines cancellation.

From the repository root run `node bridges/uz-payments/server.mjs`.
The published descriptors expect `127.0.0.1:8899`; changing
`UZ_PAYMENTS_PORT` also requires changing the trusted descriptors.
Map their `operatorToken` to the bridged connection's secret. The graph
only supplies its own immutable order ID and amount in UZS minor units.
For Payme and CLICK use `createCheckout` to register an order and fetch
its link. For Paynet use `registerOrder` and give the customer the onboarded
service and order reference; the UWS integration does not issue a checkout
link. Use `getCheckout` to reconcile the same order later. Re-registering the same
order and amount is idempotent. The graph must implement its own buyer
ownership, fulfilment and handling of reversed or cancelled payments.

The bridge cannot initiate refunds at either provider. Payme's authenticated
`CancelTransaction` is recorded as cancelled or reversed; a CLICK provider
failure prevents capture. Duplicate callbacks never apply a second payment.
Paynet UWS records authorized cancellation as a reversal and returns only
successful transactions in its reconciliation statements. Validate all UWS
fields and cancellation policy with Paynet before routing production traffic.
Run your merchant sandbox or provider verification before accepting real
payments. See [the catalog](../../docs/BUSINESS-CONNECTORS.md) for sources.
