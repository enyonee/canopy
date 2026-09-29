// CLI entry, importable so the tests can cover it without spawning a process.
// Plugins named by the graph are loaded first: the checker and the server see
// the registry the application declares.
import path from 'node:path';
import fs from 'node:fs';
import { serve } from './server.mjs';
import { validate, formatErrors } from './validate.mjs';
import { loadPlugins } from './registry.mjs';
import { admin } from './admin.mjs';

export async function main(argv, { log = console.log, err = console.error, stdin = async () => '' } = {}) {
  const graphFile = argv.find((a) => !a.startsWith('--'));
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1];
  };
  if (!graphFile) { err('usage: run.mjs <graph.json> [--port N] [--check]'); return { code: 2 }; }

  const dir = path.dirname(path.resolve(graphFile));
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const { registry, errors: pluginErrors } = await loadPlugins(graph, dir);

  if (argv.includes('--check')) {
    const errors = [...pluginErrors, ...validate(graph, registry)];
    if (!errors.length) { log(`✓ ${graphFile} is valid${registry.plugins.length ? ` (plugins: ${registry.plugins.join(', ')})` : ''}`); return { code: 0 }; }
    err(`✗ ${graphFile}\n${formatErrors(errors)}`);
    return { code: 1 };
  }

  const dbFile = flag('db', path.join(dir, 'data.sqlite'));
  const code = await admin(argv, { graph, registry, dir: path.dirname(dbFile), log, err, stdin });
  if (code !== null) return { code };

  const port = Number(flag('port', 8901));
  const app = serve({
    graphFile,
    dbFile,
    traceFile: flag('trace', path.join(dir, 'trace.jsonl')),
    port, registry, pluginErrors,
    noTimers: Boolean(process.env.AG_NO_TIMERS),
  });
  log(`${app.invalid ? 'invalid graph served at' : 'app running at'} http://127.0.0.1:${port}`);
  return { code: 0, app };
}
