#!/usr/bin/env node
// Boots each app on its own port, runs its checks, reports. One app per line.
// A local sink receives the apps' outgoing HTTP. After the base checks, each
// declared change (a JSON patch + its checks) is applied on the same database
// and checked again: the lifecycle, not only the first build.
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { make, startSink } from './lib.mjs';
import { applyPatch } from '../runtime/patch.mjs';
import { validate, formatErrors } from '../runtime/validate.mjs';
import { loadPlugins } from '../runtime/registry.mjs';
import { openSecrets } from '../runtime/secrets.mjs';

const BOOT_DEADLINE = 10_000; // apps in this repo start in well under a second (see REPORT.md); this is generous headroom
const CHECK_TIMEOUT = Number(process.env.AG_CHECK_TIMEOUT || 20) * 1000; // one hung fetch must not stall the whole run

// `--dated`: only the apps whose graph reads the calendar (today / days( / addDays). Meant to run
// with the clock shifted (verify/shift.mjs, see CI): a literal date in a seed or a check is a time bomb.
const dated = process.argv.includes('--dated');
const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const readsCalendar = (d) => /\btoday\b|\bdays\(|\baddDays\b/.test(fs.readFileSync(`apps/${d}/app.json`, 'utf8'));
const apps = named.length ? named
  : fs.readdirSync('apps').filter((d) => fs.existsSync(`apps/${d}/checks.mjs`) && (!dated || readsCalendar(d)));

// A port already answering before we ever spawned anything on it is not ours: talking
// to it would silently check a stale server instead of the one this run just booted.
const portBusy = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const sock = net.connect({ port, host }, () => { sock.destroy(); resolve(true); });
  sock.on('error', () => resolve(false));
});

// Every child we spawn is tracked here so a Ctrl-C, a kill, or a bug of our own
// still leaves no orphaned server behind. `sink` starts null: shutdown may run
// before it exists (a busy sink port fails loud before startSink is even called).
const children = new Set();
let sink = null;
let shuttingDown = false;
const killAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } } };
const shutdown = (code) => { if (shuttingDown) return; shuttingDown = true; killAll(); try { sink?.close(); } catch { /* already down */ } process.exit(code); };
const failLoud = (message) => { console.error(`✗ ${message}`); shutdown(1); };
process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
process.on('uncaughtException', (e) => { console.error('uncaught:', e?.stack || e); shutdown(1); });

const sinkPort = Number(process.env.AG_SINK_PORT || 8999);
if (await portBusy(sinkPort)) failLoud(`sink port ${sinkPort} is already in use by something else`);
sink = await startSink(sinkPort);
let port = Number(process.env.AG_PORT || 8910), totalOk = 0, totalAll = 0;
// App ports count up from AG_PORT and must step over the sink's port.
const nextPort = () => { port++; if (port === sinkPort) port++; };
const summary = [];

// AG_NO_TIMERS: a schedule's timer never fires on its own during a check run —
// every schedule check triggers `POST /schedule/<name>/run` by hand, so a run
// is deterministic and never races a background timer.
const boot = (graphFile, p) => {
  const child = spawn('node', ['--no-warnings', 'runtime/run.mjs', graphFile, '--port', String(p)],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AG_NO_TIMERS: '1' } });
  child.log = '';
  child.stdout.on('data', (d) => { child.log += d; });
  child.stderr.on('data', (d) => { child.log += d; });
  children.add(child);
  return child;
};
// A child that already exited (crashed) will never fire another 'exit' event for
// a listener attached after the fact — waiting for one here would hang forever.
const stop = (child) => new Promise((r) => {
  if (child.exitCode !== null || child.signalCode !== null) return r();
  child.on('exit', r);
  child.kill();
}).then(() => children.delete(child));

// Poll the port instead of sleeping a fixed time: ready the instant the app is
// listening, and give up with a reason (crashed, or never came up) otherwise.
const waitReady = (child, p, host = '127.0.0.1') => new Promise((resolve) => {
  const deadline = Date.now() + BOOT_DEADLINE;
  let exited = false;
  const onExit = () => { exited = true; };
  child.once('exit', onExit);
  const tryOnce = () => {
    if (exited) return resolve({ ok: false, reason: 'the app exited before it started listening' });
    if (Date.now() > deadline) return resolve({ ok: false, reason: `the app never listened on port ${p} within ${BOOT_DEADLINE}ms` });
    const sock = net.connect({ port: p, host }, () => { sock.destroy(); child.off('exit', onExit); resolve({ ok: true }); });
    sock.on('error', () => setTimeout(tryOnce, 25));
  };
  tryOnce();
});

const withTimeout = (promise, task) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`check timed out after ${CHECK_TIMEOUT}ms`)), CHECK_TIMEOUT)),
]);

