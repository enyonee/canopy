// The operator's commands of the connector library, run from the command line and never over HTTP:
//   --connectors status | live NAME --confirm | sandbox NAME     (the mode of each connector: deploy.json)
//   --secrets set NAME | list | rm NAME                          (the secret store: secrets.enc)
// A secret's value is read from stdin, never from an argument (the shell would keep it in its history),
// and nothing here prints one. Every refusal says what to do and changes nothing.
import { openSecrets } from './secrets.mjs';
import { readDeploy, writeMode, connectorModes, MODES } from './deploy.mjs';
import { secretSlots, secretName } from './connectors/engine.mjs';

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
 * @param {{ graph: any, registry: any, dir: string, log: (m: string) => void, err: (m: string) => void, stdin: () => Promise<string> }} ctx
 */
export async function admin(argv, { graph, registry, dir, log, err, stdin }) {
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
  const ctx = { graph, registry, dir, log, stdin, secrets: openSecrets({ dir, app: graph.app }) };
  try {
    if (flag === '--secrets' && ['set', 'list', 'rm'].includes(sub)) await secretCommand(ctx, sub, name, extra);
    else if (flag === '--connectors' && sub === 'status') status(ctx);
    else if (flag === '--connectors' && MODES.includes(sub)) setMode(ctx, name ?? refuse(`--connectors ${sub} needs a connector NAME`), sub, argv.includes('--confirm'));
    else refuse(flag === '--secrets' ? 'usage: --secrets set NAME | list | rm NAME' : 'usage: --connectors status | live NAME --confirm | sandbox NAME');
    return 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}
