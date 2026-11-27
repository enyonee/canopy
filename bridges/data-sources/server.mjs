import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { merchantServer, validOperatorToken } from '../merchant-http.mjs';
import { project, readPage, readSpec, select, types } from './contracts.mjs';
import { openSource } from './drivers.mjs';

export async function createBridge({ token, datasets, env = process.env, open = openSource }) {
  if (!validOperatorToken(token) || !datasets || typeof datasets !== 'object' || Array.isArray(datasets) ||
    Object.keys(datasets).length < 1 || Object.keys(datasets).length > 16) throw new Error('invalid data bridge configuration');
  const specs = Object.entries(datasets).map(([name, spec]) => [name, readSpec(name, spec)]);
  const sources = new Map(), clients = new Map();
  try {
    for (const [name, spec] of specs) {
      const key = spec.type + ':' + spec.connectionEnv;
      const connection = env[spec.connectionEnv];
      if (!connection) throw new Error('data source connection is missing');
      if (!clients.has(key)) clients.set(key, { driver: await open(spec.type, connection), busy: false });
      sources.set(name, { spec, client: clients.get(key) });
    }
  } catch {
    await Promise.allSettled([...clients.values()].map(({ driver }) => Promise.resolve().then(() => driver.close())));
    throw new Error('could not open data source; check connection settings');
  }

  const routes = Object.fromEntries(types.map((type) => ['/' + type + '/read', async (raw) => {
    const page = readPage(raw);
    if (!page) return [400, { error: 'invalid page request' }];
    const source = sources.get(page.dataset);
    if (!source || source.spec.type !== type) return [404, { error: 'dataset not found' }];
    const { spec, client } = source;
    if (client.busy) return [429, { error: 'source busy' }];
    client.busy = true;
    try {
      const rows = client.driver.readPage
        ? await client.driver.readPage(spec, page.limit, page.offset)
        : await client.driver.query(select(spec, page.limit, page.offset));
      return [200, project(rows, spec.columns, page.limit)];
    } finally { client.busy = false; }
  }]));
  const server = merchantServer(token, routes);
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
    const server = await createBridge({ token: env.CANOPY_DATA_TOKEN, datasets });
    server.listen(8907, '127.0.0.1');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  } catch {
    process.stderr.write('Data bridge startup failed; check the configuration and connection settings\n');
    process.exitCode = 1;
  }
}
