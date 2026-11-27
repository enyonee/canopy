const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const DATASET = /^[a-z][a-z0-9-]{0,47}$/;
export const types = ['postgres', 'mysql', 'sqlite', 'clickhouse', 'sqlserver', 'mongodb', 'redis'];
const identifier = (s) => typeof s === 'string' && IDENTIFIER.test(s);
export const datasetName = (s) => typeof s === 'string' && DATASET.test(s);
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every((key) => keys.includes(key));

export function readSpec(name, spec) {
  if (spec?.type === 'redis') {
    if (!datasetName(name) || !only(spec, ['type', 'connectionEnv', 'key']) ||
      !envName(spec.connectionEnv) || typeof spec.key !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(spec.key))
      throw new Error('invalid Redis list definition');
    return { ...spec, columns: ['value'] };
  }
  if (!datasetName(name) || !only(spec, ['type', 'connectionEnv', 'relation', 'columns', 'orderBy']) ||
    !types.includes(spec.type) || !envName(spec.connectionEnv) ||
    !Array.isArray(spec.relation) || spec.relation.length !== (spec.type === 'sqlite' ? 1 : 2) ||
    !spec.relation.every(identifier) || !Array.isArray(spec.columns) || !spec.columns.length || spec.columns.length > 20 ||
    !spec.columns.every(identifier) || new Set(spec.columns).size !== spec.columns.length ||
    !Array.isArray(spec.orderBy) || !spec.orderBy.length ||
    new Set(spec.orderBy).size !== spec.orderBy.length || !spec.orderBy.every((key) => spec.columns.includes(key))) {
    throw new Error('invalid data source definition');
  }
  return spec;
}

const envName = (s) => typeof s === 'string' && /^[A-Z][A-Z0-9_]{0,90}$/.test(s);

export function readPage(body) {
  if (!only(body, ['dataset', 'limit', 'offset']) || !datasetName(body.dataset) ||
    !Number.isSafeInteger(body.limit) || body.limit < 1 || body.limit > 50 ||
    !Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset > 10000) return null;
  return body;
}

export function select(spec, limit, offset) {
  const backticks = spec.type === 'mysql' || spec.type === 'clickhouse';
  const quote = (name) => spec.type === 'sqlserver' ? '[' + name + ']' : backticks ? '`' + name + '`' : '"' + name + '"';
  const page = spec.type === 'sqlserver'
    ? ' OFFSET ' + offset + ' ROWS FETCH NEXT ' + (limit + 1) + ' ROWS ONLY'
    : ' LIMIT ' + (limit + 1) + ' OFFSET ' + offset;
  return 'SELECT ' + spec.columns.map(quote).join(', ') + ' FROM ' + spec.relation.map(quote).join('.') +
    ' ORDER BY ' + spec.orderBy.map(quote).join(', ') + page;
}

function scalar(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Buffer.byteLength(value) <= 4096) return value;
  throw new Error('unbounded or unsupported data cell');
}

export function project(rows, columns, limit) {
  if (!Array.isArray(rows) || rows.length > limit + 1) throw new Error('unexpected source result size');
  const result = { columns, rows: rows.slice(0, limit).map((row) => {
    if (!object(row) || !columns.every((key) => Object.hasOwn(row, key))) throw new Error('missing projected column');
    return columns.map((key) => scalar(row[key]));
  }), hasMore: rows.length > limit };
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new Error('data page exceeds 64 KiB');
  return { ...result, rowsJson: JSON.stringify(result.rows) };
}
