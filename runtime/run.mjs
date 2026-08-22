#!/usr/bin/env node
// CLI: run.mjs <graph.json> [--port 8901] [--db file] [--trace file] [--check]
import path from 'node:path';
import fs from 'node:fs';
import { serve } from './server.mjs';
import { validate, formatErrors } from './validate.mjs';

const args = process.argv.slice(2);
const graphFile = args.find((a) => !a.startsWith('--'));
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
if (!graphFile) { console.error('usage: run.mjs <graph.json> [--port N] [--check]'); process.exit(2); }

if (args.includes('--check')) {
  const errors = validate(JSON.parse(fs.readFileSync(graphFile, 'utf8')));
  if (!errors.length) { console.log(`✓ ${graphFile} is valid`); process.exit(0); }
  console.error(`✗ ${graphFile}\n${formatErrors(errors)}`);
  process.exit(1);
}

const dir = path.dirname(path.resolve(graphFile));
const port = Number(flag('port', 8901));
const { invalid } = serve({
  graphFile,
  dbFile: flag('db', path.join(dir, 'data.sqlite')),
  traceFile: flag('trace', path.join(dir, 'trace.jsonl')),
  port,
});
console.log(`${invalid ? 'invalid graph served at' : 'app running at'} http://127.0.0.1:${port}`);
