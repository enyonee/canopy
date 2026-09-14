# golf — webgen-bench/000100

## Weakened cases
- Case 3 (quote "dynamically applying hotel, flight, transport and golf conditions"): the conditions
  are fixed formulas over supplier rates and customer preferences (suite = +50% of the hotel rate per
  night, caddie = +40% of the green fee per round); no seasonal prices, availability or supplier
  look-ups. The check tests every line and the total for 1, 2 and 3 golfers and the base price.
- Case 4 (digital voucher and invoice): the voucher is the confirmed booking page (`#id` as the
  confirmation number) and a letter in the outbox whose text carries the package, hotel, course,
  dates and invoice lines; there is no document, no separate invoice number.
- Case 5 (menu "resizes or adapts across devices"): `navCheck(4)` only proves every menu item opens.
- Case 7 (CRM "personalized suggestions or quotes"): only quotes reflect the change; no suggestions.

## Misses
- `node kind`: document generation (voucher/invoice as a file), and layout/responsive knobs.
- `composition`: request handling from the inbox to a customer and a quote would be an action with
  `db.ensure` on Customer + `db.createRow` on Booking; expressible, left out for compactness.
- Observed, not a format gap: form pages never render the flash, so a `form.after` that lands on a
  form (`"/"` when home is `/Request/new`) loses the confirmation; landing on `/Request/{id}` shows it.

## New for this app
- `home` pointing at a create form (the homepage is the request form).
- Derived money fields chained on the same row (`total := hotel + golf + flights + transport + extras`),
  three-hop paths (`package.hotel.rate`), `if()` on an enum and on a bool, `coalesce` over optional
  references, `{row.package.hotel.name}` in mail text; two state machines in one graph.
