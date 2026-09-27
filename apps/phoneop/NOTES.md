# phoneop — webgen-bench/000020

## Weakened cases

- **Case 1 (customer support chat tool).** There is no live chat/socket primitive in this
  format (steps run inside one HTTP request/response, nothing streams). "Initiate a chat
  session" is a `SupportRequest` create form; "receive a response... shortly" is the form's
  `confirm` flash ("a support agent will assist you shortly"), not a real conversation.
- Cases 2, 3, 4 checked as specified.

## Misses

- `node kind` — no live/streaming chat primitive; a support request is necessarily
  asynchronous (create-and-wait), not an in-page conversation.

## New for this app

- `identity` (a single fake current user, no login) used purely for account self-service:
  the home page links straight to the one seeded `Profile` row's known id (`/Profile/1`),
  and its generic detail/edit pages *are* "account management" — no extra entity needed.
