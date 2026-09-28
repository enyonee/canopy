# qna — webgen-bench/000033

## Weakened cases
- None. Every case is driven through the real routes; "rate the answers" (in the instruction, not a ui_instruct case) is covered inside case 4 as +1/-1 row actions.

## Misses
- None.

## New for this app
- `max(Answer: rating)` as a derived best-rating column next to `count(Answer)`.
- `db.adjust` with a negative `by` for the down-vote, with `after: "/Question/{question}"` reading the child's reference to land back on the parent.
- A related section whose `rowActions` are two declared actions plus `delete`, so the change patch can hand `delete` to a moderator who cannot create.
- Round 5: `own` grew `all`, closing the one documented Miss. `member.Question` is now
  `{"own": "author", "can": ["edit", "delete"], "all": ["view", "create"]}` — everyone still
  reads and asks questions unscoped, but a member may now edit or delete only their own
  question (`own`'s auto-fill replaced the form's `fill: {"author": "@me"}`).
