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

## Next candidates

| Order | Candidate | What to prove before switching |
|---|---|---|
| 1 | [`@adyen/api-library`](https://github.com/Adyen/adyen-node-api-library) | MIT and a custom HTTP client. Prove the three existing operations: create/get Pay by Link and refund with the existing idempotency and `Retry-After`. |
| 2 | [`@paypal/paypal-server-sdk`](https://github.com/paypal/PayPal-TypeScript-Server-SDK) | Keep the HTTP descriptor for now: npm metadata for 2.5.0 says MIT, but the published tarball's `package/LICENSE` contains PayPal's SDK terms. Resolve distribution terms before adopting and prove exact Orders/Payments coverage, including ambiguous capture/refund recovery. |
| 3 | [`@mollie/api-client`](https://github.com/mollie/mollie-api-node), [`@googleapis/sheets`](https://github.com/googleapis/google-api-nodejs-client), [`@shopify/admin-api-client`](https://github.com/Shopify/shopify-app-js) | Mollie calls its Node client community-maintained; check endpoint and status mapping. Pilot the per-API Sheets and Shopify Admin packages inside their existing bridges, retaining tenant scope. |
| 4 | [Ajv](https://ajv.js.org/guide/managing-schemas.html), [Scalar OpenAPI parser](https://github.com/scalar/scalar/blob/main/packages/openapi-parser/README.md) | Compare schema acceptance and exact diagnostic ordering against the interpreter. Compile at descriptor load. Keep the importer offline and do not dereference remote URLs or files outside the input. |

Use regional provider SDKs only when the required operations and licensing are
verified. An SDK's existence alone is not a reason to replace a bounded
descriptor. [n8n's license](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
requires a separate review before reusing its implementation in this MIT project.
