# shop — reference app for the shop class (no task number)

A storefront for guests, the cart as a draft order, checkout as transitions that take stock, pay, mail a confirmation
and notify fulfilment over HTTP; the admin sees every order, the sales dashboard and the outbox.

## Weakened cases
- A customer may still change the quantity of, or delete, a line of their own order after it is placed or paid: the
  `OrderItem` grant is scoped to the owner, not to the order's status.

## Misses
- `composition`: a child row is not owned through its parent by itself. `OrderItem` had `["view", "edit", "delete"]`
  for every customer with no `own`, so `/OrderItem` (hidden from the menu only) and its JSON answer listed every
  customer's cart lines, and any customer could edit or delete them by id (SEC1). The grant now names the owner one
  hop away, `"own": "order.customer"`; check 8 ("A customer sees only their own orders…") proves another customer
  sees none of the lines (HTML and JSON) and gets 403 on reading, editing and deleting one.

## New for this app
- The reference for one-hop ownership (`"own": "order.customer"`) on a child entity created only by an action.
