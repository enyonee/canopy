#!/usr/bin/env node
// The coverage gate: every runtime module must be 100% covered by lines, or
// the run fails and prints exactly which lines were never executed. Built on
// node:test's own coverage (--experimental-test-coverage); no dependency reads
// the report, this script parses the LCOV Node already knows how to emit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.mjs')) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

// One block per "SF:<file>" ... "end_of_record": collect its DA (line,hits) pairs.
function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) { current = line.slice(3); if (!files.has(current)) files.set(current, []); continue; }
    if (line.startsWith('DA:') && current) {
      const [ln, hits] = line.slice(3).split(',');
      files.get(current).push([Number(ln), Number(hits)]);
      continue;
    }
    if (line === 'end_of_record') current = null;
  }
  return files;
}

// run.mjs is top-level process glue (reads real argv, calls process.exit): importing
// it inside the test process would act on the test runner's own argv and could exit
// it mid-suite. cli.mjs's main() — the part with any actual logic — is fully covered
// by tests/cli.test.mjs; run.mjs itself is exercised as a real subprocess by every
// app verify/run.mjs boots, just not under this in-process coverage instrumentation.
const EXEMPT = new Set(['runtime/run.mjs']);
const runtimeFiles = walk('runtime').filter((f) => !f.endsWith('.d.ts') && !EXEMPT.has(f));
const lcovFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ag-cov-')), 'coverage.lcov');
const testFiles = fs.readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/${f}`);

const run = spawnSync('node', [
  '--experimental-test-coverage',
  '--test-coverage-exclude=tests/**', '--test-coverage-exclude=verify/**',
  '--test-coverage-exclude=apps/**', '--test-coverage-exclude=plugins/**', '--test-coverage-exclude=demo/**',
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${lcovFile}`,
  '--test', ...testFiles,
], { stdio: ['ignore', 'inherit', 'inherit'] });

if (run.status !== 0) { console.error('\nthe suite is red; fix that before coverage means anything'); process.exit(run.status || 1); }

const files = parseLcov(fs.readFileSync(lcovFile, 'utf8'));
let bad = false;

for (const f of runtimeFiles) {
  const das = files.get(f);
  if (!das || !das.length) { console.error(`✗ ${f}: never executed by any test`); bad = true; continue; }
  const uncovered = das.filter(([, hits]) => hits === 0).map(([ln]) => ln);
  if (uncovered.length) {
    console.error(`✗ ${f}: ${(100 * (das.length - uncovered.length) / das.length).toFixed(1)}% lines — uncovered: ${uncovered.join(', ')}`);
    bad = true;
  }
}

if (bad) { console.error('\ncoverage gate failed: every runtime module must be 100% covered by lines'); process.exit(1); }
console.log(`\n✓ coverage gate: 100% lines across ${runtimeFiles.length} runtime modules`);
