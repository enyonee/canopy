# barber — webgen-bench/000049

## Weakened cases

- None of the four `ui_instruct` cases needed weakening: adding a barber and a service are
  driven through the real create forms, navigation is the real menu, and the colour check reads
  the real stylesheet.

## Misses

- `node kind` / `connector` — there is no WhatsApp integration (no such connector kind exists,
  and none should: it would be a whole external API, not a protocol primitive). "Sending a
  WhatsApp notification" is implemented as the closest honest thing: a row action on a client
  that records the message (`Notification`) and queues it through a real outgoing `http`
  connector to the sandbox sink (`plugins/payment.mjs`'s sibling pattern — an app declares its
  own connector, no plugin needed since `http.send` is core). It is not exercised by a check
  because it is not one of the four `ui_instruct` cases for this task; the feature exists in the
  graph (`actions.notify`, `Client.detail.actions`, `connectors.whatsapp`) for a human to read.
- `composition` — the row-action button the scaffold renders for `notify` carries no text input,
  so a real client message can only be supplied by POSTing `values.message` directly (as `crm`
  and `travel`'s row actions already do for their own free parameters); the button falls back to
  a sensible default message.

## New for this app

- No `roles` and no `identity`: a purely open admin console (`can` is absent entirely), matching
  the instruction's framing of a single back-office user with no login concept — closest to
  `apps/internships`'s shape among the existing apps.
- An app-declared `http` connector used directly by a plain action (`http.send`), with no plugin
  involved — the plain "connector, real delivery, /outbox status" story from `docs/FORMAT.md`,
  reused for a non-payment, non-mail external effect.
