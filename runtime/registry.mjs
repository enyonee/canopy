// The registry: the five tables the kernel consults by name — field kinds,
// blocks, connector transports, expression functions, client widgets — and
// `descriptors`, the data behind the transports that come from a connector descriptor.
// Built-ins fill it; a plugin (an ES module next to the application, listed in
// /plugins) adds entries with the same contracts. Node kinds are not here:
// they are the format, and the checker has to know all of them.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIELDS } from './fields.mjs';
import { CATALOG } from './blocks.mjs';
import { TRANSPORTS } from './transports.mjs';
import { FUNCTIONS } from './functions.mjs';
import { WIDGETS } from './widgets.mjs';
import { BUILTIN } from './connectors/builtin.mjs';
import { checkDescriptor } from './connectors/descriptor.mjs';
import { synthesize } from './connectors/engine.mjs';

export const TABLES = ['fields', 'blocks', 'transports', 'functions', 'widgets'];

export function createRegistry() {
  return { fields: { ...FIELDS }, blocks: { ...CATALOG }, transports: { ...TRANSPORTS }, functions: { ...FUNCTIONS },
    widgets: { ...WIDGETS }, descriptors: { ...BUILTIN }, plugins: [], legacy: [] };
}

// A connector descriptor (a .json plugin): checked, then registered as a descriptor and as the
// transport of the same name, so its kind is a connector kind like any other.
export function registerDescriptor(registry, descriptor, name = 'descriptor') {
  const bad = checkDescriptor(descriptor);
  if (bad.length) throw new Error(`${name}: invalid descriptor — ${bad.map(([p, m]) => `${p || '/'} ${m}`).join('; ')}`);
  const kind = descriptor.name;
  if (registry.transports[kind]) throw new Error(`${name}: connector kind "${kind}" is already registered${registry.transports[kind].plugin ? ` by ${registry.transports[kind].plugin}` : ''}`);
  registry.descriptors[kind] = descriptor;
  registry.transports[kind] = { ...synthesize(descriptor), plugin: name };
  registry.plugins.push(name);
  return registry;
}

// Merge one plugin's declarations. A name already taken is an error, never a silent override.
export function register(registry, plugin, name = 'plugin') {
  if (!plugin || typeof plugin !== 'object') throw new Error(`${name}: a plugin exports an object with fields, blocks, transports or functions`);
  const known = TABLES.filter((t) => plugin[t]);
  if (!known.length) throw new Error(`${name}: nothing to register (expected fields, blocks, transports or functions)`);
  for (const table of known) {
    for (const [key, entry] of Object.entries(plugin[table])) {
      if (registry[table][key]) throw new Error(`${name}: ${table} "${key}" is already registered${registry[table][key].plugin ? ` by ${registry[table][key].plugin}` : ''}`);
      if (!entry || typeof entry !== 'object') throw new Error(`${name}: ${table} "${key}" must be an object`);
      registry[table][key] = { ...entry, plugin: name };
    }
  }
  registry.plugins.push(name);
  // Blocks get the store: a plugin that has them says `async: true` (or `api: 2`) once they await everything
  // the store, `resolve` and `text` answer. One that does not is `legacy`: fine on a synchronous driver, refused
  // by the checker on an asynchronous one (runtime/check/plugins.mjs).
  if (plugin.blocks && plugin.async !== true && plugin.api !== 2) registry.legacy.push(name);
  return registry;
}

// Load the plugins a graph names, relative to its directory. Load errors come back
// as checker-shaped errors so the graph is reported invalid instead of crashing.
// A widget's "client" is declared as a path relative to that same directory
// (like the plugin path itself) and resolved once here, to an absolute path
// the server can read at request time — never the request's own widget name,
// so there is no path a client request could use to read a file it did not declare.
export async function loadPlugins(graph, baseDir) {
  const registry = createRegistry();
  const errors = [];
  const list = Array.isArray(graph?.plugins) ? graph.plugins : [];
  for (const [i, p] of list.entries()) {
    if (typeof p !== 'string') { errors.push({ path: `/plugins/${i}`, message: 'a plugin is a path to an ES module or to a connector descriptor (.json)', hint: '"./plugins/loyalty.mjs", "../../connectors/stripe/descriptor.json"' }); continue; }
    try {
      if (p.endsWith('.json')) { registerDescriptor(registry, JSON.parse(fs.readFileSync(path.resolve(baseDir, p), 'utf8')), p); continue; }
      const mod = await import(pathToFileURL(path.resolve(baseDir, p)).href);
      const decl = mod.default || mod;
      register(registry, decl, p);
      for (const [name, w] of Object.entries(decl.widgets || {})) {
        if (typeof w.client !== 'string') throw new Error(`widget "${name}" needs "client" as a path string`);
        registry.widgets[name].client = path.resolve(baseDir, w.client);
      }
    } catch (e) {
      errors.push({ path: `/plugins/${i}`, message: `cannot load plugin "${p}": ${e.message}` });
    }
  }
  return { registry, errors };
}

export const DEFAULT = createRegistry();
