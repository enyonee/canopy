# Business connector catalog

Add the selected `connectors/<kind>/descriptor.json` to the app's `plugins`.
Declare a named instance of that kind under `connectors`, and map its secret
slots to names in the encrypted secret store. Each descriptor defaults to
the offline sandbox. Use `--check` before deployment and enable live delivery
only with the appropriate merchant or seller account. The GitHub revisions
below are reference implementations for the HTTP contracts; their SDKs
are not runtime dependencies.

## Commerce, messaging and CRM

| Kind | Operations and configuration | Reference implementation |
| --- | --- | --- |
| `yandex-market` | Read order status by ID and stock by partner warehouse and SKU. Configure `businessId` and `apiKey`. | [Official OpenAPI and SDK generator, BSD-3-Clause](../connectors/yandex-market/SOURCES.md) |
| `woocommerce` | List a bounded page of orders, get an order, set status and read stock. Configure the HTTPS `host` and base64 of the consumer key pair in `basicCredential`. | [Official REST client, MIT](../connectors/woocommerce/SOURCES.md) |
| `hubspot` | Create/read a contact, create a deal and set its stage. A scoped Service Key in `accessToken` connects one account. | [Official CRM client, Apache-2.0](../connectors/hubspot/SOURCES.md) |
| `shopify` | List/read orders and read available stock at a location, for a store in the app's own Shopify organization. Uses the loopback OAuth bridge. | [Admin GraphQL and bridge setup](../bridges/oauth-connectors/README.md) |
| `google-sheets` | Read bounded rows and append one RAW row in an operator-selected sheet via user consent. | [Sheets API and bridge setup](../bridges/oauth-connectors/README.md) |
| `amocrm` | Create/read contacts and deals and set a deal stage with OAuth for one portal. | [amoCRM SDK and bridge setup](../bridges/oauth-connectors/README.md) |
| `quickbooks` | Read bounded invoice pages or one invoice from the configured QuickBooks Online company. | [Intuit SDK and bridge setup](../bridges/oauth-connectors/README.md) |
| `xero` | Read bounded invoice pages or one invoice from the configured Xero organization. | [Xero SDK and bridge setup](../bridges/oauth-connectors/README.md) |
| `telegram-bot` | Send plain text to a chat ID. Store the whole `bot<token>` path segment in `botPath`; the outbox target is masked. | [Activepieces implementation, MIT](../connectors/telegram-bot/SOURCES.md) |
| `whatsapp-business` | Send an approved template with no parameters. Configure `phoneNumberId` and a scoped `accessToken`. | [Activepieces implementation, MIT](../connectors/whatsapp-business/SOURCES.md) |
| `paypal` | Create a hosted order, read approval, capture, reconcile by order or capture ID, and request/read a refund. Configure `clientId` and `clientSecret`. | [Orders and Payments v2; Server SDK reference](../connectors/paypal/SOURCES.md) |
| `mollie` | Hosted checkout, payment status and refunds with a scoped `apiKey`. The descriptor uses decimal strings with two digits after the decimal point. | [Official Node client, BSD-3-Clause](../connectors/mollie/SOURCES.md) |
| `mercado-pago` | Checkout Pro preferences, authenticated payment lookup, and refunds. Use the merchant `accessToken`. A preference ID is not a payment ID. | [Official Node client, MIT](../connectors/mercado-pago/SOURCES.md) |
| `adyen` | Create/read single-use payment links and request refunds by payment PSP reference. Configure `endpointPrefix`, `merchantAccount`, `countryCode` and `apiKey`; capture and refund confirmation are separate. | [Official Node API library, MIT](../connectors/adyen/SOURCES.md) |

## Regional catalog

