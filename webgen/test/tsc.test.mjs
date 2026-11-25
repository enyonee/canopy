// The generated project type-checks (strict, noUnused*) for apps other than the shop: graphs without registration,
// without saved lists, dashboards or roles. Each is generated into a temporary directory from a committed OpenAPI
// snapshot (test/fixtures, taken with `run.mjs <app.json> --openapi --out`), never built and never committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generate } from '../lib/generate.mjs';
import { writeProject } from '../lib/files.mjs';
import { ROOT } from './helpers.mjs';

// The type packages come from the shop's installed front end; without it the check cannot run, and says so.
const modules = path.join(ROOT, 'apps/shop/web/node_modules');
const tsc = path.join(modules, 'typescript/bin/tsc');
const skip = fs.existsSync(tsc) ? false : `no ${tsc}: run npm ci in apps/shop/web first`;

for (const name of ['crm', 'hospital', 'todo', 'trading']) {
  test(`tsc --noEmit is clean on the front end generated for ${name}`, { skip }, async () => {
    const graph = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', name, 'app.json'), 'utf8'));
    const openapi = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `${name}.openapi.json`), 'utf8'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `webgen-tsc-${name}-`));
    try {
      writeProject(dir, (await generate(graph, openapi)).files);
      fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir');
      try {
        execFileSync(process.execPath, [tsc, '--noEmit', '-p', dir], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        assert.fail(`tsc on ${name}:\n${e.stdout}${e.stderr}`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
