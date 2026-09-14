# traceability — webgen-bench/000044

## Weakened cases

- **Case 1 (registration confirms with a unique product ID).** The flash is static text
  ("Product registered successfully; its product ID is shown below"); the ID is the
  user-entered `code`, shown on the product page the form lands on, not inside the
  message. Form `confirm` is not interpolated and the row id is not reachable from
  expressions, so an auto-generated ID (`TRC-<id>`) cannot be produced.
- **Case 4 (verify by entering the ID).** The verification form asks for the typed code
  *and* the product to compare it with (a select of registered products); authenticity is
  `check.matchRef` of the typed code against the selected registration. A lookup by typed
  code alone, answering "unknown" for a code that was never registered, is not expressible.
- **Case 6 (menu consistent across pages).** `navCheck(5)` proves every menu entry opens
  from the home page; the runtime renders one menu on every page, but the check does not
  visit each page in turn.
- **Case 7 (colours).** Asserted on the CSS the runtime emits for body, header and buttons;
  card borders share the accent but are not asserted separately.

## Misses

- `block` — an event on a child cannot write a field of the parent row (Checkpoint.created →
  Product.location/updatedAt): only `db.adjust` reaches another row, and only numerically.
  Worked around by driving checkpoints from Product transitions (`fields: ["location"]`).
- `block` (runtime quirk) — `db.createRow` returns `{ id }` and `runSteps` merges every
  block's output into the context, so the *current* row id is rebound to the created row; a
  `db.update` placed after it silently targets the wrong id. Worked around by ordering
  `db.update` before `db.createRow` in every transition.
- `composition` — "latest checkpoint" (location/time of the most recent child) is not
  derivable: aggregates are count/sum/avg/min/max over numbers. The product stores
  `location` and `updatedAt` written by the transitions instead.
- `composition` — a unique ID minted by the system is not expressible; the code is entered
  by the user and guarded by a `unique` rule.

## New for this app

- `check.matchRef` fired from a `created` event, with `labels` on the resulting boolean in
  list and detail.
- A derived text field through two reference hops (`product.producer.name`): FORMAT.md
  documents one hop; checker and runtime accept the chain.
- A saved list with its own `search` (`/list/track?q=`), used as the tracking page.
- `db.update` of a `time` field with `@now` inside a transition; transitions that ask for a
  field (`location`) and read it back through `@row.location` in the same `do`.
