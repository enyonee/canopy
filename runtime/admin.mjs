// The operator's commands of the connector library, run from the command line and never over HTTP:
//   --connectors status | live NAME --confirm | sandbox NAME     (the mode of each connector: deploy.json)
//   --connectors simulate NAME EVENT --data f.json [--port N]    (POST a signed webhook to the running app)
//   --secrets set NAME | list | rm NAME                          (the secret store: secrets.enc)
// A secret's value is read from stdin, never from an argument (the shell would keep it in its history),
// and nothing here prints one. Every refusal says what to do and changes nothing.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { openSecrets } from './secrets.mjs';
import { readDeploy, writeMode, connectorModes, MODES } from './deploy.mjs';
import { secretSlots, secretName } from './connectors/engine.mjs';
import { signHeaders } from './connectors/signature.mjs';
import { typeOf } from './connectors/inbound.mjs';
import { systemClock } from './clock.mjs';

const refuse = (message) => { throw new Error(message); };

// The store names a connector's live requests read, and which of them the store lacks.
function needs(graph, registry, secrets, name) {
  const c = graph.connectors?.[name];
  if (!c) refuse(`no connector "${name}" in this graph (connectors: ${Object.keys(graph.connectors || {}).join(', ') || 'none'})`);
  const d = registry.descriptors[c.kind];
  const names = [...new Set((d ? secretSlots(d) : []).map((slot) => secretName(c, slot)))];
  return { c, names, missing: names.filter((n) => secrets.current(n) === undefined) };
}

function setMode(ctx, name, mode, confirmed) {
  const { graph, registry, secrets, dir, log } = ctx;
  const { c, missing } = needs(graph, registry, secrets, name);
  const offered = connectorModes(graph, registry, readDeploy(dir)).find((m) => m.connector === name).modes;
  if (!offered.includes(mode)) refuse(`"${name}" (${c.kind}) cannot run in ${mode} mode: it offers ${offered.join(', ')}`);
  if (mode === 'live') {
    if (!confirmed) refuse(`switching "${name}" to live sends real requests: repeat with --confirm`);
    if (missing.length) refuse(`"${name}" stays as it is: its live requests need ${missing.map((n) => `"${n}"`).join(', ')} in the secret store (--secrets set NAME)`);
  }
  writeMode(dir, name, mode);
  log(`${name}: ${mode}`);
}

function status(ctx) {
  const { graph, registry, secrets, dir, log } = ctx;
  const rows = connectorModes(graph, registry, readDeploy(dir));
  if (!rows.length) log('no connectors in this graph');
  for (const m of rows) {
    const { names, missing } = needs(graph, registry, secrets, m.connector);
    const held = names.map((n) => `${n} ${missing.includes(n) ? 'MISSING' : 'set'}`).join(', ');
    log(`${m.connector}  ${m.kind}  ${m.mode}  (offers: ${m.modes.join(', ')})${held ? `  secrets: ${held}` : ''}`);
  }
}

// A webhook as the provider would send it: `file` is the complete payload (its type and id where the descriptor
// looks for them), signed with the store's secret and posted to the running app. There is no fixed development
// secret: a connector with none in the store cannot be simulated, which is also what production would answer.
async function simulate(ctx, name, event, file, port) {
  const { graph, registry, secrets, fetchImpl, clock, log } = ctx;
  const c = needs(graph, registry, secrets, name).c;
  const inbound = registry.descriptors[c.kind]?.inbound ?? refuse(`"${name}" (${c.kind}) receives no webhooks: its descriptor has no "inbound"`);
  if (!event || !Object.hasOwn(inbound.events, event)) refuse(`"${c.kind}" sends ${event ? `no event "${event}"` : 'events'}: ${Object.keys(inbound.events).join(', ')}`);
  if (!file) refuse('--connectors simulate needs --data FILE (the JSON payload of the event)');
  const raw = Buffer.from(fs.readFileSync(file));
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { refuse(`${file} is not JSON: ${e.message}`); }
  const headers = { 'content-type': 'application/json' };
  for (const [k, spec] of [['type', inbound.type], ['eventId', inbound.eventId]]) {
    if (typeof spec !== 'string') headers[spec.header.toLowerCase()] = k === 'type' ? event : `sim-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
  }
  if (typeOf(inbound, payload, headers) !== event) refuse(`${file} does not carry the event type "${event}" where "${c.kind}" puts it (${JSON.stringify(inbound.type)})`);
  const secret = secrets.current(secretName(c, inbound.secret)) ?? refuse(`the secret "${secretName(c, inbound.secret)}" is not in the store: --secrets set ${secretName(c, inbound.secret)}`);
  Object.assign(headers, signHeaders(inbound.signature, { raw, secret, now: clock.now() }));
  const res = await fetchImpl(`http://127.0.0.1:${port}/hook/${name}`, { method: 'POST', headers, body: raw });
  log(`${res.status} ${await res.text()}`);
  if (!res.ok) refuse(`the app answered ${res.status}`);
}

async function secretCommand(ctx, sub, name, extra) {
  const { secrets, stdin, log } = ctx;
  if (sub === 'list') { const names = secrets.names(); log(names.length ? names.join('\n') : '(no secrets)'); return; }
  if (!name) refuse(`--secrets ${sub} needs a NAME`);
  if (sub === 'rm') { if (!secrets.remove(name)) refuse(`no secret "${name}"`); log(`removed ${name}`); return; }
  if (extra !== undefined) refuse('the value of a secret is read from stdin, never from the command line: echo -n "$VALUE" | run.mjs app.json --secrets set NAME');
  const value = (await stdin()).replace(/\r?\n$/, '');
  secrets.set(name, value);
  log(`set ${name}`);
}

/**
 * Run the command of `argv` if it is one of these; null when it is not (the caller goes on). Returns the exit code.
 * @param {string[]} argv
 * @param {{ graph: any, registry: any, dir: string, log: (m: string) => void, err: (m: string) => void, stdin: () => Promise<string>, fetchImpl?: typeof fetch, clock?: import('./types.d.ts').Clock }} ctx
 */
export async function admin(argv, { graph, registry, dir, log, err, stdin, fetchImpl = fetch, clock = systemClock }) {
  const flag = ['--connectors', '--secrets'].find((f) => argv.includes(f));
  if (!flag) return null;
  // The words after the flag, up to the next option (--confirm may stand anywhere among them).
  const words = [];
  for (const a of argv.slice(argv.indexOf(flag) + 1)) {
    if (a === '--confirm') continue;
    if (a.startsWith('--')) break;
    words.push(a);
  }
  const [sub, name, extra] = words;
  const ctx = { graph, registry, dir, log, stdin, fetchImpl, clock, secrets: openSecrets({ dir, app: graph.app }) };
  const option = (n, def) => { const i = argv.indexOf(`--${n}`); return i === -1 ? def : argv[i + 1]; };
  try {
    if (flag === '--secrets' && ['set', 'list', 'rm'].includes(sub)) await secretCommand(ctx, sub, name, extra);
    else if (flag === '--connectors' && sub === 'status') status(ctx);
    else if (flag === '--connectors' && sub === 'simulate') await simulate(ctx, name, extra, option('data'), option('port', 8901));
    else if (flag === '--connectors' && MODES.includes(sub)) setMode(ctx, name ?? refuse(`--connectors ${sub} needs a connector NAME`), sub, argv.includes('--confirm'));
    else refuse(flag === '--secrets' ? 'usage: --secrets set NAME | list | rm NAME' : 'usage: --connectors status | live NAME --confirm | sandbox NAME | simulate NAME EVENT --data FILE');
    return 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}
