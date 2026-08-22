// CLI entry, importable so the tests can cover it without spawning a process.
import path from 'node:path';
import fs from 'node:fs';
import { serve } from './server.mjs';
import { validate, formatErrors } from './validate.mjs';

export function main(argv, { log = console.log, err = console.error } = {}) {
  const graphFile = argv.find((a) => !a.startsWith('--'));
  const flag = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1];
  };
  if (!graphFile) { err('usage: run.mjs <graph.json> [--port N] [--check]'); return { code: 2 }; }

  if (argv.includes('--check')) {
    const errors = validate(JSON.parse(fs.readFileSync(graphFile, 'utf8')));
    if (!errors.length) { log(`✓ ${graphFile} is valid`); return { code: 0 }; }
    err(`✗ ${graphFile}\n${formatErrors(errors)}`);
    return { code: 1 };
  }

  const dir = path.dirname(path.resolve(graphFile));
  const port = Number(flag('port', 8901));
  const app = serve({
    graphFile,
    dbFile: flag('db', path.join(dir, 'data.sqlite')),
    traceFile: flag('trace', path.join(dir, 'trace.jsonl')),
    port,
  });
  log(`${app.invalid ? 'invalid graph served at' : 'app running at'} http://127.0.0.1:${port}`);
  return { code: 0, app };
}
