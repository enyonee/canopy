# healthblog — webgen-bench/000069

## Weakened cases

- **Case 6 (follow a topic).** "Follow" is a row action (`do:follow` implicitly, via the
  `follow` action declared on `Category`) that creates a `Follow` row for the single
  simulated visitor (`identity`, no login on this site — the instruction never asks for
  accounts) and shows up in the personal `/list/my-follows` saved list; there is no
  notification service, only the personal list the instruction itself offers as the
  alternative ("added to a personal list *or* notification service").
- **Case 2 (search a topic).** Search matches `title`/`body` substrings via the list's
  `search:` field, not semantic topic matching — "sleep" and "walk" are chosen because they
  are literal words in the seeded articles.

## Misses

- `node kind` — no de-duplication on `Follow` (following the same category twice creates two
  rows); the format's `unique` rule only covers a single field, not a field pair.
- `composition` — commenting and following both attribute to the one shared `identity`
  profile; there is no way to tell two different real visitors apart without introducing
  full `roles` login, which the task never asks for.

## New for this app

- A global-looking "follow" interaction implemented as an ordinary row `action`
  (`db.createRow` into a side entity) offered as a `rowActions` entry on the *parent*
  entity's list (`Category.list`), rather than on the entity the action's own `in` names —
  i.e. the action lives on `Category` and the personal list it feeds (`Follow`) is a
  different entity again.
