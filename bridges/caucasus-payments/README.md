# Caucasus hosted payments bridge

Run `node bridges/caucasus-payments/server.mjs` on the Canopy host. The
bridge listens on `127.0.0.1:8903`. Set a shared `CAUCASUS_OPERATOR_TOKEN`
of at least 24 printable characters and map it to each enabled descriptor's
`operatorToken` secret. Keep the port private. Configure one or both:

- **Ameriabank:** `AMERIA_CLIENT_ID`, `AMERIA_USERNAME`, `AMERIA_PASSWORD`,
  and `AMERIA_RETURN_URL`. Set `AMERIA_TEST=1` only with bank test credentials.
  See [vPOS SDK, MIT](https://github.com/hos/ameria-sdk-js/tree/1be94949a021a3f8a146be80889aa2a69e0f3757).
- **Epoint:** `EPOINT_PUBLIC_KEY`, `EPOINT_PRIVATE_KEY`,
  `EPOINT_SUCCESS_URL` and `EPOINT_FAIL_URL`. For a bank-hosted checkout set
  `EPOINT_CHECKOUT_ORIGIN` to its verified exact HTTPS origin; it defaults
  to `https://epoint.az`. Use an AZN-only merchant account. An explicit
  non-AZN status currency is rejected. See [Epoint API](https://developer.epoint.az/en)
  and the [PHP SDK, MIT](https://github.com/rafoabbas/epoint-php/tree/80c27b07463934e156d23c5ce08a7f8fb33b386b).

Use a unique merchant order ID and keep immutable terms including amount in
hundredths and currency. A checkout URL or browser redirect does not indicate
payment. Verify the status response against the stored payment ID, order ID,
amount and currency before fulfillment. For Ameriabank only a matching full
deposit with no refund yields `paid`; refund acceptance requires a separate
status read. For Epoint only a matching authenticated `success` status
indicates payment. Epoint refunds remain merchant-side; the connector does
not use the saved-card refund endpoint as a reversal of a hosted checkout.

To reconcile an ambiguous checkout, query by the original order ID before
retrying. The descriptors deliberately do not replay writes. The Canopy
sandbox is offline; bank test credentials are used only by live bridge
deliveries configured for the bank test endpoint.
