# T-Bank payment bridge

Run `node bridges/tbank-payments/server.mjs` on the Canopy host; it binds port
8900 on loopback only. Set `TBANK_TERMINAL_KEY`, `TBANK_PASSWORD`,
`TBANK_OPERATOR_TOKEN` (at least 24 characters), `TBANK_SUCCESS_URL`,
`TBANK_FAIL_URL` and, if required by the bank for the terminal,
`TBANK_API_TOKEN` in the process environment. Install the operator token as a
Canopy secret and map the descriptor's `operatorToken` slot to it. Do not
expose the bridge or put credentials in the graph.

The adapter signs and sends Init, GetState, and Cancel. It does not receive
bank notifications and does not consider the browser redirect a payment
confirmation. Store the Checkout ID, immutable order reference, amount in
kopecks and RUB currency, then verify that an authenticated status response
matches before fulfilling a CONFIRMED payment. For an ambiguous Init,
reconcile by OrderId in the bank dashboard. For an ambiguous Cancel,
reconcile the payment state and cancelled amount before any new write.
Requests are not replayed by Canopy after an ambiguous result. Terminals
requiring fiscal receipts in Init or Cancel are not supported by this bridge.

References: [PHP SDK, MIT](https://github.com/webmasterolegan/tbank-payments/tree/75255770797b83b85fad0d26361267295fe5f5f6),
[T-Bank token](https://developer.tbank.ru/eacq/intro/developer/token),
[Init](https://developer.tbank.ru/eacq/api/init), [GetState](https://developer.tbank.ru/eacq/api/get-state),
and [Cancel](https://developer.tbank.ru/eacq/api/cancel).
