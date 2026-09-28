# diagrams — webgen-bench/000079

## Weakened cases

- **Drag-and-drop (cases 3, 6).** Dragging is the widget's own mousedown/mousemove/mouseup
  handling, not the browser's native HTML5 `draggable`/`DataTransfer` API — the format gives a
  widget a plain DOM element and `api`, nothing that models native OS-level drag sessions, and
  a hand-rolled pointer drag is the honest way to get a real, testable drag gesture out of that.
- **Export (mentioned in the brief, not a numbered case).** There is no file-generation block
  in the format, so "export" is a client-only SVG → `data:` URI download link, never a server
  round trip.
- **Style palette (case 7).** Fill/stroke are free-form CSS colour keywords typed into a
  `<select>` from a fixed shortlist (plus whatever colour the node already has), not an open
  colour picker — `text` is the only field kind that fits a CSS colour, so there is no native
  colour-input widget to draw on.

## Misses

- `field kind` — no grid/coordinate/geometry type; node position is two plain `int` columns,
  which is enough for this app but would not scale to e.g. bezier edges.
- `composition` — an `events` hook fires on *every* update of the row it watches, not on "this
  field changed": `Diagram.updated` re-applies `diagram.layout` even when only the title was
  edited (harmless here because the block is idempotent for the current layout, but it is not
  the narrower trigger the UI implies — recorded, not hidden).
- `block` — no conditional/branching step composition; `diagram.layout`'s three arrangement
  formulas are one plugin block with an if/else in JS, not something the graph's own step
  language could express (the brief invites exactly this: "a matching algorithm/simulation
  step" as legitimate app-local plugin code).
- `composition` — deleting a node whose edges reference it: the widget deletes the dependent
  `Edge` rows itself (client-side, two extra requests) before deleting the `Node`; the format
  has no cascade-delete declaration, so an unguarded `Node` delete would either orphan an edge
  or refuse (untested which, since the widget never lets it happen).

## New for this app

- First app-local plugin registering **only** a widget with **no** custom action/JSON route
  behind it beyond the core CRUD routes every entity already has: `POST /Node`,
  `POST /Node/:id`, `POST /Node/:id/delete` (and the same for `Edge`) are the entirety of the
  widget's server surface: add, move, restyle and remove are all just standard entity writes,
  called with `accept: application/json` from the widget's own `api.post`.
- A page/detail widget prop-free design: everything the widget needs (`row.type`,
  `row.layout`, the node/edge lists) comes from the row JSON and a plain `api.get` of the
  child entities filtered by `?diagram=<id>` — no widget `props` were needed at all.
- `events: "Entity.updated"` driving a plugin block that writes to a *different* entity
  (`Node`) than the one the event fired on (`Diagram`) — a cross-entity side effect from a
  single-entity trigger.
