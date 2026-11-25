# webgen

This tool generates a React front end for a Canopy app from its graph (`app.json`) and its OpenAPI contract
(`GET /api/openapi.json`, or `node runtime/run.mjs <app.json> --openapi --out <file>`). It is an experiment, tried
on one app: `apps/shop`. webgen keeps its own dependencies, sits outside the runtime gates, and leaves the runtime
with zero dependencies.

```bash
cd webgen && npm ci
node webgen/gen.mjs apps/shop/app.json --openapi <file|url> --out apps/shop/web   # writes the project (+ openapi.json snapshot)
node webgen/gen.mjs apps/shop/app.json --openapi apps/shop/web/openapi.json --check  # exit 1 if anything would change
node webgen/check-contract.mjs apps/shop/app.json [--runtime <checkout>]             # snapshot, types and files vs the runtime
npm --prefix webgen test                                                             # generator tests (node --test)
node webgen/e2e/run.mjs --base http://127.0.0.1:5193                                 # shop scenarios in headless Chrome
```

The generated project uses React 19, Vite, TypeScript, Tailwind CSS 4, shadcn/ui on Radix, TanStack Router and Query,
`openapi-typescript` types and an `openapi-fetch` client. `dist/` is built with `npm run build` in the project and
committed. The runtime serves it at `/`, and the stand moves to `/admin`.

## What each graph node becomes

| node | screen |
|---|---|
| `data` | an entity: a list (`/E`), a detail page (`/E/:id`) and forms (`/E/new`, `/E/:id/edit`). The field kind sets the control and the display (money, enum badge, reference link, yes/no, percent, date). `!` means required |
| `rules` | simple checks such as `price >= 0` and `qty > 0` become bounds checked in the browser, with the rule's message. Other rules and `unique` are left to the server, and its 400 answer is shown next to the field or above the form |
| `override.*.list` | title, columns, search box (`?q=`), filters (selects for ref/enum/bool, from–to for ranges), sortable headers, `pageSize`, `rowActions`, `create`, `hidden` |
| `override.*.form` | fields, `byRole`, `fill` and the viewer's own field (neither is asked for), `submit`, `after` / `afterEdit` |
| `override.*.detail` | fields, `actions` and `private`. Each `related` table is read from `/api/E/:id/related/C`, with an edit dialog and an inline add form |
| `states` | a status badge and a progress stepper. A transition is a button only while the status is in `from` and the role is allowed (`by` / `go:`). Its `fields` are asked for in a dialog. A cancel-like transition asks for confirmation. A 409 is shown |
| `actions` (`in`) | row buttons, shown only where the viewer may run them. A visitor gets "Sign in to …" when a role they could take may run the action. `after` is followed |
| `roles` | sign in, registration (only fields without a default) and sign out. The menu and the buttons follow the `can` matrix |
| `lists` | `/list/<id>`, shown to the listed `roles` |
| `dashboards` | stat cards, grouped tables with a chart of the first metric, `charts`, and a period picker (from/to and presets) |
| `pages` | heading, body, links, global actions, and live sections (list preview, create form, text) |
| `theme` | `--brand-bg` and `--brand`. Every shadcn token, light and dark, is mixed from these two colours |
| `home`, `app` | the `/` redirect and the brand name |
| `search` | read into the model; v1 renders no search screen |

## Storefront or workspace

webgen picks each entity's look from the graph (`surface` in the model, `lib/model.mjs`). An entity is a
**storefront** when all of these hold:

- the visitor role (`roles.anonymous`) or the self-registration role (`roles.register`), when that role is not an
  admin, may `view` all of its rows (no `own`, or `view` in `all`);
- its list is in the menu;
- it reads like something offered: it has a `longtext`, `image` or `money` field, or a declared action that this
  role may run.

Everything else is a **workspace**: own records such as orders, and admin CRUD.

- **Storefront.** The catalogue opens with a title and a count, then category chips (more than six become a select),
  search and sort, and a grid of 2/3/4 columns. Cards keep the name and the price on two lines. The only badges are
  the exceptions (few left, sold out), and a quick "+" appears for an action the viewer may run. Pictures use a 4:5
  frame. Without an `image` field the card gets a lower 4:3 cover in the category's tone, with its icon. A hero shows
  only for a large catalogue (12 or more rows and 4 or more categories). The product page has the picture on 7/12
  (without photos, a square cover of at most 460 px plus the details as tiles) and a sticky buy box on 5/12: price,
  stock, one filled 48 px button, and tabs for the description and the details. On phones the buy box is a sticky
  bar. A guest gets "Sign in to …" only there. A record whose related rows point at storefront rows (an order, a
  cart) is shown as lines on 8/12 and a sticky summary on 4/12. The status stepper drops the initial status once the
  record has left it.
- **Workspace.** Tables have 48 px rows, a sticky header, an avatar with a subtitle in the first column, status
  badges with a dot, a row menu, and "1–10 of N". The search and the filters sit above the table in the same card.
  KPI cards show the value large, a delta badge against the previous month (only when that month is not zero) and a
  sparkline (only with 7 or more months of history). The history is eight monthly GETs of the same dashboard, run in
  parallel and cached. Charts: an area for time, bars for categories, status groups in their status colours, and a
  big number or a table when there are fewer than 3 groups. Each chart has a "Show table" button. The period is a
  range picker in a popover. The sidebar runs the full height, folds to icons, and groups its items as Store,
  Workspace, Insights and Admin. One or two items go in the header instead.

**Colours.** `lib/theme.mjs` builds 12-step OKLCH scales from the graph's two theme colours, in light and dark. It
checks every pair the screens draw against WCAG 2.2 (68 per theme: text 4.5:1, UI parts and chart marks 3:1) and
moves the lightness until each pair passes. `test/theme.test.mjs` checks every app in `apps/`.

The font is Inter, bundled from `@fontsource-variable/inter` (OFL-1.1), with no CDN. Motion respects
`prefers-reduced-motion`.

Settings that are not in the graph go in `<web>/webgen.config.json`, read on every run: `{ "currency": "EUR",
"locale": "de-DE" }`. A currency named by a connector of the graph takes precedence.

The bundle carries the graph's `roles.can` matrix, so the browser can decide which buttons to offer. This is
acceptable: the stand already shows the same permissions, and the server checks every request.
Links to `/admin` (the stand) work once the runtime serves the front end at `/` (F2).
