# shirts — webgen-bench/000037

## Weakened cases
- Case 3 (generate a design → preview displayed): the "design" is a derived text field naming the model, fabric and measurements, plus a derived price; no image or rendering.
- Case 4 (change an attribute and regenerate): editing the design recomputes the same derived text; there is no explicit "regenerate" step because nothing is stored.
- Case 6 (credit card accepted, order processed): the card number is checked for 16 digits by a rule and stored as text; no payment gateway, no masking beyond not showing the field on the detail page.

## Misses
- Design generation / rendering ("AI Integration") — `block` (a generator producing an image or a richer artifact; only text can be derived).
- Payment processing — `connector` (a payment gateway; `http`/`mail` cannot charge a card).

## New for this app
- Derived text with nested `concat(...)` (arity limit 9) and `lower()` through two references.
- The detail page of a status-driven entity used as the checkout page: the transition form asks for shipping and card fields, a rule validates the card on the transition, and the status enum is kept off the create form.
- A saved list on a status subset (`where status in [paid, shipped]`) with a `go:` row action.
