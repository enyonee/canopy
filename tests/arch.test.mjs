// The architecture gates. Everything here is a static (or near-static) scan
// of runtime/ sources, plus one dynamic check of registry contract shapes
// (built-ins and every plugin). No dependency parses real JS — comments,
// strings and template literals are masked to same-length whitespace first
// (recursively through `${...}`, so nested templates/strings/comments inside
// an interpolation are handled too), then everything below scans the masked
// buffer for braces and keywords. This is "simple" on purpose (documented
// here, not hidden): it cannot see control-flow written inside a template
// placeholder, and it does not distinguish a function's true name from
// whatever identifier sits just before its `(`. Both are fine for this
// codebase — checked against every runtime file below every gate is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Budgets. The only numbers in this file that are policy, not mechanism.
// ---------------------------------------------------------------------------
const MAX_MODULE_LINES = 300;
const MAX_FUNCTION_LINES = 60;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
function walk(dir, filter = (f) => f.endsWith('.mjs')) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p, filter));
    else if (filter(e.name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

const RUNTIME_FILES = walk('runtime').sort();
const SOURCE = Object.fromEntries(RUNTIME_FILES.map((f) => [f, fs.readFileSync(f, 'utf8')]));

// ---------------------------------------------------------------------------
// Masking: strings, template literals (recursively through ${...}) and
// comments become spaces (newlines kept, so line numbers stay meaningful).
// Braces, keywords and identifiers in real code are untouched.
// ---------------------------------------------------------------------------
function skipString(src, i) {
  const q = src[i]; i++;
  while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
  return Math.min(i + 1, src.length);
}
function skipTemplate(src, i) {
  i++; // past the opening `
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        const d = src[i];
        if (d === '{') { depth++; i++; }
        else if (d === '}') { depth--; i++; }
        else if (d === '"' || d === "'") { i = skipString(src, i); }
        else if (d === '`') { i = skipTemplate(src, i); }
        else if (src[i] === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j === -1 ? src.length : j; }
        else if (src[i] === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j === -1 ? src.length : j + 2; }
        else i++;
      }
      continue;
    }
    i++;
  }
  return i;
}
function mask(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); const end = j === -1 ? src.length : j; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); const end = j === -1 ? src.length : j + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === '"' || c === "'") { const end = skipString(src, i); out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === '`') { const end = skipTemplate(src, i); out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    out += c; i++;
  }
  return out;
}
const MASKED = Object.fromEntries(RUNTIME_FILES.map((f) => [f, mask(SOURCE[f])]));
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

