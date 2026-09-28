# vocab — webgen-bench/000060

## Weakened cases

- **Crossword (one of the five activities).** Rendered as a numbered list of definitions,
  each with its own boxed-letter-style `<input>` graded as a whole word against `Word.term`
  — not a single interlocking grid where two words share a cell's letter. The format has no
  grid/coordinate field kind, and reconciling two independent inputs at a shared cell is a
  UI-consistency problem the graph has no way to referee; every clue is still an honest,
  independently graded question.
- **"Persists through session reloads" (avatar case).** There is no session at all here
  (`identity`, not `roles`): the single simulated visitor's `Profile` row is just always the
  same row, so "persists through reloads" is really "the server remembers it, unconditionally"
  — weaker than a real per-visitor session surviving would be, but the strongest claim an
  identity-only app can honestly make.
- **The waiting-room game keeps no server-side score.** It is a plain click-counter with no
  win condition worth grading remotely (see Misses) — this is the one interactive piece in
  the app that is *not* backed by a plugin block, unlike every quiz.

## Misses

- `composition` — a widget's `props` are static per-node values; the five quiz pages all read
  "this week's" word set by fetching `/WordSet` themselves and taking the highest `week`,
  because there is no way to declare "the row with the maximum X" as a literal prop.
- `block` — none for the waiting-room game: it has no rule a server needs to referee (no
  score is recorded, nothing else in the app reads its outcome), so it is the one widget
  interaction in this app's five that stays entirely client-side, by design rather than
  omission.
- `field kind` — no way to seed a `file`/`image` field with real bytes, so avatars are a fixed
  `enum` (an emoji per value) rather than an uploaded picture; a closed set fits "choose an
  avatar" perfectly well regardless.

## New for this app

- **One global action shared by five different activity kinds**: `submitQuiz`'s `kind`,
  `wordSet` and `answers` are all `"@values.*"`, not literals — the single `vocab.grade` block
  branches on the submitted `kind` itself, so five otherwise-unrelated UIs (matching,
  fill-in-the-blank, unjumble, crossword, flashcard) share one action, one block and one
  `Attempt` log.
- A block parameter that is a **JSON-encoded array** (`answers`) rather than a scalar —
  the graph has no native "list of objects" step value, so the widget serializes its answers
  with `JSON.stringify` and the block parses them back with `JSON.parse`, refusing (400) on
  malformed input the same way any other block refusal would.
- A derived field over another derived-adjacent pair in the same row:
  `"pct": "int := round(score * 100 / total, 0)"`, read by a dashboard card's `avg`.
- Two widgets registered by the same plugin, attached to six different `pages` nodes (five
  quiz pages sharing one widget name distinguished only by a prop, plus a second, unrelated
  widget for the waiting room) — the first app in the repo to reuse one widget across more
  than one page.
