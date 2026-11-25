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

- **Storefront.** A hero on the home list, in the theme's gradient. Its title is the list title. Its subtitle is the
  list's `intro`, else the first page's heading or text, else counts. The developer `note` is not shown. The first
  reference filter becomes the hero's quick links. Cards have a cover: an `image` field, or a deterministic SVG
  from the hash of the name with an icon from the category name. Each card shows a category badge, the price large
  and a stock chip (an int named stock, quantity, …). The product page shows the cover, or a gallery when there
  are several `image` fields. Shop-internal booleans are hidden from shoppers.
- **Workspace.** Tables with avatars and subtitles, zebra rows and a sticky header. Status colours follow the order
  of `states`, and charts of a status group use the same colours. KPI cards have an icon. A card whose entity the
  dashboard's `period` narrows gets a 6-month sparkline: six GETs of the same dashboard, run in parallel and cached
  by TanStack Query. The sparkline is drawn only when at least 3 months are non-zero, and the trend shows only
  against a non-zero previous month. Charts use the theme palette with gradient fills. The menu is in groups:
  Store, Workspace, Insights, Pages, Admin.

The font is Inter, bundled from `@fontsource-variable/inter` (OFL-1.1), with no CDN. Motion respects
`prefers-reduced-motion`.

Settings that are not in the graph go in `<web>/webgen.config.json`, read on every run: `{ "currency": "EUR",
"locale": "de-DE" }`. A currency named by a connector of the graph takes precedence.

The bundle carries the graph's `roles.can` matrix, so the browser can decide which buttons to offer. This is
acceptable: the stand already shows the same permissions, and the server checks every request.
Links to `/admin` (the stand) work once the runtime serves the front end at `/` (F2).
