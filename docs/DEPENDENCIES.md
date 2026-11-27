# Library adapters

Canopy owns graph semantics, permissions, transactions, and delivery policy.
Libraries are implementation details of the matching subsystem. They do not
change the graph or bypass its outbox.

## In use

- [Stripe Node SDK](https://github.com/stripe/stripe-node), MIT, loaded on the
  first live send for the shipped Stripe descriptor. The descriptor still
  defines sandbox answers and schemas. The SDK sends all seven live operations
  on the existing Stripe API version; Canopy keeps the idempotency key,
  deadline, retry decisions, response projection, and inbound signature checks.
  Custom descriptors registered under the same name do not select the SDK.
- [Fastify Busboy](https://github.com/fastify/busboy), MIT, streams the browser
  form upload to disk. `AG_MAX_UPLOAD` is the byte limit per file (default 8 MiB).
  The whole request is capped at four times this value plus 1 MiB. Forms also
  have limits of 32 files, 128 fields, and 1 MiB per text field. The exact-byte
  JSON and webhook parsers do not use Busboy.
- [Adyen Node API Library](https://github.com/Adyen/adyen-node-api-library), MIT:
  SDK methods build all three live requests. The custom HTTP client keeps
  Checkout v71, the configured live origin, raw responses and Canopy retries.
- [Ajv](https://ajv.js.org/), MIT: compiles connector output checks on first
  use. The original diagnostic path still runs on rejection, and checking
  graph schemas, defaults and inputs is unchanged.
- [CSV Stringify](https://csv.js.org/stringify/), MIT: entity and saved-list
  exports select ordered ids once, then reapply filters and hydrate and encode
  up to 256 rows at a time. This reduces memory, but it is not a transaction
  snapshot: rows changed or deleted during export can be omitted or reflect
  their latest values. Derived sorting and filters retain the full-result path.
- [Google Sheets](https://github.com/googleapis/google-api-nodejs-client),
  Apache-2.0, and [Shopify Admin API](https://github.com/Shopify/shopify-app-js),
  MIT: the bridges use per-API SDKs. OAuth grants, account binding, raw Sheet
  writes, validation and data projections remain bridge responsibilities.
- [Puppeteer Core](https://pptr.dev/), Apache-2.0, is development-only. It
  launches installed Chrome for widget acceptance, with no browser download.

## Local measurements

Baseline: `4ddd88f`. Node 22.23.4, one pinned core, three alternating runs per
scenario, five warm-up operations per process. Stripe uses an in-memory
provider response; upload uses a 4 MiB request stream and local disk.
Each cell is the median of the three process results.

| Scenario | p50 (ms), before / after | p95 (ms), before / after | Peak RSS (MiB), before / after |
|---|---:|---:|---:|
| Stripe PaymentIntent lookup | 0.072 / 0.268 | 0.176 / 0.613 | 66.1 / 75.9 |
| Multipart 4 MiB upload | 7.35 / 4.66 | 15.76 / 16.78 | 120.2 / 62.0 |

Reproduce with `node bench/dependencies.mjs <checkout> <stripe|uploads>` on
the same CPU and disk. The benchmark asserts response fields and uploaded byte
counts; Stripe request parameters and all seven response contracts are also
compared in the test suite.

The second migration was measured against `9b375e0`, on Node 22.23.4, one
core, three alternating runs. The hashes of both CSV and JSON HTTP answers,
along with the projected provider replies, matched in every run.

| Scenario | Before | After |
|---|---:|---:|
| Map a 250-record reply, p50 | 402 us | 145 us |
| Map a 250-record reply, p95 batch | 509 us | 187 us |
| Export 12,000 rows (3.52 MB), total time | 147 ms | 213 ms |
| Export peak process RSS | 114 MiB | 101 MiB |

Reproduce with `node --expose-gc bench/csv-stream.mjs <checkout> 12000` and
`node bench/hotpaths.mjs <checkout> connector`. CSV favors lower peak memory
over total download time; the client and server share the benchmark process.

## Next candidates

| Order | Candidate | What to prove before switching |
|---|---|---|
| 1 | [`@mollie/api-client`](https://github.com/mollie/mollie-api-node) | Community-maintained according to Mollie; check endpoint and status mapping. |
| 2 | [Scalar OpenAPI parser](https://github.com/scalar/scalar/blob/main/packages/openapi-parser/README.md) | Keep the importer offline; do not dereference remote URLs or files outside the input. |
| 3 | [`@paypal/paypal-server-sdk`](https://github.com/paypal/PayPal-TypeScript-Server-SDK) | Keep HTTP for now: npm metadata for 2.5.0 says MIT, but the published tarball's `package/LICENSE` contains PayPal's SDK terms. Resolve distribution terms before adopting. |

Use regional provider SDKs only when the required operations and licensing are
verified. An SDK's existence alone is not a reason to replace a bounded
descriptor. [n8n's license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
requires a separate review before reusing its implementation in this MIT project.
