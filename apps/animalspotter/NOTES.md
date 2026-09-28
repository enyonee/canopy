# animalspotter — webgen-bench/000094

## Weakened cases
- Case 1/2 ("recognizes wild animals... in a video stream"): there is no video/AI pipeline —
  "recognition" is the `schedule`'s deterministic ingestion of one fixed species (Fox) per tick,
  per the brief's instruction that real-time animal detections are a schedule, triggered by hand
  in checks (`AG_NO_TIMERS=1`). The colour code is a plain assigned `text` field per species
  (e.g. "Orange"), not a rendered swatch — the scaffold has no per-cell inline styling, so the
  code itself (the value a person or a check can read) stands in for a visual highlight.

## Misses
- `field kind`: no colour-swatch/inline-style rendering for a `text` field — a colour "code" is
  shown as its name/value, not a coloured mark.

## New for this app
- The runtime bug this app found and reported (`db.createRow` did not fire `events:
  <Entity>.created`, silently breaking any "on creation, fan out and notify" design that creates a
  row from an action/schedule/another event rather than a plain HTTP form post) is fixed in round
  5: `db.createRow`/`db.create`/`db.ensure` now fire their entity's own event from any block. The
  schedule no longer inlines the alert-matching `db.each`/`sms.send` steps after its own
  `db.createRow` — they moved to the separate `events: [{ "on": "Detection.created", ... }]` block
  that was the first, more natural design attempt (see the schedule's own `note` in app.json),
  decoupling "ingest a detection" from "notify whoever asked for this species", each independently
  testable and reusable (an HTTP-created `Detection`, were one ever added, would now fan out too).
- First app in this batch to combine `schedule` with `roles`+`events`-style fan-out, and the shared
  `plugins/messaging.mjs` `sms.send` block; confirms the outbox records `kind: "sms"` rows with
  `to`/`text` exactly as documented.
- A schedule that creates a row and an event on that same entity's `created` trigger that reacts to
  it, both exercised by one `POST /schedule/detect/run` — demonstrating a schedule's own writes are
  full graph citizens, not a side channel that bypasses the rest of the graph.
