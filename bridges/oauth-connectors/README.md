# Business connector OAuth bridge

Run `node bridges/oauth-connectors/server.mjs` on the same loopback
interface as Canopy. Set `CANOPY_OAUTH_DATA_TOKEN` to a random value of
at least 24 printable characters and map it to the descriptor's
`operatorToken` secret. The data API binds `127.0.0.1:8905` only.
Set `CANOPY_OAUTH_SECRETS_DIR` to a dedicated private absolute directory
(mode 0700). The bridge uses the encrypted Canopy secret store therein.
The directory and master key must not be shared with another process
writing to the same store. Do not expose either bridge port or log requests.

For a provider requiring user consent, the bridge starts a separate admin
API at `127.0.0.1:8906` using `CANOPY_OAUTH_ADMIN_TOKEN`. This must differ
from the data token and must not be stored in the Canopy app. Start consent
with authenticated `POST /<provider>/begin` and a JSON object. Follow the
returned URL in a browser and complete authorization. Pass the exact final
redirect URL as JSON field `callback` to authenticated
`POST /<provider>/finish`. The registered callback should be an
operator-controlled page with no query logging. The bridge accepts the
one-time authorization code only for its registered redirect and short-lived
pending state; access and refresh tokens are never returned.

## Shopify

Set `SHOPIFY_SHOP` (the first label of the store's `myshopify.com` domain),
`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`. Install the app in your
own Shopify organization with `read_orders` and `read_inventory`.
This descriptor uses the [client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).
It does not use customer-store installation or an embedded app session.
The Shopify API is pinned to GraphQL Admin 2026-10, based on
[the official SDK, MIT](https://github.com/Shopify/shopify-app-js/tree/70e0d6b9bf848c605530b2855eaecbd11713d3f6).
Use Shopify GIDs for orders, inventory items and locations. The list operation
returns an empty next cursor at the last page. Customer contact fields and
payment instruments are not requested or retained. This connector is read-only.

## Google Sheets

Enable the Sheets API in Google Cloud and register the OAuth web application.
Set `GOOGLE_SHEETS_CLIENT_ID`, `GOOGLE_SHEETS_CLIENT_SECRET`,
`GOOGLE_SHEETS_REDIRECT_URI`, `GOOGLE_SHEETS_SPREADSHEET_ID` and
`GOOGLE_SHEETS_SHEET`. The bridge requests the spreadsheets scope and
offline consent, and limits its own operations to the configured sheet
even though OAuth grants access to the user's spreadsheets.

Use `readRows` for bounded pages of columns A through T and `appendRow`
for up to 20 scalar values. Appends use RAW input, have no automatic replay,
and should be reconciled before retrying an ambiguous result. The
[Activepieces implementation, MIT](https://github.com/activepieces/activepieces/tree/90afd9219c93ef0aa63e08ab113831fa43fd4bf6/packages/pieces/community/google-sheets)
and [Sheets v4 API](https://developers.google.com/workspace/sheets/api/reference/rest)
are the references.

## amoCRM

Set `AMOCRM_PORTAL` to the account's subdomain under `amocrm.ru` and
configure `AMOCRM_CLIENT_ID`, `AMOCRM_CLIENT_SECRET`, and
`AMOCRM_REDIRECT_URI` as registered for the integration. Start consent
for `amocrm` and select that account in the provider window. The callback's
referer must match this account exactly. The bridge follows amoCRM's
documented redirect and rotating JSON token exchange for this integration.

Use the portal's numeric pipeline and stage IDs. `setDealStage` returns
the accepted deal ID; confirm the updated stage through `getDeal`.
Create and stage-change requests do not replay after ambiguity. Restrict
access to contacts and their queued inputs. See the
[official PHP client, MIT](https://github.com/amocrm/amocrm-api-php/tree/a0072fec651b84500c6767f98bbab6d1c8df9ce4),
[onboarding](https://www.amocrm.ru/developers/content/oauth/step-by-step),
and [API v4](https://www.amocrm.ru/developers/content/crm_platform/api-reference).

## QuickBooks Online and Xero

For QuickBooks configure `QUICKBOOKS_REALM_ID` to the company ID and
`QUICKBOOKS_HOME_CURRENCY` to the company's actual home currency. It is
used only when a single-currency invoice has no currency field.
Set `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` and
`QUICKBOOKS_REDIRECT_URI`. For a development company and credentials set
`QUICKBOOKS_SANDBOX=1`. Consent requires the accounting scope and the
callback's realm ID must match.

For Xero set `XERO_TENANT_ID` to the authorized organisation's UUID,
`XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` and `XERO_REDIRECT_URI`. Register an
OAuth Authorization Code web app and grant read-only invoices plus offline
access. The bridge does not accept an organization ID from graph input.

Both connectors list up to 20 invoices per page or fetch one by ID.
They expose number, currency, total and amount due, not contact details or
line items. Amounts are the provider's JSON numbers in currency units.
These reads do not create invoices or record payments.

References: [QuickBooks PHP SDK, Apache-2.0](https://github.com/intuit/QuickBooks-V3-PHP-SDK/tree/8bf471f08c39dffc4851f4d0714d43366a1ae857),
[Invoice API](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice),
[Xero SDK, MIT](https://github.com/XeroAPI/xero-node/tree/538aa659d723055cb4485ba4513e2f080ac85076)
and [Xero Invoices API](https://developer.xero.com/documentation/api/accounting/invoices).

## Kontur Diadoc

Register a web application with Authorization Code access in the Kontur
integrator account. Set `DIADOC_BOX_ID` to the GUID of one document box and
`DIADOC_CLIENT_ID`, `DIADOC_CLIENT_SECRET`, and
`DIADOC_REDIRECT_URI` from its registration. Authorize with a user who
has permission to read incoming documents in that box.

`listDocuments` uses the [V4 list method](https://developer.kontur.ru/doc/diadoc-api/http/GetDocuments_V4)
and returns a cursor when the page is full. `getDocument` uses V3 by
message ID and entity ID. The bridge returns identifiers, type, number
and display status for incoming documents, but no document content,
signature, sender identity or binary payload. It does not send or sign
documents. See the [official SDK, MIT](https://github.com/diadoc/diadocsdk-java/tree/9141ec2a87bbac069e97d3c740d82c6e285e91b0)
and [OAuth documentation](https://developer.kontur.ru/doc/diadoc-api/authentication).
