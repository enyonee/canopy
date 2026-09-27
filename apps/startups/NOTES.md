# startups — webgen-bench/000089

## Weakened cases

- **Case 4 (share to other platforms, "options for sharing... should be displayed").** There is
  no client-side share sheet in server-rendered HTML, and outgoing HTTP must target the verify
  sink, not a real social platform. `share` is one action that queues a real outbound request to
  a stand-in `shareHook` connector (visible in `/outbox`, exactly like any other outgoing effect)
  and confirms with a copyable permalink to the article. This is the closest honest rendering of
  "share a link" without a browser-side share API or a genuine third-party integration.
- **Case 7 (reading history, "as users read articles... appear in their reading history").**
  The format only fires events on `Entity.created/updated/deleted`, never on a passive GET — so
  opening an article cannot by itself log a history row. The closest honest equivalent is an
  explicit "Mark as read" action on the article page; the check clicks it rather than merely
  viewing the article. Marking is idempotent (`db.ensure`) so re-reading the same article does
  not duplicate the history entry — a reasonable reading of "history", not a workaround.
- **Case 8 (navigation).** Checked with the shared `navCheck` helper as the signed-in member
  from the reading-history case, not separately for guest and admin menus.

## Misses

- `node kind`: no on-view/on-GET hook — see above; recorded once here since it recurs in this
  batch (apps/infosec's notes point back to this entry rather than repeating the explanation).
- `composition`: a client-side share menu (social/email picker) cannot be expressed by a
  server-rendered form; the graph can only queue one outgoing request per click.
- `rule`: no compound uniqueness, so `db.ensure` is what keeps `collect`/`markRead` idempotent
  rather than a database constraint — fine here since both go through the ensure block, but
  worth flagging as the general limitation (a bare `create` permission on a join entity would
  allow duplicate rows).

## New for this app

- `db.ensure` used purely for idempotency on a two-key join row (`{user: "@me", article:
  "@row.id"}`) with no extra `values`, so a repeated action is a no-op rather than a duplicate —
  applied to both the collection (`Collection`) and the reading-history (`ReadHistory`) join
  entities.
- A join entity given only `own` + `view`/`delete` (no `create`) in the role's `can` map, with
  every row created exclusively through an action — the same idiom `apps/travel` uses for
  `Booking`, now applied to two different join entities in one app.
- `http.send` to a connector that stands in for an external, un-listable destination (a
  generic "share" webhook) rather than a payment or mail transport — confirmed live in
  `/outbox` with a `failed`/`fetch failed` status when no sink listens (expected outside the
  verify harness) and `sent` when one does.
