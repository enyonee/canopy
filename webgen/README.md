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

Settings that are not in the graph go in `<web>/webgen.config.json`, read on every run: `{ "currency": "EUR",
"locale": "de-DE" }`. A currency named by a connector of the graph takes precedence.
