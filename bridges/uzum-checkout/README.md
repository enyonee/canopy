# Uzum Bank Checkout bridge

Run `node bridges/uzum-checkout/server.mjs` alongside Canopy. It listens
on loopback only (`127.0.0.1:8904`). Configure:

- `UZUM_CHECKOUT_API_ORIGIN`, `UZUM_CHECKOUT_PAGE_ORIGIN`: the exact HTTPS
  origins assigned by the bank for the API and the hosted payment page.
- `UZUM_CHECKOUT_TERMINAL_ID`, `UZUM_CHECKOUT_API_KEY`: bank-issued credentials.
- `UZUM_CHECKOUT_SUCCESS_URL`, `UZUM_CHECKOUT_FAILURE_URL`: HTTPS return
  pages controlled by the merchant.
- `UZUM_CHECKOUT_OPERATOR_TOKEN`: at least 24 printable characters, mapped
  to the descriptor's `operatorToken` secret.

The bridge follows [Uzum Checkout API v1](https://developer.uzumbank.uz/en/checkout/).
The [Python SDK, MIT](https://github.com/jaskarov/uzpayment-sdk/tree/3f4a9def27cceea7487aa6536285a8613dc530a2)
was considered but implements a different link/callback contract. No SDK
runtime dependency or undocumented link is used.

Only one-step hosted UZS payments without bank auto-fiscalization are
supported. Confirm your fiscalization obligations and terminal settings
with the bank. Use opaque merchant order and customer references and
integer amounts in tiyins. A checkout or redirect is not a capture.
Match the authenticated order status against the stored payment ID,
order ID, currency and amount before accepting a fully completed payment
with no refund or reversal. A refund request returns an operation ID, not
confirmation; `getRefund` verifies that operation in the bank's history.
Unknown writes must be reconciled in the bank dashboard before retry.
