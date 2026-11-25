#!/usr/bin/env node
// Does the generated front end still speak the runtime's contract?
//
//   node webgen/check-contract.mjs apps/<name>/app.json [--runtime <repo checkout>] [--web <dir>]
//
// 1. the OpenAPI document the runtime derives now (`run.mjs <app.json> --openapi --out <file>`) equals the snapshot
//    the front end was generated from (<web>/openapi.json), key order aside;
// 2. src/gen/api.d.ts is what openapi-typescript makes of that snapshot;
// 3. every generated file is what webgen makes of the graph and the snapshot (gen.mjs --check).
// Exit 0 when all three hold; 1 with the differences otherwise. Regenerate with gen.mjs when the contract moved.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, generate } from './lib/generate.mjs';
import { diffProject } from './lib/files.mjs';
import { typesOf } from './lib/types.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const graphFile = path.resolve(argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) || '');
const repo = path.resolve(opt('runtime') || path.join(path.dirname(graphFile), '..', '..'));
const web = path.resolve(opt('web') || path.join(path.dirname(graphFile), 'web'));

function firstDifference(a, b, at = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[k], b[k], `${at}/${k}`);
      if (d) return d;
    }
  }
  return `${at || '/'}: snapshot ${JSON.stringify(b)?.slice(0, 120)} vs runtime ${JSON.stringify(a)?.slice(0, 120)}`;
}

async function main() {
  const problems = [];
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'webgen-contract-'));
  try {
    const out = path.join(tmp, 'openapi.json');
    execFileSync(process.execPath, ['--no-warnings', path.join(repo, 'runtime/run.mjs'), graphFile, '--openapi', '--out', out], { stdio: ['ignore', 'ignore', 'inherit'] });
    const live = canonical(JSON.parse(fs.readFileSync(out, 'utf8')));
    const snapshot = canonical(JSON.parse(fs.readFileSync(path.join(web, 'openapi.json'), 'utf8')));
    const d = firstDifference(live, snapshot);
    if (d) problems.push(`the runtime's OpenAPI moved since the snapshot: ${d}`);
    const types = await typesOf(snapshot);
    if (fs.readFileSync(path.join(web, 'src/gen/api.d.ts'), 'utf8') !== types) problems.push('src/gen/api.d.ts is not the types of openapi.json');
    const { files } = await generate(JSON.parse(fs.readFileSync(graphFile, 'utf8')), snapshot);
    const differ = diffProject(web, files);
    if (differ.length) problems.push(`generated files differ: ${differ.join(', ')}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const msg = problems.length ? `contract check failed:\n${problems.map((p) => `  - ${p}\n`).join('')}regenerate: node webgen/gen.mjs ${path.relative(process.cwd(), graphFile)} --openapi <file> --out ${path.relative(process.cwd(), web)}\n`
    : `contract ok: ${path.relative(process.cwd(), web)} matches the runtime at ${repo}\n`;
  process.stdout.write(msg, () => process.exit(problems.length ? 1 : 0));
}

main().catch((e) => process.stderr.write(`check-contract: ${e.message}\n`, () => process.exit(1)));
