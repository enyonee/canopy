import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mongodb, redis } from './document-drivers.mjs';
import { asyncTransaction, sqlWriter } from './sql-write.mjs';

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

async function postgres(connection, writable) {
  const cfg = options(connection, ['postgresql:', 'postgres:']);
  const { Pool } = (await import('pg')).default;
  const pool = new Pool({ ...cfg, max: 1, statement_timeout: timeout, connectionTimeoutMillis: timeout,
    ...(!writable && { options: '-c default_transaction_read_only=on' }) });
  // pg reports errors on idle connections separately from query promises.
  pool.on('error', () => process.stderr.write('PostgreSQL source disconnected\n'));
  const write = sqlWriter(async (work) => {
    const client = await pool.connect();
    try {
      const result = await asyncTransaction(work, () => client.query('BEGIN'),
        async (sql, values) => (await client.query(sql, values)).rowCount,
        () => client.query('COMMIT'), () => client.query('ROLLBACK'));
      client.release();
      return result;
    } catch (error) {
      client.release(true);
      throw error;
    }
  });
  return { query: async (sql) => (await pool.query(sql)).rows, ...(writable && { write }), close: () => pool.end() };
}

async function mysql(connection, writable) {
  const cfg = options(connection, ['mysql:']);
  if (cfg.ssl) cfg.ssl.verifyIdentity = true;
  const { createPool } = (await import('mysql2/promise')).default;
  const pool = createPool({ ...cfg, connectionLimit: 1, connectTimeout: timeout, queueLimit: 1,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true });
  const transaction = sqlWriter(async (work) => {
    const client = await pool.getConnection();
    const command = (sql) => client.query({ sql, timeout });
    try {
      const result = await asyncTransaction(work, () => command('START TRANSACTION READ WRITE'),
        async (sql, values) => (await client.execute({ sql, timeout }, values))[0].affectedRows,
        () => command('COMMIT'), () => command('ROLLBACK'));
      client.release();
      return result;
    } catch (error) {
      client.destroy();
      throw error;
    }
  });
  const write = async (spec, op, input) => {
    const [rows] = await pool.execute({ timeout, sql: 'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?' },
      spec.relation);
    if (rows.length !== 1 || rows[0].ENGINE !== 'InnoDB') throw new Error('writes require an InnoDB table');
    return transaction(spec, op, input);
  };
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
    ...(writable && { write }),
    close: () => pool.end(),
  };
}

function sqlite(filename, writable) {
  if (!isAbsolute(filename) || filename.includes('\0')) throw new Error('SQLite requires an absolute file path');
  if (!statSync(filename).isFile()) throw new Error('SQLite requires an existing file');
  const db = new DatabaseSync(filename, { readOnly: !writable, enableDoubleQuotedStringLiterals: false });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000');
  if (!writable) db.exec('PRAGMA query_only=ON');
  const write = sqlWriter((work) => asyncTransaction(work, () => db.exec('BEGIN IMMEDIATE'),
    (sql, values) => db.prepare(sql).run(...values.map((value) => typeof value === 'boolean' ? Number(value) : value)).changes,
    () => db.exec('COMMIT'), () => db.exec('ROLLBACK')));
  return {
    query(sql) {
      const stmt = db.prepare(sql);
      stmt.setReadBigInts(true);
      return stmt.all();
    },
    ...(writable && { write }),
    close: () => db.close(),
  };
}

async function clickhouse(connection, writable) {
  const url = new URL(connection);
  if (!url.hostname || !(url.protocol === 'https:' || url.protocol === 'http:' && local.has(url.hostname)) ||
    !url.username || url.search || url.hash || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname))
    throw new Error('invalid ClickHouse connection');
  const { createClient } = await import('@clickhouse/client');
  const client = createClient({ url: url.origin, database: url.pathname.slice(1),
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    request_timeout: timeout, max_open_connections: 1 });
  const write = async (spec, _op, { values }) => {
    const result = await client.insert({ table: spec.relation.map((name) => '`' + name + '`').join('.'),
      columns: values.map(([name]) => name), values: [Object.fromEntries(values)], format: 'JSONEachRow',
      clickhouse_settings: { async_insert: 0, input_format_null_as_default: 0 } });
    if (!result.executed) throw new Error('insert not executed');
    return 1;
  };
  return {
    async query(query) {
      const result = await client.query({ query, format: 'JSONStringsEachRow' });
      return result.json();
    },
    ...(writable && { write }),
    close: () => client.close(),
  };
}

async function sqlserver(connection, writable) {
  const { host, user, password, database, port, ssl } = options(connection, ['sqlserver:']);
  const { ConnectionPool, Transaction, Request } = (await import('mssql')).default;
  const pool = new ConnectionPool({ server: host, user, password, database, port,
    options: { encrypt: Boolean(ssl), trustServerCertificate: false },
    connectionTimeout: timeout, requestTimeout: timeout, pool: { max: 1, min: 0, acquireTimeoutMillis: timeout } });
  pool.on('error', () => process.stderr.write('SQL Server source disconnected\n'));
  const write = sqlWriter(async (work) => {
    await pool.connect();
    const tx = new Transaction(pool);
    return asyncTransaction(work, () => tx.begin(), async (sql, values) => {
      const request = new Request(tx);
      values.forEach((value, i) => request.input('p' + i, value));
      const { rowsAffected } = await request.query(sql);
      return rowsAffected.length === 1 ? rowsAffected[0] : -1;
    }, () => tx.commit(), () => tx.rollback());
  });
  return {
    async query(sql) {
      await pool.connect();
      return (await pool.request().query(sql)).recordset;
    },
    ...(writable && { write }),
    close: () => pool.close(),
  };
}

const factories = { postgres, mysql, sqlite, clickhouse, sqlserver, mongodb, redis };
export function openSource(type, connection, writable = false) {
  return factories[type](connection, writable);
}
