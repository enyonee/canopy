# leads — webgen-bench/000023

## Weakened cases
- Case 2 (automated message sending): the letter is queued through the `mail` connector and recorded in the outbox as `sent`; nothing is carried by SMTP on the stand. "Automated" means fired by the `Lead.created` event and by a one-click action on the lead; there is no scheduled or drip sending. The check tests the flash and the outbox rows.
- Case 4 (best practice and integration advice): a static page authored in the graph; "receive advice" is reading it. The check tests the menu link, the heading and that both kinds of advice are on the page.
- Instruction-level, not a case: "updating settings and dropdown menus" — only the category dropdown is editable at runtime (a Category table that also carries the wording of the automated message); the source and status dropdowns are enums fixed in the graph.

## Misses
- `node kind`: runtime-editable enum options (a settings screen for `source`/`status`); modelled with a reference table instead.
- `node kind`: scheduled or delayed sending (follow-up sequences, reminders) — there are no timers or jobs.
- `composition`: message templates as data — the subject and the framing sentence live in the graph (`mail.send`), only the body is pulled from a row through `{row.category.pitch}`; a template entity chosen per message is not reachable from `mail.send`.
- `node kind`: list pagination (the task is filed under "Big Data"; lists render every row).

## New for this app
- `pages` with `body` paragraphs and `links` (shop/crm had no static pages).
- An `events` step that mails (`mail.send` on `Lead.created`; crm's event used `http.send`).
- Two-hop interpolation in a letter (`{row.category.pitch}`).
- An app with neither `roles` nor `identity`: every page, including the outbox, is open.
- A transition with `fields` on a money field (`propose` asks for `value`).
