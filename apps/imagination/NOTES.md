# imagination — webgen-bench/000093

## Weakened cases

- **Case 4 ("Real-time Features" category tag).** Navigation and messaging are ordinary
  request/response; there is no live update.
- **Case 5 ("notification displayed to the recipient").** As in apps/sportsrecruit, there is no
  push/poll channel, so the notification is a derived unread counter
  (`count(Message.to: not read)`) visible on the recipient's own directory row and inbox, read
  on the next request rather than pushed.

## Misses

- `node kind`: no real-time channel — same gap as apps/sportsrecruit, not attempted here either.
- `composition`: the "Interactions" section is the member directory with a `contact` button per
  row, not a dedicated interaction feed; "interacting" is scoped to messaging (voting/liking
  content, which other apps in this batch use as their "interaction" verb, is not part of this
  task's ui_instruct so it was not added just to pad out the section).

## New for this app

- One more confirmation of the two messaging idioms this batch converged on, both reused
  as-is: `own: "to"` + action-based creation for private member-to-member messages
  (apps/matrimony, apps/sportsrecruit), and a qualified correlated aggregate for the unread
  count (`count(Message.to: not read)`, apps/sportsrecruit).
- A `related` child-comment form scoped by `fill: {author: "@me"}` under a `Discussion`,
  functionally identical to apps/qna's `Answer`-under-`Question` — reused verbatim to confirm
  the idiom generalizes to a different domain (community discussion vs. Q&A).
- One flaky-looking failure while developing this app's checks turned out to be environmental,
  not a graph or runtime bug: a leftover server process from manual `curl` testing on a port
  this session had already moved on from was still holding the app's `data.sqlite` when
  `verify/run.mjs` started a fresh boot, and the derived `unread` field briefly read back as
  empty/NULL instead of `0` on one run. Re-running after making sure every manually-started
  `node runtime/run.mjs` background process was actually dead made it disappear and it did not
  recur across repeated runs; recorded here in case another agent sees the same "derived int
  renders blank instead of 0" symptom and suspects the graph first — check for a stray process
  on the port before touching the app.json.
