Reference: [PyOData1C (MIT)](https://github.com/kr-aleksey/PyOData1C/tree/79070394d52ecad43543d90a5e80cc136ccfbe36).

Publish the 1C infobase with its standard OData v3 interface over HTTPS.
Configure the trusted host (and optional port), publication path segment,
and the catalog and document identifiers from that infobase's metadata.
For `Catalog_Customers`, use `Customers`; omit `Document_` in the same way.
Identifiers can contain Cyrillic characters. Use a restricted read-only
1C account and store base64 of `username:password` in the
`basicCredential` secret slot. Base64 is not encryption.

The connector reads lists in bounded pages and reads records by Ref_Key.
The projections are document numbers and dates, and catalog descriptions;
it does not transfer whole records, write documents, or assume a particular
1C product or national configuration. Dates are returned in the published
infobase's representation, not implicitly converted to UTC.
