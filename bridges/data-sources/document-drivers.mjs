const timeout = 4000;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

export async function mongodb(connection) {
  if (!/^mongodb(?:\+srv)?:\/\//.test(connection) || connection.includes('#'))
    throw new Error('invalid MongoDB connection');
  const params = new URLSearchParams(connection.split('?')[1]);
  const allow = ['authsource', 'replicaset', 'tls'];
  const keys = [...params.keys()].map((key) => key.toLowerCase());
  if (keys.some((key) => !allow.includes(key)) || new Set(keys).size !== keys.length) throw new Error('invalid MongoDB options');
  const tlsEntry = [...params].find(([key]) => key.toLowerCase() === 'tls');
  const plain = tlsEntry?.[1] === 'false';
  if ((tlsEntry && !['true', 'false'].includes(tlsEntry[1])) ||
    (plain && !/^mongodb:\/\/(?:[^/@?#]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^?#]*)?\?/.test(connection)))
    throw new Error('MongoDB TLS required');
  const { MongoClient, ObjectId, Long, Decimal128 } = await import('mongodb');
  const client = new MongoClient(connection, { tls: !plain, ...(plain && { directConnection: true }), connectTimeoutMS: timeout,
    serverSelectionTimeoutMS: timeout, socketTimeoutMS: timeout, maxPoolSize: 1, promoteLongs: false });
  const scalar = (value) => value instanceof ObjectId || value instanceof Long || value instanceof Decimal128 ? value.toString() : value;
  return {
    async readPage(spec, limit, offset) {
      const [database, collection] = spec.relation;
      const projection = Object.fromEntries(spec.columns.map((key) => [key, 1]));
      if (!Object.hasOwn(projection, '_id')) projection._id = 0;
      const sort = spec.orderBy.map((key) => [key, 1]);
      const rows = await client.db(database).collection(collection).find({}, {
        projection, sort, limit: limit + 1, skip: offset, maxTimeMS: timeout,
      }).toArray();
      return rows.map((row) => Object.fromEntries(spec.columns.map((key) =>
        [key, Object.hasOwn(row, key) ? scalar(row[key]) : null])));
    },
    close: () => client.close(),
  };
}

export async function redis(connection) {
  const url = new URL(connection);
  if (!url.hostname || !(url.protocol === 'rediss:' || url.protocol === 'redis:' && loopback.has(url.hostname)) ||
    url.search || url.hash || !/^(?:\/\d{1,2})?$/.test(url.pathname)) throw new Error('invalid Redis connection');
  const { Redis } = await import('ioredis');
  const client = new Redis(connection, { lazyConnect: true, enableReadyCheck: false, connectTimeout: timeout,
    commandTimeout: timeout, retryStrategy: () => null, maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false, ...(url.protocol === 'rediss:' && { tls: { servername: url.hostname } }) });
  client.on('error', () => process.stderr.write('Redis source disconnected\n'));
  return {
    async readPage(spec, limit, offset) {
      if (client.status === 'wait' || client.status === 'end') await client.connect();
      return (await client.lrangeBuffer(spec.key, offset, offset + limit)).map((bytes) => ({
        value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      }));
    },
    close: () => client.disconnect(),
  };
}
