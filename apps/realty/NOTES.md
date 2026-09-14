# realty — webgen-bench/000034

## Weakened cases
- Case 2 (photographs on the details page): one `file` field; the check attaches a file through the edit form and asserts the download link and the download itself. There is no gallery and the file is offered as a download, not displayed inline.
- Case 3 (search "3-bedroom apartment"): a substring search over title, description and address; it works because the seeded wording contains the phrase. "3 bedroom apartment" without the hyphen, or a structured meaning (bedrooms = 3 and type = apartment), would not match from the search box.
- Case 1 ("matching the initial query of properties in the database"): verified by count and titles; the listing is a table, not cards with photos.

## Misses
- `node kind`: inline image display for a file field, and multi-photo galleries.
- `node kind`: tokenised or fuzzy search (the search is one LIKE per field).
- `composition`: a bucketed numeric filter (bedrooms 1+/2+/3+) — filter `options` support equality only, so the price-style range form is the closest thing.
- `node kind`: visitor-chosen sorting and pagination.
- `node kind`: map or geo display (the task is filed under "Data Visualization"); not attempted.

## New for this app
- A `file` field: multipart upload in a check, the download link on the detail page and the `/file/...` route.
- A `range` filter on a money field combined with enum filters in one query.
- A list sorted by a date (`listedAt` desc) so "first" is the newest listing.
- An app with a single entity and no identity or roles.
