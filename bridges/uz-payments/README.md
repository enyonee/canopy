# Payme and CLICK merchant bridge

This Node 22 process implements merchant callbacks and keeps a durable SQLite
ledger separate from the Canopy application database. Run it alongside
Canopy on the same loopback network. Only forward `POST /payme` and
`POST /click` from a public HTTPS reverse proxy. Keep `/orders` private.
Do not log request bodies, authorization headers or callbacks at the proxy.

Required environment: `UZ_PAYMENTS_DB` (persistent private SQLite path),
`UZ_PAYMENTS_OPERATOR_TOKEN` (random token, at least 24 characters) and
`UZ_PAYMENTS_RETURN_URL` (HTTPS, same business-controlled return page for
both providers). Configure one or both of:

- Payme: `PAYME_MERCHANT_ID` and `PAYME_KEY`; use `order_id` as the merchant
  account field during Payme onboarding.
- CLICK: `CLICK_MERCHANT_ID`, `CLICK_SERVICE_ID` and `CLICK_SECRET`. Point
  both Prepare and Complete notifications at the same callback URL.

From the repository root run `node bridges/uz-payments/server.mjs`.
The published descriptors expect `127.0.0.1:8899`; changing
`UZ_PAYMENTS_PORT` also requires changing the trusted descriptors.
Map their `operatorToken` to the bridged connection's secret. The graph
only supplies its own immutable order ID and amount in UZS minor units.
Use `createCheckout` to register the order and fetch the link; use
`getCheckout` to reconcile the same order later. Re-registering the same
order and amount is idempotent. The graph must implement its own buyer
ownership, fulfilment and handling of reversed or cancelled payments.

The bridge cannot initiate refunds at either provider. Payme's authenticated
`CancelTransaction` is recorded as cancelled or reversed; a CLICK provider
failure prevents capture. Duplicate callbacks never apply a second payment.
Run your merchant sandbox or provider verification before accepting real
payments. See [the catalog](../../docs/BUSINESS-CONNECTORS.md) for sources.
