# Hosted checkout

Canopy ships native descriptors for Stripe Checkout, Bank of Georgia Payment
Manager and TBC Checkout. Each defaults to Canopy's local sandbox, which sends
no requests. For provider testing use the provider's test account and its
credentials; Canopy's `live` mode means HTTP delivery, not that the credentials
necessarily charge real money. Do not enable live delivery with production
credentials until the app has been verified on the corresponding merchant.

| Descriptor under the repository root | Merchant secret slots | Operations |
| --- | --- | --- |
| `connectors/stripe/descriptor.json` | `apiKey`, `webhookSecret` | Create and read a hosted Checkout Session; refund the associated PaymentIntent. Inputs use minor currency units. |
| `connectors/bog-payment-manager/descriptor.json` | `clientId`, `clientSecret`, `webhookPublicKey` | Create a GEL order, read its receipt, request a refund. The public key is the bank's trusted PEM key, not a key received in a callback. |
| `connectors/tbc-checkout/descriptor.json` | `apiKey`, `clientId`, `clientSecret` | Create a GEL payment, read payment details, request a cancellation/refund. TBC's amount uses major units. |

Load the desired descriptor in `plugins`, declare a connector of its kind,
and map the credential slots to deployment-specific secret names. Keep test
and real merchants in separate app deployments with distinct secret names.
The banks fetch a token per delivery; it is never available to graph code.

## Start and present a checkout

Keep a separate, owned payment-attempt row. Store the provider, expected
amount and currency, and a server-generated attempt reference. Gate checkout
creation by a state transition so repeated clicks do not enqueue new sessions.
Build the amount and product from the server-side order; never accept a buyer's
price, callback URL or return URL.

```json
[
  {
    "block": "connector.call",
    "connector": "pay",
    "op": "createCheckout",
    "ref": "@row",
    "input": {
      "amountMinor": "@row.amountMinor",
      "currency": "usd",
      "attemptId": "@row.reference",
      "productName": "@row.productName",
      "successUrl": "https://shop.example/orders",
      "cancelUrl": "https://shop.example/orders"
    }
  },
  { "block": "db.update", "set": { "delivery": "@delivery" } }
]
```

After delivery, a later action on the same row can read the projection:

```json
{
  "block": "connector.capture",
  "connector": "pay",
  "op": "createCheckout",
  "deliveryField": "delivery",
  "set": { "paymentId": "id", "checkoutUrl": "checkoutUrl" }
}
```

Use `checkoutUrl` for the buyer's redirect and never render it for another
buyer. Keep the result fields and the delivery id server-written and out of
editable forms. `connector.capture` verifies the binding in the outbox even
if an unrelated delivery ID is put in the current row. A pending result can
be fetched by invoking the capture action again; do not start another session.
The local sandbox links are fixtures, not working payment pages.

## Confirm and refund

The browser's return and an accepted API request do not confirm payment.
Use `getCheckout` on the stored provider ID, using the same merchant and mode.
Compare provider ID, amount and currency to the original attempt; also compare
the attempt reference where returned. Convert the BOG decimal string and
TBC major units back to minor units before comparing. Confirm a purchase
exactly once after verified payment, not on an unverified callback.

- **Stripe:** subscribe to Checkout Session events on `/hook/<connector>`.
  Reconcile the session even for `checkout.session.completed`: require
  `paymentStatus: paid`, the correct attempt and mode, and persist the
  PaymentIntent for refunds. Handle delayed success and failure separately.
- **BOG:** configure `/hook/<connector>` as the callback URL. The descriptor
  verifies `Callback-Signature` against the raw body and deduplicates the
  notification. Treat it as a prompt to read the receipt. A provider result
  of `request_received` on refund is an acknowledgement, not its completion.
- **TBC:** use authenticated `getCheckout` reconciliation until a final
  status is known. The descriptor deliberately provides no inbound hook for
  TBC's ID-only callback. An external notification receiver can prompt a
  read of a known payment, but must not set the status from that callback.
  TBC POSTs have no documented idempotency guarantee: expired claims and
  ambiguous failures need operator reconciliation. The outbox refuses manual
  replay of them. An empty successful cancel response is only an acknowledgement.

Refund actions belong to an operator role. Limit the new refund amount to the
unrefunded balance and reconcile provider status before promising a refund
or issuing another. Persist the currency, original transaction identifier
and each refund request separately. TBC documents restrictions on multiple
same-day partial refunds. If the provider does not return a confirmed amount
for a partial refund, reconcile it against the provider's merchant records.

Sources: [Stripe hosted checkout](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page),
[Bank of Georgia Payment Manager](https://api.bog.ge/docs/en/payments/standard-process/),
[TBC Checkout API](https://developers.tbcbank.ge/docs/checkout-api-overview).
