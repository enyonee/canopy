# htmleditor — webgen-bench/000081

## Weakened cases

- **Syntax highlighting (case 3).** A regex-based tokeniser over the raw source (tag names,
  attribute names, quoted attribute values, comments), each in its own coloured `<span>` next
  to a plain `<textarea>` — not a real HTML parser and not an in-place coloured editor (the
  textarea itself stays plain text, for reliable typing/cursor behaviour); the brief itself
  allows "simple tokenising in the client".
- **Text -> HTML conversion (case 1's "automatically convert to HTML").** Blank-line-separated
  blocks become `<p>` paragraphs with escaped text and `<br>` for internal line breaks — no
  attempt to recognise lists, headings or emphasis from plain text.
- **Live preview sandboxing.** The preview `<iframe>` uses `sandbox="allow-same-origin"`
  (renders markup/CSS, blocks script execution and form submission) rather than an empty
  `sandbox`, so that the same widget — and this app's own checks — can still read
  `contentDocument` to confirm what rendered; an empty sandbox gives the iframe an opaque
  origin that even same-page JS cannot inspect.

## Misses

- `block` — none needed: saving, template-marking and the text<->HTML conversion are all
  either a plain field write (the core edit route) or a pure client function with nothing a
  server referee would check. Recorded as a miss only in the sense that this is the first
  widget app in the repo with an *empty* domain-logic surface — the plugin registers a widget
  and nothing else.
- `field kind` — no "file the graph can seed with real bytes" for `image`/`file` fields: an
  `Image` row needs an actual upload, so the seed starts with zero images per project (a
  living project still has real Documents; the gallery is empty until someone uploads, which
  is itself realistic for a fresh project).
- `composition` — a related-add form (`Project.detail`'s `related`) has no way to default
  `Document.content` to something other than the field's own static spec default; every
  document created from a project's page starts from the same boilerplate, not a
  per-project starter template.

## New for this app

- A plugin that registers **only** a widget, no blocks and no functions at all — the leanest
  possible plugin, used purely to get a `client` file onto the registry.
- `"content": "longtext=<h1>New document</h1>..."` — an HTML-bearing string as a field's
  default literal.
- A widget with two independent client-side buffers (HTML source, derived plain text) that
  intentionally do *not* stay in sync except on an explicit user action — the opposite of the
  usual "one row, one truth" a widget prop/row normally gives for free.
