# polls — webgen-bench/000026

## Weakened cases
- **Case 3 (cast a vote).** There is no login, so a "voter" is not identified; nothing
  stops the same visitor from voting on the same option more than once (no session to
  key a uniqueness rule on). The check only asserts that a vote is recorded and the
  tally updates, not that repeat voting is prevented.

## Misses
- `node kind` — no chart/graph node exists (confirmed absent from the catalog in
  REPORT.md's own miss summary), so "graphical representation" of results is a
  `percent` column next to the raw count, not a bar chart.
- `block` — nothing enforces one vote per visitor without login/session identity;
  this would need a `roles`-backed voter or a client-side fingerprint the format
  doesn't have a primitive for.

## New for this app
- Vote counting is **entirely derived, nothing stored redundantly**, per the brief:
  `Option.votes := count(Vote)` (a plain child aggregate) and
  `Poll.totalVotes := sum(Option: votes)` — an aggregate **over a child's own derived
  field**, confirmed to work without a dependency cycle (the runtime's per-field
  `stack` tracks `entity:id:field`, not the whole row, so `Option.percent` reading
  `poll.totalVotes` while `Poll.totalVotes` reads every sibling `Option.votes` is not
  a cycle: no field ever depends on itself).
- `Option.percent := round(votes * 100 / poll.totalVotes, 0)` hops through a
  reference to a derived field on the parent; division by zero (`totalVotes = 0`
  before any vote) evaluates to `null` rather than crashing, per the expression
  algebra's null propagation for arithmetic.
- A named row action (`vote`, `in: "Option"`) exposed only inside a `related` table
  (`Poll.detail.related[].rowActions`), the same mechanism `qna`'s upvote/downvote
  uses, with `{poll}` substituted in `after` from the acted-on `Option` row's own
  `ref:Poll` field.
