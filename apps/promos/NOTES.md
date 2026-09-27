# promos — webgen-bench/000027

## Weakened cases

- **Case 3 (share a promotion).** "The provided form with all necessary details"
  is the derived screen's create form (`Promotion.form.fields`); there is no
  moderation step before it appears on the board (an event mails moderation
  instead, see New).
- **Case 5 (backend user management).** "The backend" is the ordinary `/User`
  screen under the admin's `roles.can: "*"`, not a separate admin area; the admin
  edits name and role like any other field (the role select on `User.form` is
  therefore left in, unlike an app where a non-admin also edits their own row —
  here only the admin ever reaches `/User/:id/edit`).

## Misses

- `composition` — no moderation/approval state before a promotion is live;
  `states.Promotion` starts at `live` directly.
- `node kind` — no image field for a promotion or a merchant logo.

## New for this app

- A `Setting` entity as data, not configuration: "site settings" in the task
  becomes ordinary rows (`name`, `value`, `about`) editable through the admin's
  CRUD screen — the format has no separate config-node, so key/value rows are
  the closed-graph way to make "settings" editable at all.
- `events: Promotion.created` sends a moderation email via `mail.send`, read as
  "shared and visible to all users" (case 3) plus a paper trail for moderators.
- `states.Promotion` with three terminal-ish transitions from two different
  statuses each (`remove` from `live` or `expired`; `relist` from `expired` or
  `removed`, asking for a new `expiresAt` on the transition form).
- A saved list scoped to `@me` alongside a public one and an admin one over the
  same entity (`top-deals` public, `my-promotions` member-owned, `board` admin,
  each with a different `where` and `rowActions`).
