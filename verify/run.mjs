#!/usr/bin/env node
// Boots each app on its own port, runs its checks, reports. One app per line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { make } from './lib.mjs';

const apps = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync('apps').filter((d) => fs.existsSync(`apps/${d}/checks.mjs`));

let port = 8910, totalOk = 0, totalAll = 0;
const summary = [];

for (const app of apps) {
  const dir = path.resolve('apps', app);
  for (const f of ['data.sqlite', 'trace.jsonl']) fs.rmSync(path.join(dir, f), { force: true });
  const child = spawn('node', ['--no-warnings', 'runtime/run.mjs', `apps/${app}/app.json`, '--port', String(port)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  await new Promise((r) => setTimeout(r, 700));

  const ctx = make(`http://127.0.0.1:${port}`);
  const { checks } = await import(`${dir}/checks.mjs?v=${Date.now()}`);
  let ok = 0;
  console.log(`\n=== ${app} (${checks.length} checks) ===`);
  for (const [i, c] of checks.entries()) {
    try { const note = await c.run(ctx); ok++; console.log(`  ✓ ${i + 1}. ${c.task}${note ? ` — ${note}` : ''}`); }
    catch (e) { console.log(`  ✗ ${i + 1}. ${c.task}\n      ${e.message}`); }
  }
  child.kill();
  totalOk += ok; totalAll += checks.length;
  summary.push([app, ok, checks.length]);
  if (log.includes('invalid')) console.log(`  ! ${log.trim().split('\n')[0]}`);
  port++;
}

console.log('\n================ ИТОГ ================');
for (const [app, ok, all] of summary) console.log(`${ok === all ? '✓' : '✗'} ${app.padEnd(14)} ${ok}/${all}`);
console.log(`\n${totalOk}/${totalAll} проверок пройдено`);
process.exit(totalOk === totalAll ? 0 : 1);
