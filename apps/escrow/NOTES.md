# escrow — webgen-bench/000035

## Weakened cases
- Case 2 (deposit cryptocurrency into the escrow account): there is no blockchain or payment gateway. The wallet is a `balance` money field on the user, debited by `db.adjust` with a floor of zero; the escrow account is the sum of funded transactions on the dashboard. Crypto quantities are text because money has two decimals. The check tests the status change, the escrow card and a refused deposit beyond the balance.
- Case 1 ("seller information"): the seller's name as a link; no seller profile or rating.
- Case 4 (dispute): a transition that requires a reason; resolution is the arbiter choosing refund or settle. No evidence upload or message thread. The check also covers the refund.

## Misses
- `connector`: a payment or blockchain gateway (deposit confirmation from the chain, address generation, release on chain).
- `node kind`: decimal precision beyond two places for crypto amounts; modelled as text.
- `composition`: a user cannot see their own wallet — `where` cannot compare the row id with `@me` on the user entity (only `own` reference fields), so the balance is visible to the admin only and proven indirectly by the refused deposit.
- `composition`: an action's `after` cannot land on the row the action created (`{id}` is the action's own row), so buying lands on the transaction list.
- Runtime observation, not a format miss: after `db.createRow` inside a row action the runtime reassigns the current row to the created id (`Object.assign(ctx, out)` in `runSteps`), so `{row.name}` in the confirm named another product. The action uses `db.ensure` instead (it returns `found`, not `id`, and also prevents duplicate pending transactions). The runtime was left untouched.

## New for this app
- Two `own` scopes on one entity for two roles (buyer sees their purchases, seller their sales).
- `db.adjust` on another entity through `id: "@row.buyer"` with a negative expression (`= -row.amount`) and a floor message.
- `db.ensure` with a literal status in `where` and extra `values`, and `{found.id}` / `{found.amount}` in a confirm.
- Transitions restricted to several roles (`by: ["seller", "admin"]`) and a dashboard with `roles` for three roles.
- `register` plus `anonymous` on a marketplace where guests browse and buyers must sign in to buy (as in shop).
