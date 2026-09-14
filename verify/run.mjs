#!/usr/bin/env node
// Boots each app on its own port, runs its checks, reports. One app per line.
// A local sink receives the apps' outgoing HTTP. After the base checks, each
// declared change (a JSON patch + its checks) is applied on the same database
// and checked again: the lifecycle, not only the first build.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { make, startSink } from './lib.mjs';
import { applyPatch } from '../runtime/patch.mjs';
import { validate, formatErrors } from '../runtime/validate.mjs';

const apps = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync('apps').filter((d) => fs.existsSync(`apps/${d}/checks.mjs`));

const sink = await startSink(8999);
let port = 8910, totalOk = 0, totalAll = 0;
const summary = [];

const boot = (graphFile, p) => {
  const child = spawn('node', ['--no-warnings', 'runtime/run.mjs', graphFile, '--port', String(p)], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d; });
  child.stderr.on('data', (d) => { child.log += d; });
  return child;
};
const stop = (child) => new Promise((r) => { child.on('exit', r); child.kill(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const runChecks = async (name, checks, ctx) => {
  let ok = 0;
  console.log(`\n=== ${name} (${checks.length} checks) ===`);
  for (const [i, c] of checks.entries()) {
    try { const note = await c.run(ctx); ok++; console.log(`  ✓ ${i + 1}. ${c.task}${note ? ` — ${note}` : ''}`); }
    catch (e) { console.log(`  ✗ ${i + 1}. ${c.task}\n      ${e.message}`); }
  }
  totalOk += ok; totalAll += checks.length;
  summary.push([name, ok, checks.length]);
};

for (const app of apps) {
  const dir = path.resolve('apps', app);
  for (const f of ['data.sqlite', 'trace.jsonl', 'session.key']) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, 'files'), { recursive: true, force: true });
  for (const f of fs.readdirSync(dir)) if (/^\.stage\d+\.json$/.test(f)) fs.rmSync(path.join(dir, f));

  let graphFile = `apps/${app}/app.json`;
  let child = boot(graphFile, port);
  await wait(700);
  const ctx = make(`http://127.0.0.1:${port}`, sink);
  sink.clear();
  const mod = await import(`${dir}/checks.mjs?v=${Date.now()}`);
  await runChecks(app, mod.checks, ctx);
  if (child.log.includes('invalid')) console.log(`  ! ${child.log.trim().split('\n')[0]}`);

  for (const [i, change] of (mod.changes || []).entries()) {
    await stop(child);
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const patch = JSON.parse(fs.readFileSync(path.join(dir, change.patch), 'utf8'));
    applyPatch(graph, patch);
    const errors = validate(graph);
    const name = `${app} +${i + 1} ${change.title || change.patch}`;
    if (errors.length) {
      console.log(`\n=== ${name} ===\n  ✗ patch rejected by the checker:\n${formatErrors(errors)}`);
      totalAll += change.checks.length; summary.push([name, 0, change.checks.length]);
      continue;
    }
    graphFile = `apps/${app}/.stage${i + 1}.json`;
    fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2) + '\n');
    port++;
    child = boot(graphFile, port);
    await wait(700);
    const migrations = child.log.split('\n').filter((l) => l.startsWith('migration:'));
    const stageCtx = make(`http://127.0.0.1:${port}`, sink);
    stageCtx.migrations = migrations;
    stageCtx.patchBytes = Buffer.byteLength(JSON.stringify(patch));
    await runChecks(name, change.checks, stageCtx);
    if (migrations.length) console.log(`  · ${migrations.join('\n  · ')}`);
  }
  await stop(child);
  for (const f of fs.readdirSync(dir)) if (/^\.stage\d+\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  port++;
}

sink.close();
console.log('\n================ ИТОГ ================');
for (const [app, ok, all] of summary) console.log(`${ok === all ? '✓' : '✗'} ${app.padEnd(28)} ${ok}/${all}`);
console.log(`\n${totalOk}/${totalAll} проверок пройдено`);
process.exit(totalOk === totalAll ? 0 : 1);