const runChecks = async (name, checks, ctx) => {
  let ok = 0;
  console.log(`\n=== ${name} (${checks.length} checks) ===`);
  for (const [i, c] of checks.entries()) {
    try { const note = await withTimeout(c.run(ctx), c.task); ok++; console.log(`  ✓ ${i + 1}. ${c.task}${note ? ` — ${note}` : ''}`); }
    catch (e) { console.log(`  ✗ ${i + 1}. ${c.task}\n      ${e.message}`); }
  }
  totalOk += ok; totalAll += checks.length;
  summary.push([name, ok, checks.length]);
};

// Every check of a batch reported failed, with the child's own stderr: used both
// when the app never came up and when a patch stage crashed the same way.
const reportBootFailure = (name, checks, reason, log) => {
  console.log(`\n=== ${name} (${checks.length} checks) ===`);
  console.log(`  ✗ app did not come up: ${reason}${log ? `\n      child output:\n${log.trim().split('\n').map((l) => `      ${l}`).join('\n')}` : ''}`);
  for (const [i, c] of checks.entries()) console.log(`  ✗ ${i + 1}. ${c.task}\n      app never started: ${reason}`);
  totalAll += checks.length;
  summary.push([name, 0, checks.length]);
};

for (const app of apps) {
  const dir = path.resolve('apps', app);
  const checksFile = path.join(dir, 'checks.mjs');
  if (!fs.existsSync(checksFile)) {
    console.log(`\n=== ${app} ===\n  ? no checks.mjs — skipped, not a failure`);
    summary.push([`${app} (no checks.mjs)`, 0, 0]);
    continue;
  }
  for (const f of ['data.sqlite', 'trace.jsonl', 'session.key', 'secrets.enc', 'secrets.key']) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, 'files'), { recursive: true, force: true });
  for (const f of fs.readdirSync(dir)) if (/^\.stage\d+\.json$/.test(f)) fs.rmSync(path.join(dir, f));

  const mod = await import(`${dir}/checks.mjs?v=${Date.now()}`);
  let graphFile = `apps/${app}/app.json`;
  // An app that receives webhooks says which secrets its checks sign with: `export const secrets = { <store name>: <value> }`.
  // They go into the app's own secret store before it boots, the way an operator would put them there.
  if (mod.secrets) {
    const store = openSecrets({ dir, app: JSON.parse(fs.readFileSync(graphFile, 'utf8')).app });
    for (const [name, value] of Object.entries(mod.secrets)) store.set(name, value);
  }
  if (await portBusy(port)) failLoud(`port ${port} (for ${app}) is already in use by something else; set AG_PORT or free it`);
  let child = boot(graphFile, port);
  const ready = await waitReady(child, port);
  if (!ready.ok) {
    reportBootFailure(app, mod.checks, ready.reason, child.log);
    await stop(child);
    nextPort();
    continue;
  }
  const ctx = make(`http://127.0.0.1:${port}`, sink);
  sink.clear();
  await runChecks(app, mod.checks, ctx);
  if (child.log.includes('invalid')) console.log(`  ! ${child.log.trim().split('\n')[0]}`);

  for (const [i, change] of (mod.changes || []).entries()) {
    await stop(child);
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const patch = JSON.parse(fs.readFileSync(path.join(dir, change.patch), 'utf8'));
    applyPatch(graph, patch);
    const { registry, errors: pluginErrors } = await loadPlugins(graph, dir);
    const errors = [...pluginErrors, ...validate(graph, registry)];
    const name = `${app} +${i + 1} ${change.title || change.patch}`;
    if (errors.length) {
      console.log(`\n=== ${name} ===\n  ✗ patch rejected by the checker:\n${formatErrors(errors)}`);
      totalAll += change.checks.length; summary.push([name, 0, change.checks.length]);
      continue;
    }
    graphFile = `apps/${app}/.stage${i + 1}.json`;
    fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2) + '\n');
    nextPort();
    if (await portBusy(port)) failLoud(`port ${port} (for ${name}) is already in use by something else; set AG_PORT or free it`);
    child = boot(graphFile, port);
    const staged = await waitReady(child, port);
    if (!staged.ok) { reportBootFailure(name, change.checks, staged.reason, child.log); continue; }
    const migrations = child.log.split('\n').filter((l) => l.startsWith('migration:'));
    const stageCtx = make(`http://127.0.0.1:${port}`, sink);
    stageCtx.migrations = migrations;
    stageCtx.patchBytes = Buffer.byteLength(JSON.stringify(patch));
    await runChecks(name, change.checks, stageCtx);
    if (migrations.length) console.log(`  · ${migrations.join('\n  · ')}`);
  }
  await stop(child);
  for (const f of fs.readdirSync(dir)) if (/^\.stage\d+\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  nextPort();
}

sink.close();
console.log('\n================ ИТОГ ================');
for (const [app, ok, all] of summary) console.log(`${ok === all ? '✓' : '✗'} ${app.padEnd(28)} ${ok}/${all}`);
console.log(`\n${totalOk}/${totalAll} проверок пройдено`);
// fetch()'s keep-alive pool can leave a socket open past the last request: exit
// explicitly rather than wait on an event loop that may never drain on its own.
process.exit(totalOk === totalAll ? 0 : 1);
