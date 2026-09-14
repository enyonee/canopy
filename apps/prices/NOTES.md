# prices — webgen-bench/000036

## Weakened cases
- Case 1 (search by category and parameter → names, prices, suppliers): the product list shows name, category, lowest price and offer count; the suppliers appear one click further, on the product's offers (the check follows that link). A list cannot show columns of child rows.
- Case 2 (compare prices across states): the comparison is the offers list sorted by price with the cheapest offer marked by a derived bool; there is no side-by-side grid per state.
- Case 3 (search frequency): the setting is saved on the identity profile and shown afterwards; nothing runs at that frequency. "Subsequent searches occur at the new frequency" is not tested because it is not built.

## Misses
- Automatic, scheduled price searches — `node kind` (a scheduler / timer trigger; events fire only on created/updated/deleted).
- Fetching prices from external sources ("API Integration") — `connector` (an inbound/pull connector; `http` only sends).
- "Which state has the lowest price" as a field on the product — `block` (an argmin aggregate: `min(Offer: price)` returns the number, not the row); modelled instead as a derived bool on the offer.

## New for this app
- A range filter on a derived money field (`lowest`), narrowed in memory.
- A derived bool through a hop to the parent's derived aggregate (`price = product.lowest`) with `labels` captions on a list and on a detail page.
- `identity` used as the settings page: the profile list with edit only, `afterEdit`/`confirmEdit`.
