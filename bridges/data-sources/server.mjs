import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { merchantServer, validOperatorToken } from '../merchant-http.mjs';
import { datasetName, project, readPage, readSpec, select, types, updateTypes, writeInput } from './contracts.mjs';
import { openSource } from './drivers.mjs';

async function use(client, run) {
  if (client.busy) return [429, { error: 'source busy' }];
  client.busy = true;
  try { return await run(client.driver); }
  finally { client.busy = false; }
}

function readRoute(type, sources) {
  return async (raw) => {
    const page = readPage(raw);
    if (!page) return [400, { error: 'invalid page request' }];
    const source = sources.get(page.dataset);
    if (!source || source.spec.type !== type) return [404, { error: 'dataset not found' }];
    const { spec, client } = source;
    return use(client, async (driver) => {
      const rows = driver.readPage
        ? await driver.readPage(spec, page.limit, page.offset)
        : await driver.query(select(spec, page.limit, page.offset));
      return [200, project(rows, spec.columns, page.limit)];
    });
  };
}

function writeRoute(type, op, sources) {
  return async (raw) => {
    if (!datasetName(raw.dataset)) return [400, { error: 'invalid dataset' }];
    const source = sources.get(raw.dataset);
    if (!source || source.spec.type !== type || !source.writer || op === 'update' && !source.spec.write.key)
      return [404, { error: 'write operation not enabled for dataset' }];
    const input = writeInput(source.spec, op, raw);
    if (!input) return [400, { error: 'invalid write request' }];
    return use(source.writer, async (driver) => {
      const affected = await driver.write(source.spec, op, input);
      if (affected !== 1 && !(op === 'update' && affected === 0)) throw new Error('invalid write acknowledgement');
      return [200, { affected }];
    });
  };
}

export async function createBridge({ token, writeToken, datasets, env = process.env, open = openSource }) {
  if (!validOperatorToken(token) || !datasets || typeof datasets !== 'object' || Array.isArray(datasets) ||
    Object.keys(datasets).length < 1 || Object.keys(datasets).length > 16) throw new Error('invalid data bridge configuration');
  const specs = Object.entries(datasets).map(([name, spec]) => [name, readSpec(name, spec)]);
  const writable = specs.some(([, spec]) => spec.write);
  if (writable && (!validOperatorToken(writeToken) || writeToken === token))
    throw new Error('writes require a distinct write token');
  const sources = new Map(), clients = new Map();
  async function connect(type, envName, write = false) {
    const key = type + ':' + envName + ':' + (write ? 'write' : 'read');
    const connection = env[envName];
    if (!connection) throw new Error('data source connection is missing');
    if (!clients.has(key)) clients.set(key, { driver: await open(type, connection, write), busy: false });
    return clients.get(key);
  }
  try {
    for (const [name, spec] of specs) {
      const client = await connect(spec.type, spec.connectionEnv);
      const writer = spec.write && await connect(spec.type, spec.write.connectionEnv, true);
      sources.set(name, { spec, client, writer });
    }
  } catch {
    await Promise.allSettled([...clients.values()].map(({ driver }) => Promise.resolve().then(() => driver.close())));
    throw new Error('could not open data source; check connection settings');
  }

  const routes = Object.fromEntries(types.map((type) => ['/' + type + '/read', readRoute(type, sources)]));
  const credentials = {};
  if (writable) for (const type of types) {
    for (const op of type === 'redis' ? ['append'] : updateTypes.includes(type) ? ['insert', 'update'] : ['insert']) {
      const path = '/' + type + '/' + op;
      routes[path] = writeRoute(type, op, sources);
      credentials[path] = writeToken;
    }
  }
  const server = merchantServer(token, routes, credentials);
  server.requestTimeout = 8000;
  server.once('close', () => {
    Promise.allSettled([...clients.values()].map(({ driver }) => Promise.resolve().then(() => driver.close())))
      .then((results) => { if (results.some((r) => r.status === 'rejected')) process.stderr.write('Data source did not close cleanly\n'); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  try {
    if (!env.CANOPY_DATA_CONFIG || !isAbsolute(env.CANOPY_DATA_CONFIG)) throw new Error('absolute config path required');
    const datasets = JSON.parse(await readFile(env.CANOPY_DATA_CONFIG, 'utf8'));
    const server = await createBridge({ token: env.CANOPY_DATA_TOKEN, writeToken: env.CANOPY_DATA_WRITE_TOKEN, datasets });
    server.listen(8907, '127.0.0.1');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  } catch {
    process.stderr.write('Data bridge startup failed; check the configuration and connection settings\n');
    process.exitCode = 1;
  }
}
