# checkout — reference app for the first real connector descriptors (no task number)

Orders a product, pays through Stripe, sends the receipt through Postmark and tells staff through Slack, all three in
the descriptors' sandbox (nothing leaves the machine; `modes` lists `sandbox` first). It exists to prove the C5
providers end to end over HTTP: a call queued by a transition, the sandbox's answer in the outbox, a signed inbound
`payment_intent.succeeded` (by hand-signed POST and by `--connectors simulate`) marking the order paid, and Slack's
`url_verification` challenge.

## Weakened cases
- The card is the literal Stripe test payment method `pm_card_visa`, confirmed at creation. A real shop collects a
  payment method in the browser (Stripe.js / Elements) and passes its id; the format has no widget for that, so this is
  a test-mode demo, not a payment page.
- The sandbox is the only mode exercised. Live needs real keys (`--secrets set`, then `--connectors live NAME --confirm`);
  the fixtures behind the descriptors are written from the providers' documentation, not recorded.
- The outbox page is what shows a call's result: the app cannot read the answer of a call (see Misses).
- Refunding is not offered as a button: `createRefund` needs the PaymentIntent id, which the graph never sees.
  The `charge.refunded` webhook is handled (`paid` -> `refunded`).

## Misses
- `connector`: a call's answer does not flow back into the graph (settlement events, section 2.3 of
  docs/CONNECTORS.md, are not built), so the PaymentIntent id cannot be stored on the order, `retrievePaymentIntent`,
  `confirmPaymentIntent` and `createRefund` cannot be chained after `createPaymentIntent`, and the order id has to travel
  in `metadata.order` and come back in the webhook.
- `block`: `db.each` drops an absent filter value from its `where`, so `where: {id: "@values.order"}` selects every row
  when the payload carries no order. Worked around in the descriptor, not the graph: `"require": ["order"]` on the Stripe
  events answers and ignores a payment with no order before any step runs.
- `node kind`: no conditional step, so "notify staff only when X" is a nested `db.each` over the matching rows.

## New for this app
- Three connectors of three descriptors in one graph: Stripe (form bodies, `Idempotency-Key`), Postmark (JSON,
  server-token header) and Slack (Bearer, `ok:false` as a failure).
- Inbound steps that call connectors: the `payment_intent.succeeded` event updates the order and queues a Postmark letter
  and a Slack message in the same transaction as its dedup row, so the provider's retry sends nothing twice.
- `export const secrets` in `checks.mjs` (as in `shop`): verify puts the webhook secrets into the app's store before boot.
