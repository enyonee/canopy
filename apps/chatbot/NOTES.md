# chatbot — webgen-bench/000024

## Weakened cases
- Cases 1–4 (typing into the chatbot): there is no dialogue engine. The chat is a conversation page with a one-field message form; a `Message.created` event matches the typed text against the Answer table and links the reply, which the derived `reply` field shows in the same row (fallback text when nothing matched). Matching is `like`, which only means "field contains value", so the typed text must be contained in a known question: the verbatim questions of the cases match, a paraphrase ("how do I send something back?") gets the fallback. Each check types the case's text and asserts the reply cell.
- Case 2 ("guides the user through the order placement process"): the guidance is one static reply, not an interactive multi-turn flow. The check additionally follows the guidance and places an order through the Orders form.
- Case 1 ("without delay"): the reply is computed in the same request; there is no live chat widget, the page reloads.

## Misses
- `node kind`: a chat interface (message thread with an input and no reload; multi-turn state).
- `block`: keyword or intent matching — a `contains(text, keyword)` expression function or a `text.match` block; `like` cannot test "message contains keyword", so per-answer keyword lists are not expressible.
- `block`: writing a field of an arbitrary row (`db.update` only touches the current row); needed to store the matched answer on a message created earlier in the same action. Solved by moving the match into the `Message.created` event, where the message is the current row (composition).
- `composition`: product information in replies is static text in the Answer table; a list of rows cannot be rendered into text, so it is not derived from the Product table.
- `node kind`: AI integration (an LLM answering free text) — outside a closed graph by design.

## New for this app
- An event running `db.each` with a `like` where clause bound to `@row.text`, and a nested `db.update` of the current row.
- A derived text field with a string-literal fallback: `text := coalesce(answer.reply, '…')`.
- `home` pointing at a detail page (`/Chat/1`), so the conversation is the landing page.
- A related inline form with a single field used as the chat input; a derived money field through a reference (`qty * product.price`).
