import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mongodb, redis } from './document-drivers.mjs';

const timeout = 4000;
const local = new Set(['localhost', '127.0.0.1', '[::1]']);

function options(connection, protocols) {
  const url = new URL(connection);
  if (!protocols.includes(url.protocol) || !url.hostname || !url.username || url.hash ||
    !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || new Set(url.searchParams.keys()).size !== [...url.searchParams].length ||
    [...url.searchParams].some(([k, v]) => k !== 'tls' || v !== 'off' || !local.has(url.hostname)))
    throw new Error('invalid database connection');
  return { host: url.hostname.replace(/^\[|\]$/g, ''), ...(url.port && { port: Number(url.port) }),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1),
    ...(url.searchParams.get('tls') !== 'off' && { ssl: { rejectUnauthorized: true } }) };
}

async function postgres(connection) {
  const cfg = options(connection, ['postgresql:', 'postgres:']);
  const { Pool } = (await import('pg')).default;
  const pool = new Pool({ ...cfg, max: 1, statement_timeout: timeout, connectionTimeoutMillis: timeout,
    options: '-c default_transaction_read_only=on' });
  // pg reports errors on idle connections separately from query promises.
  pool.on('error', () => process.stderr.write('PostgreSQL source disconnected\n'));
  return { query: async (sql) => (await pool.query(sql)).rows, close: () => pool.end() };
}

async function mysql(connection) {
  const cfg = options(connection, ['mysql:']);
  if (cfg.ssl) cfg.ssl.verifyIdentity = true;
  const { createPool } = (await import('mysql2/promise')).default;
  const pool = createPool({ ...cfg, connectionLimit: 1, connectTimeout: timeout, queueLimit: 1,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  return {
    async query(sql) {
      const client = await pool.getConnection();
      try {
        await client.query({ sql: 'START TRANSACTION READ ONLY', timeout });
        const [rows] = await client.query({ sql, timeout });
        await client.query({ sql: 'ROLLBACK', timeout });
        client.release();
        return rows;
      } catch (error) {
        client.destroy();
        throw error;
      }
    },
    close: () => pool.end(),
  };
}

function sqlite(filename) {
  if (!isAbsolute(filename) || filename.includes('\0')) throw new Error('SQLite requires an absolute file path');
  const db = new DatabaseSync(filename, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
  return {
    query(sql) {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true);
      return stmt.all();
    },
    close: () => db.close(),
  };
}

async function clickhouse(connection) {
  const url = new URL(connection);
  if (!url.hostname || !(url.protocol === 'https:' || url.protocol === 'http:' && local.has(url.hostname)) ||
    !url.username || url.search || url.hash || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname))
    throw new Error('invalid ClickHouse connection');
  const { createClient } = await import('@clickhouse/client');
  const client = createClient({ url: url.origin, database: url.pathname.slice(1),
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    request_timeout: timeout, max_open_connections: 1 });
  return {
    async query(query) {
      const result = await client.query({ query, format: 'JSONStringsEachRow' });
      return result.json();
    },
    close: () => client.close(),
  };
}

async function sqlserver(connection) {
  const { host, user, password, database, port, ssl } = options(connection, ['sqlserver:']);
  const { ConnectionPool } = (await import('mssql')).default;
  const pool = new ConnectionPool({ server: host, user, password, database, port,
    options: { encrypt: Boolean(ssl), trustServerCertificate: false },
    connectionTimeout: timeout, requestTimeout: timeout, pool: { max: 1, min: 0, acquireTimeoutMillis: timeout } });
  pool.on('error', () => process.stderr.write('SQL Server source disconnected\n'));
  return {
    async query(sql) {
      await pool.connect();
      return (await pool.request().query(sql)).recordset;
    },
    close: () => pool.close(),
  };
}

const factories = { postgres, mysql, sqlite, clickhouse, sqlserver, mongodb, redis };
export function openSource(type, connection) {
  return factories[type](connection);
}
