// CLI entry, importable so the tests can cover it without spawning a process.
// Plugins named by the graph are loaded first: the checker and the server see
// the registry the application declares.
import path from 'node:path';
import fs from 'node:fs';
import { serve } from './server.mjs';
import { validate, formatErrors } from './validate.mjs';
import { loadPlugins } from './registry.mjs';
import { admin, importCommand } from './admin.mjs';
import { openapiText } from './contract.mjs';

// A base path is one or more plain segments ("/apps/crm"): no trailing slash, nothing to escape in a link. A built front
// links its own files from the root, so it cannot move under a base.
function baseError(base, graph) {
  if (base === '') return null;
  if (!/^(?:\/[A-Za-z0-9._~-]+)+$/.test(base) || base.split('/').some((s) => s === '.' || s === '..')) return 'a base path is /segment[/segment…] of letters, digits and ._~-';
  return graph.web ? 'an app with a built front ("web") answers at the root' : null;
}

export async function main(argv, { log = console.log, err = console.error, stdin = async () => '', fetchImpl = undefined, clock = undefined } = {}) {
  const imported = importCommand(argv, { log, err });
  if (imported !== null) return { code: imported };
  const graphFile = argv.find((a) => !a.startsWith('--'));
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1];
  };
  if (!graphFile) { err('usage: run.mjs <graph.json> [--port N] [--base /path] [--check]'); return { code: 2 }; }

  const dir = path.dirname(path.resolve(graphFile));
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  const { registry, errors: pluginErrors } = await loadPlugins(graph, dir);

  if (argv.includes('--check')) {
    const errors = [...pluginErrors, ...validate(graph, registry)];
    if (!errors.length) { log(`✓ ${graphFile} is valid${registry.plugins.length ? ` (plugins: ${registry.plugins.join(', ')})` : ''}`); return { code: 0 }; }
    err(`✗ ${graphFile}\n${formatErrors(errors)}`);
    return { code: 1 };
  }

  // The OpenAPI document of the graph's /api: the same bytes GET /api/openapi.json sends. A graph the checker refuses has none.
  if (argv.includes('--openapi')) {
    const errors = [...pluginErrors, ...validate(graph, registry)];
    if (errors.length) { err(`✗ ${graphFile}\n${formatErrors(errors)}`); return { code: 1 }; }
    const text = openapiText(graph, registry), out = flag('out', null);
    if (out) { fs.writeFileSync(out, text); log(`✓ ${out}`); } else log(text.slice(0, -1));
    return { code: 0 };
  }

  const dbFile = flag('db', path.join(dir, 'data.sqlite'));
  const code = await admin(argv, { graph, registry, dir: path.dirname(dbFile), log, err, stdin, fetchImpl, clock });
  if (code !== null) return { code };

  const base = flag('base', '');
  const baseProblem = baseError(base, graph);
  if (baseProblem) { err(`--base ${base}: ${baseProblem}`); return { code: 2 }; }
  const port = Number(flag('port', 8901));
  const app = serve({
    graphFile,
    dbFile,
    traceFile: flag('trace', path.join(dir, 'trace.jsonl')),
    port, registry, pluginErrors, base,
    noTimers: Boolean(process.env.AG_NO_TIMERS),
  });
  await app.ready; // the store is migrated and seeded, and the server starts listening
  log(`${app.invalid ? 'invalid graph served at' : 'app running at'} http://127.0.0.1:${port}`);
  return { code: 0, app };
}
