# cups — webgen-bench/000045

## Weakened cases

- **Case 4 (generate a detailed sales report).** No document is generated: the "report" is
  the sales list (customer, product, quantity, price, total, date) with customer/product
  filters and a date range, plus the `sales-report` dashboard with a period filter.
- **Case 8 (colours).** "light goldenrod" is not a CSS colour name; the background is
  `lightgoldenrodyellow` (the nearest named colour). Components are `olivedrab` as asked.
- **Case 7 (navigation from the homepage).** The homepage is the Inventory dashboard;
  `navCheck(5)` walks all 8 menu entries.

## Misses

- `composition` — a block that refuses inside a `created` event (not enough finished
  products) answers **500** with the error page, not 400 with the form: refusal semantics
  exist only for actions and transitions. The transaction still rolls back; the check
  accepts any status >= 400 and proves the rollback (stock and sales unchanged).
- `composition` — a default price copied from the product at sale time cannot come from
  `fill` (no referenced row yet); it needs a `Sale.created` event with
  `db.update { price: "= coalesce(price, product.price)" }`.
- `composition` — a production run consumes one raw material; a bill of materials (several
  materials per run) would need a child entity plus `db.each`, left out to keep the graph
  compact.

## New for this app

- Range filter on a `date` field of a list (`date_from`/`date_to`), combined with ref filters.
- Enum options that start with a digit (`4oz,8oz,12oz,16oz`).
- `rowActions: []` to make ledgers (sales, production runs) read-only after creation.
- `db.adjust` on two different entities from one `created` event, one with `min: 0`.
- `sum` of a derived money field (`total`) in dashboard cards and tables (in-memory aggregate).
