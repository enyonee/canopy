# Bitrix24 CRM

The descriptor adapts the method contracts of the official
[Bitrix24 PHP SDK (MIT)](https://github.com/bitrix24/b24phpsdk/tree/11b3be9a5455f5964d00f532980d1067ca7f0211)
and [webhook authentication](https://apidocs.bitrix24.ru/local-integrations/local-webhooks.html).
It does not distribute the SDK or require PHP.

Create a local incoming webhook with CRM rights for a dedicated Bitrix24 user.
Set `portal` to the cloud host (without a scheme) and `userId` to the numeric
ID shown in the webhook URL, as a string. Put only the token segment into the
secret slot `webhookToken`. Never include an actual webhook URL in app data.

`createContact`, `getContact`, `createDeal`, and `updateDealStage` work
with legacy CRM methods still listed in the API. A custom/self-hosted domain
and Marketplace OAuth installation are outside this descriptor's scope.
Authentication requires a portal plan that allows REST access.