| Kind | Operations and configuration | Reference implementation |
| --- | --- | --- |
| `bitrix24` | Contact create/read, deal create and stage update. Cloud portal and user ID in config, incoming webhook token in `webhookToken`. | [Official PHP SDK, MIT](https://github.com/bitrix24/b24phpsdk/tree/11b3be9a5455f5964d00f532980d1067ca7f0211) |
| `moysklad` | Read or create a customer order with a product line; read warehouse stock. `apiToken`; order prices are in minor units. | [MoySklad JS, MIT](https://github.com/wmakeev/moysklad/tree/f9926bd07d4d22383f10bc1d3445cb43a6b792c6) |
| `ozon-seller` | List a bounded page of FBS postings and read a posting. `clientId`, `apiKey`. | [Ozon Seller PHP, MIT](https://github.com/gam6itko/ozon-seller/tree/78a3c6603b6190bba7314da716f145cfed6baaf6) |
| `wildberries` | New FBS orders, order statuses and warehouse stocks. `apiToken` with the required seller access. | [OpenAPI client, Unlicense](https://github.com/letby3/wildberries-api-client/tree/c331be54c5faf1e2562c221dd727ee9964d8615a); [current WB API](https://dev.wildberries.ru/) |
| `kaspi-shop` | Page through seller orders, look up by order number and read entries. `apiToken`. This is not Kaspi Pay. | [Kaspi Merchant API, MIT](https://github.com/abdymazhit/kaspi-merchant-api/tree/84f483f60c08ee9580b4eb980dcdd3be439218c1) |
| `cdek` | Quote tariffs and create/read shipments. `clientId`, `clientSecret`. Request acceptance is not delivery; check the shipment status. | [Official CDEK 2.0 SDK, MIT](https://github.com/cdek-it/sdk2.0/tree/6289c81506c8934c1979e04852f9dbb3ab722a99) |
| `tbank` | Hosted RUB checkout, authenticated status and full or partial refund. The loopback bridge signs requests with the terminal password. Canopy only needs its `operatorToken`. | [Bridge and PHP SDK reference, MIT](../bridges/tbank-payments/README.md) |
| `ameriabank` | Hosted vPOS checkout, payment ID lookup, deposit status and refund request. Configure the local bridge and its `operatorToken`. | [Bridge and vPOS SDK, MIT](../bridges/caucasus-payments/README.md) |
| `epoint` | Hosted AZN checkout and signed payment status lookup by transaction or order ID. Configure the local bridge and its `operatorToken`. | [Bridge and PHP SDK, MIT](../bridges/caucasus-payments/README.md) |
| `paynet` | Registers a fixed UZS order for an onboarded Paynet UWS service and reads reconciled status. It does not generate a hosted link. | [Paynet UWS integration](https://paynet.uz/developer-guide/en.html), [bridge setup](../bridges/uz-payments/README.md) |
| `uzum-bank` | One-step UZS checkout, authenticated payment status, refund request and refund operation lookup. | [Bank Checkout API and setup](../bridges/uzum-checkout/README.md) |
| `robokassa` | One-time RUB invoice links and authenticated status by numeric merchant invoice ID. Canopy only needs the bridge's `operatorToken`. | [Bridge and official PHP SDK, MIT](../bridges/robokassa/README.md) |
| `onec-odata` | Read a bounded page or a single catalog item or document from a published 1C database; use a read-only account in `basicCredential`. | [OData v3 and Python client, MIT](../connectors/onec-odata/SOURCES.md) |
| `yookassa` | Hosted RUB checkout, payment status, refund. Store base64 of `shopId:apiKey` in `basicCredential`. Amounts are decimal strings. | [YooKassa Go SDK, MIT](https://github.com/rvinnie/yookassa-sdk-go/tree/5c7b862a2aa4ee6ffa3dd9337aa5dffc3323e0b8) |
| `halyk-epay` | Create KZT invoice link, read authenticated transaction status, request full/partial refund. `shopId` config; `clientId`, `clientSecret`. Amounts are in tenge. | [Halyk ePay Python SDK, MIT](https://github.com/Medetw/halyk-epay/tree/5468cd61156a5d98189a629b5dbf0754bf1f626d); [Halyk invoice API](https://epayment.kz/docs/invoice-link-API) |
| `bepaid` | BYN checkout, checkout status, confirmed payment lookup and refund request. `basicCredential` holds base64 of `shopId:shopKey`; provider test mode defaults to true. Amounts are in minor units. | [miniShop2 module, MIT](https://github.com/modx-pro/msp-bepaid/tree/c6db3ecb3ca14b826d15e355543a2a8c64402d71); [bePaid docs](https://docs.bepaid.by/ru/) |
| `payme` | UZS checkout link and reconciliation through the merchant bridge. `operatorToken`. | [PaycomUz, MIT](https://github.com/begyy/PaycomUz/tree/08a397b21d4c0d177eddb312f199ec47e78732d5); [Merchant API](https://developer.help.paycom.uz/metody-merchant-api/) |
| `click` | UZS link and reconciliation through the same merchant bridge. `operatorToken`. | [Official WooCommerce gateway, MIT](https://github.com/click-llc/woocommerce-clickuz-gateway/tree/8ceac78d4ed7871e08d109ebc35a808c0118cf82) |

For every payment, keep the original amount and currency fixed, compare them
and the provider reference when reconciling, and grant access or fulfil the
order only after confirming the provider's paid state. Redirects and
successful submission of a refund request are not proof of settlement.
For YooKassa, Halyk and bePaid use authenticated status calls; these
descriptors do not treat provider notifications as trusted state transitions.
Reconcile an ambiguous refund before another attempt. YooKassa receipts and
fiscalization are not supplied by the hosted checkout descriptor; verify your
merchant configuration before using it with real customers.

Seller list results may include personal data returned by the provider.
Keep the related graph rows and outbox visible only to operators with a
business need. Do not expose a checkout link or delivery result across buyer
accounts. See [payment lifecycle](PAYMENTS.md) and the
[Uzbekistan merchant bridge](../bridges/uz-payments/README.md).

## Existing providers

The existing descriptors retain their APIs. Their request/response and
callback contracts can be compared against these ready upstream clients:

| Kind | Upstream and coverage |
| --- | --- |
| `stripe` | [Stripe Node SDK, MIT](https://github.com/stripe/stripe-node/tree/87e14697b014981d9beb2bf617ac5cf412106e34) and [official one-time Checkout sample, MIT](https://github.com/stripe-samples/checkout-one-time-payments/tree/c834ba3ae155bd77a6aeb5879b58edd6a944af00): Checkout Sessions, Refunds, Stripe signature construct/verify. |
| `bog-payment-manager` | [Aggregator Ecommerce Client, Apache-2.0](https://github.com/helixge/BankOfGeorgia.AggregatorEcommerceClient/tree/79cadb49c3d693ed45238e329305c9799facb79c): new Payment Manager endpoints, receipt read, refund and RSA callback. |
| `tbc-checkout` | [TBC Python SDK, MIT](https://github.com/astronomiwe/tbc-sdk-python/tree/5b8c0bdb9fdfa5b512fe3bb09dda10b2393ffb02): create, status read, empty successful cancel response, callback as a prompt to re-read. |
| `slack` | [Slack Node SDK, MIT](https://github.com/slackapi/node-slack-sdk/tree/6815a9740840269c941d52c717ee461935c19d09): send message, API errors in HTTP 200, signing and replay checks. |
| `postmark` | [Postmark Node SDK, MIT](https://github.com/ActiveCampaign/postmark.js/tree/dc6e49a48eea1b3445258befa09e0365e60160): email submission and server-token HTTP header. |

Tests use fixture replies, local HTTP and provider-compatible signatures.
They do not exercise active merchant accounts or make real charges.
