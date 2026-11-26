# Robokassa Invoice bridge

References: [Invoice API](https://docs.robokassa.ru/ru/invoice-api) and the
[official PHP SDK (MIT)](https://github.com/robokassa/sdk-php). This bridge
implements one-time invoice creation and authenticated lookup by merchant
invoice number. It does not accept public callbacks or configure fiscal
receipts; verify the merchant account settings before live use.

Run `node bridges/robokassa/server.mjs` on the Canopy host. It binds only
`127.0.0.1:8902`. Set `ROBOKASSA_MERCHANT_LOGIN`, the production
`ROBOKASSA_PASSWORD_1`, and a separate `ROBOKASSA_OPERATOR_TOKEN` of at
least 24 printable characters. Only the operator token belongs in Canopy's
encrypted secret store, mapped to `operatorToken`. Keep the bridge private.

Use a unique numeric invoice ID per order and store its immutable amount
in kopecks and RUB currency. A redirect does not confirm payment. Read the
invoice by merchant invoice ID and compare its ID, amount and currency
before acting on a `Paid` status. For an uncertain create outcome, read by
the same merchant invoice ID before considering another request. Refunds
must be reconciled separately with Robokassa; this descriptor does not request them.
