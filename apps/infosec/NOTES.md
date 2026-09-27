# infosec — webgen-bench/000055

## Weakened cases

- **Case 4 (chatbot "responds promptly").** There is no dialogue engine or live widget — the
  chat is a conversation page (a `Chat` with `Message` children) where a `Message.created`
  event matches the typed text against the `Answer` (FAQ) table with `like`, which only means
  "the seeded question contains the typed text"; the reply is computed in the same request and
  shown in the same row on reload, exactly the pattern in `apps/chatbot`. The check types the
  cases' exact question text (a paraphrase would fall through to the fallback reply) and reads
  the reply cell — this is the honest, data-driven treatment the brief asks for, not canned
  text: every reply traces to a seeded `Answer` row, and an unmatched question gets the
  derived fallback, never a fabricated answer.
- **Case 3 ("triggering a confirmation message or email").** Both: a flash confirms enrollment
  and an `Enrollment.created` event queues a real letter through the mail connector (visible,
  and asserted, in `/outbox`); there is no live SMTP delivery in the stand.
- **Case 6 (certification pathways "aligning with the courses offered").** Checked two ways:
  a static `pages` overview names all three credentials and links to the three courses, and —
  more importantly — each course's own `certification` field (data, not prose) is asserted on
  its own detail page, so the pathway text cannot drift from the course it describes.

## Misses

- `node kind`: no login/roles anywhere — the ui_instruct never asks for one, so the whole
  site is open (create/edit on every entity), the same choice `apps/teamshow` makes. Nothing
  stops a visitor from editing or deleting a Course or Answer row; not exercised by any check.
- `composition`: no on-view/on-GET hook exists in the format (only `Entity.created/updated/
  deleted`), so "reading history" / "last viewed" style tracking is unavailable if ever
  needed here — not required by this task, noted for completeness since the same gap recurs
  across this batch (see apps/startups).

## New for this app

- Reused `apps/chatbot`'s exact FAQ-matching idiom (`Message.created` event → `db.each` over
  `Answer` with a `like` where-clause bound to `@row.text` → nested `db.update` of the current
  row; a derived `reply` field with a string-literal `coalesce` fallback) against a genuinely
  different seed (course/enrollment FAQ instead of returns/orders).
- `mail.send`'s `to`/`subject`/`text` support the same `{row.field}` interpolation as an
  action's `confirm`, including one-hop references (`{row.course.title}`,
  `{row.course.certification}`) — confirmed by reading `runtime/server.mjs`'s `interpolate`/
  `refValue`, then proven live: the queued outbox letter is asserted to carry the interpolated
  course title, level, duration and certification text.
- A `related` block used purely for a **child create form with no list purpose beyond that**
  (`Course.detail`'s "Enrol in this course" section, `rowActions: []`) — the enrollment record
  itself is managed from the top-level `Enrollment.list`, not re-shown inline.
- Gotcha worth recording for later apps in this batch: the shared `rows()` test helper matches
  every `<tr>` on the page, including a detail view's own `<tr><th>Field</th><td>value</td></tr>`
  rows — counting "how many turns/items" on a detail page must filter to rows that
  `startsWith('<td>')` (as `apps/chatbot`'s own `turn()` helper already does), not just take
  `rows(html).length`.
