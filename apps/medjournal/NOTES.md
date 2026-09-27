# medjournal — webgen-bench/000086

## Weakened cases

- **Case 3 (update profile within the author's account).** The account row is the
  `User` row itself, kept editable to the owner through a self-reference
  (`own: "self"`, filled by an event on `User.created`) rather than a separate
  profile entity — an author edits email, name, affiliation and bio directly; the
  role field is never on the form, so this cannot be used to self-promote.
- **Case 4 (WCAG compliance via an online tool).** No accessibility-checker
  integration exists (nor is one buildable inside a closed graph). Read instead as
  the structural basics such a tool checks first: the page declares a language
  and every form control has a real `<label for="...">`.

## Misses

- `node kind` — no per-article-download counter or access log.
- `composition` — an admin edits "everything" per the note, but there is no admin
  dashboard; `roles.can.admin: "*"` gives full CRUD through the ordinary screens
  only.

## New for this app

- Self-ownership: a `ref:User` field on `User` itself (`self`), filled by
  `events: [{on: "User.created", do: [db.update set self=@row.id]}]`, is the `own`
  target for the account form — the only entity a role can edit despite the
  create route matching a different fake constraint, since it points at the row
  itself rather than at a distinct owner entity.
- A `file` field (`pdf`) with no `image` counterpart, downloaded through
  `/file/Entity/:id/field` with its original name in the `content-disposition`.
- `Section.detail.related` with `"form": false` — a read-only child table (every
  article in the section), no inline add form.
