# trading — webgen-bench/000041

## Weakened cases
- Case 1 (bidding section): bids are placed from the opportunity page (related form), not from a separate bidding page; the bid form has no bidding page of its own.
- Case 3 (history from the account dashboard): the dashboard shows cards and grouped tables; the row-level history is a separate saved list in the menu because dashboards cannot list rows or link to lists.
- Case 4 (account information): the editable "account" is a Trading Account row owned by the trader (name, currency, phone, risk limit); the login profile itself (name, email, password) is not editable by the trader because `own` needs a reference field and the user entity cannot reference itself from the session.

## Misses
- Editing one's own user row — `composition` (`own` requires a `ref:<user>` field; a separate Account entity created by the `Trader.created` event stands in).
- Real order matching / trading engine — `block` (accept/reject is a manual admin transition).
- A dashboard cannot link to or embed a row list — `node kind` (dashboards carry cards and grouped tables only).

## New for this app
- An event on the user entity (`Trader.created`) firing on self-registration to create the account row.
- A rule reading a derived aggregate through a reference (`trader.committed + price * quantity <= trader.limit`), where the limit itself is derived from the account (`sum(Account: riskLimit)`).
- `anonymous` role for browsing, `own` on two entities, transitions restricted with `by`, a role-restricted personal dashboard with `@me` in card and table `where`.