function matchingBrace(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Function bodies: every `=> {`, `function NAME(...) {` and method-shorthand
// `name(...) {` (excluding control-flow keywords), found on the masked buffer.
// ---------------------------------------------------------------------------
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'try', 'finally', 'class']);
function findFunctionOpenBraces(masked) {
  const opens = new Set();
  for (const m of masked.matchAll(/=>\s*\{/g)) opens.add(masked.indexOf('{', m.index));
  for (const m of masked.matchAll(/\bfunction\b\s*\*?\s*[A-Za-z0-9_$]*\s*\([^()]*\)\s*\{/g)) opens.add(masked.indexOf('{', m.index + m[0].length - 1));
  for (const m of masked.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/gm)) {
    if (CONTROL_KEYWORDS.has(m[2])) continue;
    if (/\bfunction\s*$/.test(masked.slice(Math.max(0, m.index), m.index + m[1].length))) continue;
    opens.add(masked.indexOf('{', m.index + m[0].length - 1));
  }
  return [...opens].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Imports: `import ... from 'x'` and `export ... from 'x'` (re-exports count
// as using what they forward). Dynamic import() of a non-literal path (the
// plugin loader) is deliberately not part of the static module graph.
// ---------------------------------------------------------------------------
// Statements are located on the MASKED text (so `import`/`export` inside a string or comment never
// counts), but the specifier is read from the ORIGINAL source at the same offset: masking blanks the
// literal itself, and it is same-length, so offsets line up.
function literalAt(src, idx, re) {
  const r = new RegExp(re.source, 'y');
  r.lastIndex = idx;
  const m = r.exec(src);
  return m ? m[2] : null;
}
function parseImportSpecifiers(masked, src) {
  const found = [];
  // `import x from 'y'`, `import {a,\n b} from 'y'`, `import * as n from 'y'`, `export ... from 'y'`
  for (const m of masked.matchAll(/\b(?:import|export)\b[\w$*{},\s]*?\bfrom\b/g)) {
    const spec = literalAt(src, m.index + m[0].length, /\s*(['"])([^'"\n]+)\1/);
    if (spec !== null) found.push([m.index, spec]);
  }
  // bare `import 'y'`
  for (const m of masked.matchAll(/\bimport\b/g)) {
    const spec = literalAt(src, m.index + m[0].length, /\s*(['"])([^'"\n]+)\1/);
    if (spec !== null) found.push([m.index, spec]);
  }
  // dynamic `import('y')` with a literal path
  for (const m of masked.matchAll(/\bimport\s*\(/g)) {
    const spec = literalAt(src, m.index + m[0].length, /\s*(['"])([^'"\n]+)\1(?=\s*\))/);
    if (spec !== null) found.push([m.index, spec]);
  }
  return found.sort((x, y) => x[0] - y[0]).map(([, spec]) => spec);
}

test('parseImportSpecifiers reads specifiers from the original source, ignores imports in strings and comments', () => {
  const src = [
    "import a from './one.mjs';",
    "import {",
    "  b,",
    "  c as d,",
    "} from './two.mjs';",
    "import * as n from 'node:fs';",
    "import './bare.mjs';",
    "export { e } from \"./three.mjs\";",
    "export * from './four.mjs';",
    "const lazy = await import('./five.mjs');",
    "const dyn = await import(pathVar);",
    "const s = \"import x from './fake-string.mjs'\";",
    "const t = `import('./fake-template.mjs')`;",
    "// import y from './fake-comment.mjs'",
    "/* export { z } from './fake-block.mjs' */",
    "export const k = 1;",
  ].join('\n');
  assert.deepEqual(parseImportSpecifiers(mask(src), src),
    ['./one.mjs', './two.mjs', 'node:fs', './bare.mjs', './three.mjs', './four.mjs', './five.mjs']);
});

// ===========================================================================
test('module size budget: no runtime module exceeds ' + MAX_MODULE_LINES + ' lines', () => {
  const over = RUNTIME_FILES.map((f) => [f, SOURCE[f].split('\n').length]).filter(([, n]) => n > MAX_MODULE_LINES);
  assert.deepEqual(over, [], `over budget: ${over.map(([f, n]) => `${f} (${n})`).join(', ')}`);
});

test('function size budget: no function/method body exceeds ' + MAX_FUNCTION_LINES + ' lines', () => {
  const over = [];
  for (const f of RUNTIME_FILES) {
    const masked = MASKED[f];
    for (const open of findFunctionOpenBraces(masked)) {
      const close = matchingBrace(masked, open);
      if (close === -1) continue;
      const lines = SOURCE[f].slice(open, close).split('\n').length;
      if (lines > MAX_FUNCTION_LINES) over.push(`${f}:${lineOf(SOURCE[f], open)} (${lines} lines)`);
    }
  }
  assert.deepEqual(over, [], `over budget: ${over.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Layering: an explicit allow-list of internal edges, a second table for
// `node:` built-ins, and a cycle check over the same edges.
// ---------------------------------------------------------------------------
const ALLOWED = {
  'runtime/admin.mjs': ['runtime/secrets.mjs', 'runtime/deploy.mjs', 'runtime/connectors/engine.mjs', 'runtime/connectors/signature.mjs', 'runtime/connectors/inbound.mjs', 'runtime/clock.mjs'],
  'runtime/auth.mjs': [],
  'runtime/blocks.mjs': ['runtime/fields.mjs', 'runtime/connectors/engine.mjs', 'runtime/check/calls.mjs'],
  'runtime/boot.mjs': [],
  'runtime/check/actions.mjs': [],
  'runtime/check/basics.mjs': ['runtime/check/util.mjs'],
  'runtime/check/calls.mjs': ['runtime/check/util.mjs', 'runtime/expr.mjs', 'runtime/connectors/schema.mjs'],
  'runtime/check/connectors.mjs': [],
  'runtime/check/dashboards.mjs': [],
  'runtime/check/data.mjs': ['runtime/spec.mjs'],
  'runtime/check/events.mjs': [],
  'runtime/check/lists.mjs': [],
  'runtime/check/override.mjs': ['runtime/check/util.mjs'],
  'runtime/check/pages.mjs': ['runtime/check/util.mjs'],
  'runtime/check/plugins.mjs': [],
  'runtime/check/roles.mjs': [],
  'runtime/check/rules.mjs': [],
  'runtime/check/schedule.mjs': ['runtime/schedule.mjs'],
  'runtime/check/scope.mjs': ['runtime/expr.mjs', 'runtime/spec.mjs', 'runtime/check/util.mjs'],
  'runtime/check/search.mjs': [],
  'runtime/check/seed.mjs': [],
  'runtime/check/states.mjs': [],
  'runtime/check/steps.mjs': ['runtime/check/util.mjs'],
  'runtime/check/util.mjs': [],
  'runtime/cli.mjs': ['runtime/server.mjs', 'runtime/validate.mjs', 'runtime/registry.mjs', 'runtime/admin.mjs'],
  'runtime/client/api.mjs': [],
  'runtime/clock.mjs': [],
  'runtime/connectors/backoff.mjs': [],
  'runtime/connectors/builtin.mjs': [],
  'runtime/connectors/descriptor.mjs': ['runtime/connectors/schema.mjs', 'runtime/connectors/template.mjs', 'runtime/connectors/backoff.mjs', 'runtime/connectors/sandbox.mjs', 'runtime/connectors/inbound.mjs'],
  'runtime/connectors/inbound.mjs': ['runtime/connectors/schema.mjs', 'runtime/connectors/template.mjs', 'runtime/connectors/signature.mjs'],
  'runtime/connectors/engine.mjs': ['runtime/connectors/schema.mjs', 'runtime/connectors/template.mjs', 'runtime/connectors/descriptor.mjs', 'runtime/connectors/backoff.mjs', 'runtime/connectors/sandbox.mjs', 'runtime/clock.mjs'],
  'runtime/connectors/redact.mjs': [],
  'runtime/connectors/sandbox.mjs': ['runtime/connectors/template.mjs'],
  'runtime/connectors/schema.mjs': [],
  'runtime/connectors/signature.mjs': [],
  'runtime/connectors/template.mjs': [],
  'runtime/deploy.mjs': ['runtime/secrets.mjs'],
  'runtime/expr.mjs': ['runtime/functions.mjs'],
  'runtime/fields.mjs': [],
  'runtime/functions.mjs': [],
  'runtime/interp.mjs': ['runtime/outbox.mjs', 'runtime/expr.mjs', 'runtime/spec.mjs', 'runtime/deploy.mjs'],
  'runtime/outbox.mjs': ['runtime/registry.mjs', 'runtime/clock.mjs', 'runtime/connectors/backoff.mjs', 'runtime/settle.mjs', 'runtime/connectors/redact.mjs', 'runtime/deploy.mjs'],
  'runtime/secrets.mjs': [],
  'runtime/settle.mjs': ['runtime/connectors/backoff.mjs'],
  'runtime/patch.mjs': ['runtime/validate.mjs'],
  'runtime/registry.mjs': ['runtime/fields.mjs', 'runtime/blocks.mjs', 'runtime/transports.mjs', 'runtime/functions.mjs', 'runtime/widgets.mjs',
    'runtime/connectors/builtin.mjs', 'runtime/connectors/descriptor.mjs', 'runtime/connectors/engine.mjs'],
  'runtime/render.mjs': ['runtime/spec.mjs'],
  'runtime/render/dashboard.mjs': ['runtime/spec.mjs', 'runtime/render.mjs'],
  'runtime/render/detail.mjs': ['runtime/render.mjs', 'runtime/render/form.mjs'],
  'runtime/render/form.mjs': ['runtime/spec.mjs', 'runtime/render.mjs'],
  'runtime/render/list.mjs': ['runtime/render.mjs'],
  'runtime/render/pages.mjs': ['runtime/render.mjs', 'runtime/render/form.mjs'],
  'runtime/render/search.mjs': ['runtime/render.mjs'],
  'runtime/routes/context.mjs': ['runtime/render.mjs'],
  'runtime/routes/hooks.mjs': ['runtime/routes/context.mjs', 'runtime/connectors/engine.mjs', 'runtime/connectors/signature.mjs', 'runtime/connectors/inbound.mjs'],
  'runtime/routes/entity.mjs': ['runtime/render.mjs', 'runtime/render/list.mjs', 'runtime/render/form.mjs', 'runtime/render/detail.mjs', 'runtime/routes/rows.mjs'],
  'runtime/routes/rows.mjs': ['runtime/render.mjs', 'runtime/render/detail.mjs'],
  'runtime/routes/schedule.mjs': ['runtime/render.mjs'],
  'runtime/routes/session.mjs': ['runtime/auth.mjs', 'runtime/render/pages.mjs'],
  'runtime/routes/system.mjs': ['runtime/render.mjs', 'runtime/render/pages.mjs'],
  'runtime/routes/views.mjs': ['runtime/spec.mjs', 'runtime/render.mjs', 'runtime/render/pages.mjs', 'runtime/render/dashboard.mjs', 'runtime/render/list.mjs', 'runtime/render/search.mjs'],
  'runtime/routes/widgets.mjs': [],
  'runtime/driver.mjs': ['runtime/driver/sqlite.mjs'],
  'runtime/driver/sqlite.mjs': ['runtime/driver/dialects.mjs'],
  'runtime/driver/dialects.mjs': [],
  'runtime/run.mjs': ['runtime/cli.mjs'],
  'runtime/schedule.mjs': [],
  'runtime/server.mjs': ['runtime/validate.mjs', 'runtime/store.mjs', 'runtime/registry.mjs', 'runtime/auth.mjs', 'runtime/interp.mjs',
    'runtime/boot.mjs', 'runtime/render.mjs', 'runtime/routes/context.mjs', 'runtime/routes/session.mjs', 'runtime/routes/views.mjs',
    'runtime/routes/system.mjs', 'runtime/routes/entity.mjs', 'runtime/routes/widgets.mjs', 'runtime/routes/schedule.mjs', 'runtime/routes/hooks.mjs', 'runtime/schedule.mjs',
    'runtime/outbox.mjs', 'runtime/clock.mjs', 'runtime/deploy.mjs'],
  'runtime/spec.mjs': ['runtime/expr.mjs', 'runtime/fields.mjs'],
  'runtime/store.mjs': ['runtime/spec.mjs', 'runtime/expr.mjs', 'runtime/auth.mjs', 'runtime/registry.mjs', 'runtime/driver.mjs', 'runtime/store/query.mjs', 'runtime/store/hydrate.mjs', 'runtime/store/lazy.mjs', 'runtime/store/state.mjs', 'runtime/store/rules.mjs', 'runtime/store/migrate.mjs', 'runtime/store/ctx.mjs'],
  'runtime/store/aggexpr.mjs': [],
  'runtime/store/ctx.mjs': ['runtime/spec.mjs'],
  'runtime/store/aggsql.mjs': ['runtime/expr.mjs', 'runtime/store/aggexpr.mjs'],
  'runtime/store/hydrate.mjs': ['runtime/store/aggsql.mjs', 'runtime/store/plan.mjs', 'runtime/store/snapshot.mjs'],
  'runtime/store/lazy.mjs': ['runtime/store/aggsql.mjs'],
  'runtime/store/plan.mjs': [],
  'runtime/store/snapshot.mjs': ['runtime/expr.mjs', 'runtime/spec.mjs', 'runtime/store/ctx.mjs', 'runtime/store/aggsql.mjs'],
  'runtime/store/query.mjs': ['runtime/spec.mjs'],
  'runtime/store/rules.mjs': ['runtime/spec.mjs', 'runtime/expr.mjs'],
  'runtime/store/state.mjs': ['runtime/connectors/backoff.mjs'],
  'runtime/store/migrate.mjs': [],
  'runtime/transports.mjs': ['runtime/connectors/builtin.mjs', 'runtime/connectors/engine.mjs'],
  'runtime/validate.mjs': ['runtime/registry.mjs', 'runtime/check/scope.mjs', 'runtime/check/steps.mjs', 'runtime/check/basics.mjs',
    'runtime/check/plugins.mjs', 'runtime/check/data.mjs', 'runtime/check/roles.mjs', 'runtime/check/override.mjs', 'runtime/check/lists.mjs',
    'runtime/check/dashboards.mjs', 'runtime/check/pages.mjs', 'runtime/check/seed.mjs', 'runtime/check/actions.mjs', 'runtime/check/events.mjs',
    'runtime/check/states.mjs', 'runtime/check/connectors.mjs', 'runtime/check/rules.mjs', 'runtime/check/schedule.mjs', 'runtime/check/search.mjs'],
  'runtime/widgets.mjs': [],
};

const NODE_BUILTINS = {
  'runtime/admin.mjs': ['node:fs', 'node:crypto'],
  'runtime/connectors/backoff.mjs': ['node:crypto'],
  'runtime/connectors/signature.mjs': ['node:crypto'],
  'runtime/auth.mjs': ['node:crypto', 'node:fs'],
  'runtime/deploy.mjs': ['node:fs', 'node:path'],
  'runtime/secrets.mjs': ['node:crypto', 'node:fs', 'node:path'],
  'runtime/boot.mjs': ['node:fs', 'node:path'],
  'runtime/cli.mjs': ['node:path', 'node:fs'],
  'runtime/patch.mjs': ['node:fs'],
  'runtime/registry.mjs': ['node:fs', 'node:path', 'node:url'],
  'runtime/routes/context.mjs': ['node:fs', 'node:path', 'node:stream'],
  'runtime/routes/system.mjs': ['node:fs', 'node:path'],
  'runtime/routes/widgets.mjs': ['node:fs'],
  'runtime/server.mjs': ['node:http', 'node:fs', 'node:path'],
  'runtime/driver/sqlite.mjs': ['node:sqlite'],
};

function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith('node:')) return spec;
  if (!spec.startsWith('.')) return null; // a bare specifier (a real npm dep) — none exist in runtime/
  const resolved = path.normalize(path.join(path.dirname(fromFile), spec)).replace(/\\/g, '/');
  return resolved;
}

test('layering: every internal import is in the explicit allow-list, every node: built-in is where it should be', () => {
  const badInternal = [], badBuiltin = [];
  for (const f of RUNTIME_FILES) {
    for (const spec of parseImportSpecifiers(MASKED[f], SOURCE[f])) {
      const resolved = resolveSpecifier(f, spec);
      if (resolved === null) continue;
      if (resolved.startsWith('node:')) {
        if (!(NODE_BUILTINS[f] || []).includes(resolved)) badBuiltin.push(`${f} -> ${resolved}`);
        continue;
      }
      if (!(ALLOWED[f] || []).includes(resolved)) badInternal.push(`${f} -> ${resolved}`);
    }
  }
  assert.deepEqual(badInternal, [], `import edge not in the allow-list: ${badInternal.join(', ')}`);
  assert.deepEqual(badBuiltin, [], `node: built-in not allowed for this module: ${badBuiltin.join(', ')}`);
});

test('layering: no import cycles', () => {
  const visiting = new Set(), done = new Set();
  const stack = [];
  const cycle = [];
  const visit = (f) => {
    if (done.has(f)) return false;
    if (visiting.has(f)) { cycle.push(...stack.slice(stack.indexOf(f)), f); return true; }
    visiting.add(f); stack.push(f);
    for (const dep of ALLOWED[f] || []) if (visit(dep)) return true;
    stack.pop(); visiting.delete(f); done.add(f);
    return false;
  };
  for (const f of Object.keys(ALLOWED)) if (visit(f)) break;
  assert.deepEqual(cycle, [], `import cycle: ${cycle.join(' -> ')}`);
});

// ---------------------------------------------------------------------------
// The driver seam: SQLite is reached only through runtime/driver/. Nothing else in
// runtime/ names the engine, prepares a statement, runs DDL through a raw handle or
// asks sqlite_master / PRAGMA — the store speaks the Driver contract (types.d.ts).
// ---------------------------------------------------------------------------
test('SQLite-only surface (DatabaseSync, .prepare/.exec, PRAGMA, sqlite_master, AUTOINCREMENT, .db) stays under runtime/driver/', () => {
  const bad = [];
  for (const f of RUNTIME_FILES) {
    if (f.startsWith('runtime/driver/')) continue;
    for (const m of SOURCE[f].matchAll(/\b(DatabaseSync|PRAGMA|sqlite_master|AUTOINCREMENT)\b/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)} (${m[1]})`);
    for (const m of MASKED[f].matchAll(/\.prepare\(|\b(?:db|drv|store|this)\.exec\(|\b(?:this|store)\.db\b/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)} (${m[0]})`);
  }
  assert.deepEqual(bad, [], `engine access outside runtime/driver/: ${bad.join(', ')}`);
});

// S2: the store builds SQL through `drv.dialect`; it never spells a construct only SQLite has.
// Comments are stripped first — a comment may name what the code no longer does.
test('runtime/store/** and runtime/store.mjs contain no SQLite-only keyword (they go through the dialect)', () => {
  const only = /\b(IFNULL|strftime|INSERT\s+OR\s+(?:REPLACE|IGNORE)|AUTOINCREMENT|PRAGMA|sqlite_master|sqlite_sequence|lastInsertRowid|last_insert_rowid|GLOB|rowid)\b/i;
  const bad = [];
  for (const f of RUNTIME_FILES.filter((x) => x.startsWith('runtime/store/') || x === 'runtime/store.mjs')) {
    const code = SOURCE[f].replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');
    const m = only.exec(code);
    if (m) bad.push(`${f}:${lineOf(code, m.index)} (${m[1]})`);
  }
  assert.deepEqual(bad, [], `SQLite-only SQL outside runtime/driver/: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------
// No swallowed errors: an empty (or comment-only) catch body needs an
// `// allow-swallow: <reason>` marker on/inside it.
// ---------------------------------------------------------------------------
function findCatchBlocks(src, masked) {
  const out = [];
  for (const m of masked.matchAll(/\bcatch\b\s*(\([^)]*\))?\s*\{/g)) {
    const open = masked.indexOf('{', m.index + m[0].length - 1);
    const close = matchingBrace(masked, open);
    if (close === -1) continue;
    out.push({ open, close, text: src.slice(open + 1, close), raw: src.slice(m.index, close + 1) });
  }
  return out;
}

test('no swallowed errors: an empty catch needs an allow-swallow marker', () => {
  const bad = [];
  for (const f of RUNTIME_FILES) {
    for (const c of findCatchBlocks(SOURCE[f], MASKED[f])) {
      const stripped = c.text.replace(/\/\/[^\n]*/g, '').trim();
      if (stripped !== '') continue; // has real code
      if (/allow-swallow:/.test(c.raw)) continue;
      bad.push(`${f}:${lineOf(SOURCE[f], c.open)}`);
    }
  }
  assert.deepEqual(bad, [], `empty catch without // allow-swallow: <reason> — ${bad.join(', ')}`);
});

test('no catch converts an error into success without an allow-swallow marker', () => {
  // "return true" is also routes/*.mjs's own "I handled this request" contract
  // (see routes/context.mjs), unrelated to the fail-open class of bug this
  // guards against — checked everywhere except there; "ok = true" (the actual
  // shape of the bug this fixed — see runtime/interp.mjs's validateValues) is
  // checked everywhere, routes included.
  const bad = [];
  for (const f of RUNTIME_FILES) {
    const checkReturnTrue = !f.startsWith('runtime/routes/');
    for (const c of findCatchBlocks(SOURCE[f], MASKED[f])) {
      const hit = /\bok\s*=\s*true\b/.test(c.text) || (checkReturnTrue && /\breturn\s+true\b/.test(c.text));
      if (!hit) continue;
      if (/allow-swallow:/.test(c.raw)) continue;
      bad.push(`${f}:${lineOf(SOURCE[f], c.open)}`);
    }
  }
  assert.deepEqual(bad, [], `catch turns failure into success without // allow-swallow: <reason> — ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------
// No leftovers.
// ---------------------------------------------------------------------------
const CONSOLE_ALLOWED = new Set(['runtime/cli.mjs', 'runtime/patch.mjs', 'runtime/server.mjs', 'runtime/boot.mjs']);

test('no TODO/FIXME/XXX/debugger markers in runtime', () => {
  const bad = [];
  for (const f of RUNTIME_FILES) {
    const masked = MASKED[f];
    // Markers are meaningful even inside comments/strings (that is the point), so scan raw source.
    for (const m of SOURCE[f].matchAll(/\b(TODO|FIXME|XXX)\b/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)} (${m[1]})`);
    for (const m of masked.matchAll(/\bdebugger\b/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)} (debugger)`);
  }
  assert.deepEqual(bad, [], bad.join(', '));
});

test('no console.log/error in runtime outside the documented startup lines', () => {
  const bad = [];
  for (const f of RUNTIME_FILES) {
    if (CONSOLE_ALLOWED.has(f)) continue;
    for (const m of MASKED[f].matchAll(/\bconsole\.(log|error|warn|info|debug)\b/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)}`);
  }
  assert.deepEqual(bad, [], `console.* outside the allow-list: ${bad.join(', ')}`);
});

// The delivery path takes its time from the injected clock (runtime/clock.mjs), and its jitter from a hash:
// a wall-clock read or a random number in these modules would make a backoff schedule, a breaker cooldown or a
// timeout untestable. runtime/clock.mjs is the one place that reads the real clock.
const CLOCKED = ['runtime/connectors/backoff.mjs', 'runtime/connectors/engine.mjs', 'runtime/settle.mjs', 'runtime/outbox.mjs'];
test('the delivery modules never read the wall clock or Math.random: time comes from the clock they are given', () => {
  const bad = [];
  for (const f of CLOCKED) {
    for (const m of MASKED[f].matchAll(/\bDate\.now\b|\bnew Date\(\s*\)|\bMath\.random\b|\bsetTimeout\b|\bsetInterval\b|\bperformance\.now\b/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)} (${m[0]})`);
  }
  assert.deepEqual(bad, [], `wall clock or randomness outside runtime/clock.mjs: ${bad.join(', ')}`);
});

// Round 7's item A: `store.label(entity, store.get(entity, id))` hydrates the
// whole target row (every derived field, however expensive) just to read one
// of them — a list/CSV/dashboard cell calling this per row is quadratic in
// whatever that row's most expensive aggregate costs. `Store#labelOf(entity,
// id)` reads the raw row and derives only the label field, if that is even
// derived at all; every render/CSV/dashboard site must call it instead.
test('no ref-label site re-hydrates the whole target row (store.get + store.label) — use store.labelOf', () => {
  const bad = [];
  for (const f of RUNTIME_FILES) {
    for (const m of MASKED[f].matchAll(/store\.label\([^,]+,\s*store\.get\(/g)) bad.push(`${f}:${lineOf(SOURCE[f], m.index)}`);
  }
  assert.deepEqual(bad, [], `store.get() immediately re-labelled instead of store.labelOf(): ${bad.join(', ')}`);
});

test('no commented-out code (2+ consecutive // lines that parse as JS)', () => {
  const bad = [];
  for (const f of RUNTIME_FILES) {
    const lines = SOURCE[f].split('\n');
    let run = [];
    const flush = (endLine) => {
      if (run.length >= 2) {
        const code = run.map((l) => l.replace(/^\s*\/\//, '')).join('\n');
        try { new Function(code); bad.push(`${f}:${endLine - run.length + 1}-${endLine}`); } catch { /* prose, not code */ }
      }
      run = [];
    };
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line) && !/^\s*\/\/\s*eslint/.test(line)) run.push(line);
      else flush(i);
    });
    flush(lines.length);
  }
  assert.deepEqual(bad, [], `looks like commented-out code: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------
// No dead exports: every export of a runtime module is imported somewhere in
// runtime/, tests/, verify/, plugins/, apps/*/plugins/.
// ---------------------------------------------------------------------------
function namedExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}(?!\s*from)/gm))
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  return [...names];
}

test('no dead exports: every export is imported somewhere', () => {
  const corpusFiles = [
    ...RUNTIME_FILES,
    ...walk('tests'), ...walk('verify'), ...walk('plugins'),
    ...walk('apps', (f) => f.endsWith('.mjs')).filter((f) => f.includes('/plugins/')),
  ];
  const corpus = corpusFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n\n');
  const bad = [];
  for (const f of RUNTIME_FILES) {
    for (const name of namedExports(SOURCE[f])) {
      const usedAsImport = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(corpus)
        || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(corpus);
      const usedAsMember = new RegExp(`\\.${name}\\b`).test(corpus);
      if (!usedAsImport && !usedAsMember) bad.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(bad, [], `exported but never imported: ${bad.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Registry-only extension.
// ---------------------------------------------------------------------------
test('registry-only extension: TOP matches docs/FORMAT.md, every kind has a checker module and a test naming it', async () => {
  const format = fs.readFileSync('docs/FORMAT.md', 'utf8');
  const tableSection = format.slice(format.indexOf('## Top-level nodes'), format.indexOf('## Fields'));
  const docNodes = new Set();
  for (const m of tableSection.matchAll(/^\|\s*((?:`[\w]+`,?\s*)+)\s*\|/gm))
    for (const n of m[1].matchAll(/`(\w+)`/g)) docNodes.add(n[1]);

  const { TOP } = await import(pathToFileURL(path.resolve('runtime/validate.mjs')).href);
  assert.deepEqual([...TOP].sort(), [...docNodes].sort(), 'validate.mjs TOP must equal docs/FORMAT.md\'s «Top-level nodes» table');

  const checkFiles = walk('runtime/check');
  const covered = new Map(); // node -> [files]
  for (const f of checkFiles) {
    const mod = await import(pathToFileURL(path.resolve(f)).href);
    for (const node of mod.NODES || []) {
      if (!covered.has(node)) covered.set(node, []);
      covered.get(node).push(f);
    }
  }
  const missing = TOP.filter((n) => !covered.has(n));
  assert.deepEqual(missing, [], `no checker module declares NODES for: ${missing.join(', ')}`);
  const duplicated = [...covered.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(duplicated, [], `more than one checker module claims: ${duplicated.map(([n]) => n).join(', ')}`);

  const testCorpus = walk('tests').map((f) => fs.readFileSync(f, 'utf8')).join('\n\n');
  const untested = TOP.filter((n) => !new RegExp(`\\b${n}\\b`).test(testCorpus));
  assert.deepEqual(untested, [], `no test names this node kind: ${untested.join(', ')}`);
});

test('registry entries have their documented contract keys — built-ins and every plugin', async () => {
  const CONTRACT = {
    fields: ['sql', 'exprKind', 'def', 'coerce', 'validate', 'format', 'input'],
    blocks: ['summary', 'effects', 'requires', 'run'],
    transports: ['summary', 'validate', 'deliver'],
    functions: ['arity', 'kind', 'run'],
    widgets: ['summary', 'client'],
  };
  const { DEFAULT } = await import(pathToFileURL(path.resolve('runtime/registry.mjs')).href);
  const problems = [];
  const checkTable = (source, table, entries) => {
    for (const [name, entry] of Object.entries(entries || {})) {
      for (const key of CONTRACT[table]) if (!(key in entry)) problems.push(`${source}: ${table}.${name} is missing "${key}"`);
    }
  };
  for (const table of Object.keys(CONTRACT)) checkTable('built-in', table, DEFAULT[table]);

  const pluginFiles = [...walk('plugins'), ...walk('apps').filter((f) => f.includes('/plugins/'))];
  for (const f of pluginFiles) {
    const mod = await import(pathToFileURL(path.resolve(f)).href);
    const decl = mod.default || mod;
    for (const table of Object.keys(CONTRACT)) if (decl[table]) checkTable(f, table, decl[table]);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
