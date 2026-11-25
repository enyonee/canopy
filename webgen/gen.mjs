#!/usr/bin/env node
// webgen: a React front end for a Canopy app, generated from its graph and its OpenAPI contract.
//
//   node webgen/gen.mjs apps/<name>/app.json --openapi <file|url> --out apps/<name>/web [--check]
//
// --openapi  the contract: a file (`node runtime/run.mjs app.json --openapi --out f.json`) or a running app's
//            /api/openapi.json. A snapshot of it is written to <out>/openapi.json, the input of the next run.
// <out>/webgen.config.json, when present, is read as settings: { "currency": "EUR", "locale": "de-DE" }.
// --check    write nothing; exit 1 when <out> differs from what this run would write.
import fs from 'node:fs';
import path from 'node:path';
import { generate } from './lib/generate.mjs';
import { writeProject, diffProject } from './lib/files.mjs';

function args(argv) {
  const out = { graph: null, openapi: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--openapi') out.openapi = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--check') out.check = true;
    else if (!out.graph) out.graph = a;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.graph || !out.openapi) throw new Error('usage: node webgen/gen.mjs <app.json> --openapi <file|url> [--out <dir>] [--check]');
  out.out ||= path.join(path.dirname(out.graph), 'web');
  return out;
}

async function readOpenapi(src) {
  const text = /^https?:\/\//.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, 'utf8');
  const doc = JSON.parse(text);
  if (!String(doc.openapi || '').startsWith('3.')) throw new Error(`${src} is not an OpenAPI 3 document`);
  return doc;
}

async function main() {
  const a = args(process.argv.slice(2));
  const graph = JSON.parse(fs.readFileSync(a.graph, 'utf8'));
  // The front end's own settings (currency, locale), kept next to it and read on every run.
  const cfgFile = path.join(a.out, 'webgen.config.json');
  const config = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const { files } = await generate(graph, await readOpenapi(a.openapi), { config });
  if (a.check) {
    const differ = diffProject(a.out, files);
    process.stdout.write(differ.length ? `${differ.length} file(s) differ from the generator:\n${differ.map((d) => `  ${d}\n`).join('')}` : `${a.out}: up to date (${files.size} files)\n`,
      () => process.exit(differ.length ? 1 : 0));
    return;
  }
  const { changed, removed } = writeProject(a.out, files);
  process.stdout.write(`${a.out}: ${files.size} files, ${changed.length} written, ${removed.length} removed\n`, () => process.exit(0));
}

main().catch((e) => { process.stderr.write(`webgen: ${e.message}\n`, () => process.exit(1)); });
