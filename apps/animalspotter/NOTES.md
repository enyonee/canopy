# animalspotter — webgen-bench/000094

## Weakened cases
- Case 1/2 ("recognizes wild animals... in a video stream"): there is no video/AI pipeline —
  "recognition" is the `schedule`'s deterministic ingestion of one fixed species (Fox) per tick,
  per the brief's instruction that real-time animal detections are a schedule, triggered by hand
  in checks (`AG_NO_TIMERS=1`). The colour code is a plain assigned `text` field per species
  (e.g. "Orange"), not a rendered swatch — the scaffold has no per-cell inline styling, so the
  code itself (the value a person or a check can read) stands in for a visual highlight.

## Misses
- **Runtime bug, not a graph limitation** (found while building this app): `db.createRow` does
  not fire `events: <Entity>.created` — only a form-posted `POST /Entity` (via `createRoute` in
  `runtime/routes/entity.mjs`) calls `interp.fireEvents('created', ...)`; the `db.createRow` block
  (`runtime/blocks.mjs`) just calls `store.insert()` directly. This silently breaks any
  "on creation, fan out and notify" design that creates the row from an action/schedule/another
  event rather than a plain HTTP form post. Worked around here by inlining the alert-matching
  `db.each`/`sms.send` steps directly in the schedule after the `db.createRow`, instead of using a
  separate `events: [{ "on": "Detection.created", ... }]` block (which was the first, more natural
  design and silently never fired). Recommend either firing events from `db.createRow` too, or
  documenting in `docs/FORMAT.md` that `events` only observes HTTP-originated creates.
- `field kind`: no colour-swatch/inline-style rendering for a `text` field — a colour "code" is
  shown as its name/value, not a coloured mark.

## New for this app
- First app in this batch to combine `schedule` with `roles`+`events`-style fan-out (worked
  around, see Misses) and the shared `plugins/messaging.mjs` `sms.send` block; confirms the
  outbox records `kind: "sms"` rows with `to`/`text` exactly as documented.
- A schedule step sequence with two independent top-level `db.each` blocks in one `do` list (one
  over the single-row "camera" singleton to ingest+evolve, one over `AlertRule` to match+alert),
  demonstrating a schedule is not limited to one block or one entity per run.
