# insurance — webgen-bench/000025

## Weakened cases
- Case 6 (report "with various charts and graphs"): the report is a dashboard with cards and grouped tables; there are no charts. The check tests the figures and the period filter.
- Case 2 (claim history on the customer profile): a related table needs a direct reference, so Claim stores a `customer` copy that `Claim.created`/`Claim.updated` events fill from the policy — derivable data stored to make the profile possible.
- Case 4 ("the first policy"): the list is sorted by policy number so "first" is deterministic (POL-1001); the original wording relies on whatever order the page shows.

## Misses
- `node kind`: charts (bar/pie/line) on dashboards.
- `node kind`: report export or print view.
- `composition`: two-hop related tables (customer → policies → claims) need a stored copy maintained by events.
- `composition`: dashboard tables cannot group by a field reached through a reference (claims by policy type) — a copy of the type on Claim would be needed.
- `node kind`: time-driven status changes (a policy expiring when its end date passes); `daysLeft` is derived but the status only moves through a transition.

## New for this app
- `states` on two entities in one app, and `events` on `.updated` as well as `.created`.
- `db.update` with a two-hop reference (`@row.policy.customer`) to copy a value across entities.
- `days(endDate, today)` as a derived field; `sort` inside a list `override`; an `id` column.
- A dashboard `period` restricted to one entity while cards on other entities stay unfiltered.
- A related inline form with several fields (adding a policy from the customer profile, filing a claim from the policy).
