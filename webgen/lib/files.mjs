// The template on disk, and writing a generated project: only files that changed are rewritten, and files a
// previous run wrote that this run no longer makes are removed (the manifest lists what webgen owns). The
// project's own state (node_modules, dist, the lockfile) is never touched.
import fs from 'node:fs';
import path from 'node:path';

export const TEMPLATE = path.join(import.meta.dirname, '..', 'template');
export const MANIFEST = '.webgen.json';

/** Every template file, path → text, in a stable order. */
export function readTemplate(dir = TEMPLATE) {
  const out = new Map();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r);
      else out.set(r, fs.readFileSync(path.join(dir, r), 'utf8'));
    }
  };
  walk('');
  return out;
}

/** The whole project in one sorted Map, the manifest included. */
export function project(template, generated) {
  const all = new Map([...template, ...generated]);
  const names = [...all.keys()].sort();
  all.set(MANIFEST, `${JSON.stringify({ generator: 'webgen', files: names }, null, 2)}\n`);
  return new Map([...all.keys()].sort().map((k) => [k, all.get(k)]));
}

/** Write `files` under `out`; returns what changed. */
export function writeProject(out, files) {
  const before = fs.existsSync(path.join(out, MANIFEST)) ? JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8')).files : [];
  const changed = [], removed = [];
  for (const old of before) {
    if (files.has(old)) continue;
    const p = path.join(out, old);
    if (fs.existsSync(p)) { fs.rmSync(p); removed.push(old); }
  }
  for (const [rel, text] of files) {
    const p = path.join(out, rel);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    changed.push(rel);
  }
  return { changed, removed };
}

/** The files under `out` that differ from `files` (for --check). */
export function diffProject(out, files) {
  const differ = [];
  for (const [rel, text] of files) {
    const p = path.join(out, rel);
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) differ.push(rel);
  }
  return differ;
}
