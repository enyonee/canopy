# consulting — webgen-bench/000040

## Weakened cases
- Case 2 (purchase a service, enter payment details): the card number is checked for 16 digits; no gateway. The cart confirmation says "Added to your cart" without the service name (see Misses).
- Case 3 (blog readability, grammar, up-to-date content): the check verifies three dated posts on leadership with a full body and search; "free of grammatical errors" is not testable.
- Case 4 (register directly from the page): the row action registers the identity customer; no name/email form because the visitor is the identity profile.

## Misses
- Confirm text after `db.createRow` cannot name the row (`{row.name}` / `{row.title}` read the created child instead) — runtime defect in `runSteps` (`Object.assign(ctx, out)` overwrites `ctx.id`); confirms were rewritten without row fields.
- Payment gateway — `connector`.

## New for this app
- Seven top-level menu entries mixing pages, entity lists and saved lists, with list titles set to the required menu names ("Online Classes", "Blogs").
- `db.adjust` with `min` as a capacity guard (seats) in a row action offered on the list (`rowActions`) and the detail (`actions`).
- A rule that only bites on a transition (`status = 'cart' or items > 0`) using a derived aggregate on the probe row.
