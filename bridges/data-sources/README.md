# External database sources

These connectors read external data through a loopback process, independently
of Canopy's internal application database.

| Descriptor | Driver |
| --- | --- |
| `postgres-source` | [node-postgres, MIT](https://github.com/brianc/node-postgres) |
| `mysql-source` | [mysql2, MIT](https://github.com/sidorares/node-mysql2), for MySQL and MariaDB |
| `sqlite-source` | [Node 22 SQLite](https://nodejs.org/docs/latest-v22.x/api/sqlite.html), opened read-only |
| `clickhouse-source` | [Official ClickHouse JS client, Apache-2.0](https://github.com/ClickHouse/clickhouse-js) |
| `sqlserver-source` | [node-mssql, MIT](https://github.com/tediousjs/node-mssql) |
| `mongodb-source` | [MongoDB Node.js driver, Apache-2.0](https://github.com/mongodb/node-mongodb-native) |
| `redis-source` | [ioredis, MIT](https://github.com/redis/ioredis) |

## Bridge setup

Run `npm ci --prefix bridges/data-sources` from the repository root to
install the pinned drivers. The core runtime has no new dependencies.
Create an operator-owned JSON data source configuration, for example:

```json
{
  "recent-orders": {
    "type": "postgres",
    "connectionEnv": "ORDERS_READ_DSN",
    "relation": ["reporting", "order_export"],
    "columns": ["id", "status", "total"],
    "orderBy": ["id"]
  }
}
```

- Set `CANOPY_DATA_CONFIG` to that file's absolute path and
  `CANOPY_DATA_TOKEN` to a distinct random token of at least 24 printable
  characters. Run `node bridges/data-sources/server.mjs`. The bridge binds
  only `127.0.0.1:8907`. Do not proxy it to a public interface.
- Set each `connectionEnv` only in the bridge process environment.
  PostgreSQL uses `postgresql://user:password@host:5432/database` and
  MySQL/MariaDB uses `mysql://user:password@host:3306/database`.
  TLS with certificate verification is the default. `?tls=off` is
  supported only for loopback test servers. Percent-encode DSN credentials.
  For ClickHouse use `https://user:password@host:8443/database`, or an HTTP
  loopback endpoint in tests. For SQLite use the absolute path of an
  operator-controlled database file, not an uploaded database.
  SQL Server uses `sqlserver://user:password@host:1433/database`.
  MongoDB takes `mongodb://` or `mongodb+srv://` with TLS by default;
  accepted URI options are `authSource`, `replicaSet`, and `tls`.
  `tls=false` is limited to a single direct loopback test host.
  Redis uses `rediss://user:password@host:6379/0`; `redis://` is accepted
  on loopback only. Use the default Redis database for key-scoped ACLs.
- For PostgreSQL use a schema/relation pair; for MySQL/MariaDB and
  ClickHouse use a database/relation pair. SQLite takes one table or
  view name. For SQL Server use a schema/relation pair. MongoDB uses a
  database/collection pair and projects only top-level fields; missing
  fields are represented as null. Use an index on its sort fields. Only
  simple ASCII identifiers are accepted. The sort
  columns must be projected; choose an indexed unique ordering (a
  composite key is allowed). Offset pagination is not a snapshot and
  concurrent changes can shift rows between pages.
- Use a least-privilege database login with SELECT only on approved
  relations; prefer export views that omit private data. Configure
  server-side statement limits for MySQL/MariaDB and a read-only profile
  with query time/memory limits for ClickHouse. For SQLite prefer an indexed
  table or materialized export; a complex trusted view can still do expensive
  work. Avoid large text, binary, nested and JSON columns, or cast and bound
  them in the view.
- For MongoDB grant `find` only on the exposed collection or view;
  `ObjectId`, `Long`, and `Decimal128` are returned as strings. For
  SQL Server cast exact decimal values to text in the export view when
  the driver's numeric conversion would lose precision.
- For Redis use a definition such as
  `{"type":"redis","connectionEnv":"ORDERS_REDIS_DSN","key":"exports:orders"}`.
  The configured list is read through `LRANGE` and returned as a
  single `value` column of UTF-8 text. Grant only `LRANGE` for that key.
- One bridge token grants access to all its configured datasets, so use
  one trust boundary per bridge. Anyone with shell access to the bridge
  environment can read its database credentials. Canopy stores only the
  bridge token, not the DSNs. Results can be retained in the Canopy outbox:
  apply access controls and do not expose sensitive columns.

## Canopy graph

Add the chosen descriptor to `plugins`, then add an instance under
`connectors`, with a fixed dataset name and a mapped secret:

```json
{
  "orders": {
    "kind": "postgres-source",
    "dataset": "recent-orders",
    "secrets": { "operatorToken": "data_bridge_token" }
  }
}
```

Use `connector.call` with `op: "readPage"` and optional `limit` (1 to
50, default 20) and `offset` (0 to 10000, default 0). Use
`connector.capture` to save `rowsJson` into a text field after delivery.
The same `columns`, positional `rows`, and `hasMore` are also available
as structured fields in the outbox. An empty page has no rows and
`hasMore: false`.
Large integers and driver-provided exact decimal strings are kept as
strings; SQLite integers and ClickHouse values other than null are returned
as strings. Dates are returned in
the driver's representation. Pages over 64 KiB and cells over 4 KiB are
rejected rather than silently truncated. Reads are read-only previews,
not bulk exports or an automatic synchronization job.

Sandbox is the default; it never reaches the bridge or reads credentials.
Use the normal Canopy connector deployment controls to enable live mode.

## Driver verification

The repository tests exercise the bridge and a real disposable SQLite file.
The optional `bridges/data-sources/live.test.mjs` checks the native network
drivers. Run it with Node's test runner, with `CANOPY_TEST_DB_TYPE` set to
`postgres`, `mysql`, `clickhouse`, `sqlserver`, `mongodb`, or `redis`
and `CANOPY_TEST_DB_DSN` targeting a dedicated test database.
Seed `report.export_rows` (`dbo.export_rows` in the SQL Server database)
with two rows, `(2, 'First')` and `(9007199254740993, 'Second')`, in
`id` and `label` fields. Use BIGINT, UInt64 or BSON Long for the
second ID. For Redis seed the `export:rows` list with `First` and
`Second`. Run the verification as a read-only user.
