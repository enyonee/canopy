// The mode of each connector, sandbox or live, is a property of the deployment and not of the graph
// (the same app.json runs on a laptop and in production): `deploy.json` beside the database holds
// `{ "connectors": { "<name>": "sandbox" | "live" } }`, and only the CLI writes it. Absent, everything
// runs as its descriptor's first mode says (`modes`: `http` is live only, `mail` sandbox only, a
// descriptor that says nothing is live — today's behaviour). This module also builds the delivery
// environment of a running app: the deploy file, read afresh each time, and the secret store.
import fs from 'node:fs';
import path from 'node:path';
import { openSecrets } from './secrets.mjs';

export const MODES = ['sandbox', 'live'];

/** The modes a connector kind offers, first is the default: its descriptor's, else its transport's, else live. */
export const modesOf = (registry, kind) => registry.descriptors[kind]?.modes ?? registry.transports[kind]?.modes ?? ['live'];

/** The deploy file of a directory as `{ connectors: {...} }`; absent is empty, malformed throws. */
export function readDeploy(dir) {
  const file = path.join(dir, 'deploy.json');
  if (!fs.existsSync(file)) return { connectors: {} };
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`deploy.json is not JSON: ${e.message}`); }
  const c = d?.connectors;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.values(c).some((m) => !MODES.includes(m)))
    throw new Error('deploy.json is {"connectors": {"<name>": "sandbox" | "live"}}');
  return d;
}

/** Write one connector's mode (the file is rewritten whole, atomically). */
export function writeMode(dir, name, mode) {
  const d = readDeploy(dir);
  d.connectors[name] = mode;
  const file = path.join(dir, 'deploy.json');
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(d, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

/** The mode a connector runs in: what the deploy file says, else the first of its kind's modes. */
export const modeOf = (deploy, connector, modes) => deploy.connectors[connector] ?? modes[0];

/** Every connector of a graph with its kind, its mode now and the modes it may have: [{ connector, kind, mode, modes }]. */
export function connectorModes(graph, registry, deploy) {
  return Object.entries(graph.connectors || {}).map(([connector, c]) => {
    const modes = modesOf(registry, c.kind);
    return { connector, kind: c.kind, mode: modeOf(deploy, connector, modes), modes };
  });
}

/** What a running app delivers with: `deploy()` (the file, read now) and the `secrets` store. */
export function connectorEnv(dir, app, env = process.env) {
  return { deploy: () => readDeploy(dir), secrets: openSecrets({ dir, app, env }) };
}
