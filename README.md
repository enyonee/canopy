# Canopy

Canopy runs applications defined by an `app.json` file. Describe the data, screens,
permissions and workflows; Canopy validates the graph, migrates a local SQLite database
and serves the app as HTML and a JSON API.

Use the built-in screens for tools such as a CRM, an approval workflow or a storefront.
Use the app's OpenAPI contract when you need a separate frontend. Integrations are
declared in the graph: outgoing effects go through an outbox after the transaction
commits, and configured webhooks can trigger workflows.

The [runtime architecture](runtime/ARCHITECTURE.md) describes the core rule:
effects are explicit graph nodes, and calculations are pure.

## Quick start

From the repository root, with Node.js 22 or later:

```bash
npm ci
node runtime/run.mjs apps/checkout/app.json --check
node runtime/run.mjs apps/checkout/app.json --port 8901
```

Open [the product list](http://127.0.0.1:8901/Product) or
[the JSON API](http://127.0.0.1:8901/api/Product). Sign in as
`admin@checkout.test` with password `admin123` to inspect the outbox.
This is a local demo: its Stripe, Postmark and Slack connectors use Canopy's
local sandbox, with no provider account required.

The runtime needs no build step. Use `npm ci --omit=dev` when you only need to
serve an app. By default, the app writes its state next to its graph. See the
[run guide](RUN.md#отдельный-каталог-состояния) to keep state outside the checkout.

## Define an app

Here is a small `app.json` with a calculated inventory value, a validation rule
and an initial record:

```json
{
  "app": "stockroom",
  "data": {
    "Product": {
      "name": "text!",
      "price": "money!",
      "stock": "int=0",
      "value": "money := price * stock"
    }
  },
  "rules": {
    "Product": [{ "check": "stock >= 0", "message": "Stock cannot be negative" }]
  },
  "seed": {
    "Product": [{ "name": "Blue mug", "price": 12.5, "stock": 10 }]
  }
}
```

Validate it with `node runtime/run.mjs /path/to/app.json --check`. Then replace
`--check` with `--port 8901` (or another free port) and open `/Product`.
This graph has no roles, so it is suitable for local experimentation only.
The [format reference](docs/FORMAT.md) covers roles, actions, state machines, schedules
and layouts.

| Example | What to look at |
| --- | --- |
| [Checkout](apps/checkout/app.json) | Payment events, email receipts and staff notifications |
| [CRM](apps/crm/app.json) | Pipeline, dashboards and a generated React frontend |
| [Shop](apps/shop/app.json) | Product catalog, customer orders and checkout |
| [Polls](apps/polls/app.json) | Public voting and calculated result totals |

## Connect external services

Start with the [business connector catalog](docs/BUSINESS-CONNECTORS.md) and the
[setup guide](docs/CONNECTORS.md#use-a-connector). The catalog covers payments,
CRM, commerce, messaging and external databases. Stripe and Adyen use their
official SDKs for live delivery. Some integrations use a separately run bridge.

The [payment guide](docs/PAYMENTS.md) covers hosted checkout, confirmation and
refunds. The [data source bridge](bridges/data-sources/README.md) documents
read operations and opt-in writes for supported databases. Those databases
are external integrations, not replacements for the app's internal SQLite store.

## Deployment

Canopy runs one Node process and one SQLite store per app and listens on loopback
by default. Back up the app's state, including uploaded files and the keys needed
to read encrypted secrets. Do not expose the sample accounts or run untrusted plugins.
For public access, put an HTTPS reverse proxy in front of the app and follow the
[deployment checklist](RUN.md#публичное-развёртывание).

## Documentation

- [Documentation index](docs/README.md): setup, authoring, integration and operations guides
- [Generated React frontend](webgen/README.md): generation, build and contract checks
- [Runtime architecture](runtime/ARCHITECTURE.md) and [dependencies](docs/DEPENDENCIES.md)
- [Contributing](CONTRIBUTING.md), [tests](TESTS.md) and [release history](CHANGELOG.md)

[MIT license](LICENSE)
