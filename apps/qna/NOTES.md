# qna — webgen-bench/000033

## Weakened cases
- None. Every case is driven through the real routes; "rate the answers" (in the instruction, not a ui_instruct case) is covered inside case 4 as +1/-1 row actions.

## Misses
- None for the base cases. Members cannot edit their own question without hiding everyone else's (`own` scopes view as well as edit) — `composition`; the graph gives members create-only and leaves editing to the admin.

## New for this app
- `max(Answer: rating)` as a derived best-rating column next to `count(Answer)`.
- `db.adjust` with a negative `by` for the down-vote, with `after: "/Question/{question}"` reading the child's reference to land back on the parent.
- A related section whose `rowActions` are two declared actions plus `delete`, so the change patch can hand `delete` to a moderator who cannot create.
