#!/usr/bin/env node
// The mutation gate. Coverage says the line ran; this says the tests would have
// noticed if the line were wrong. A mutation that survives is a hole in the suite.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const MUTATIONS = [
  // The four defects the apps actually found — the suite must catch each of them again.
  { name: 'bool coercion forgets numeric 1 (defect found by todo)', file: 'runtime/spec.mjs',
    find: "raw === true || raw === 1 ||", replace: "raw === true ||" },
  { name: 'a new column is not backfilled with its default (defect found by todo)', file: 'runtime/store.mjs',
    find: 'const n = this.db.prepare(\n            `UPDATE "${table}" SET "${f.name}"=? WHERE "${f.name}" IS NULL`).run(seed).changes;',
    replace: 'const n = 0;' },
  { name: 'an unchecked box on create falls back to the declared default (defect found by drivers)',
    file: 'runtime/server.mjs',
    find: "          for (const f of fields) if (f.kind === 'bool' && submitted[f.name] === undefined) submitted[f.name] = 'false';\n          const values",
    replace: "          const values" },
  { name: 'a boolean ignores its declared labels (regression found by todo)', file: 'runtime/render.mjs',
    find: "    const pair = labels[c] || ['No', 'Yes'];", replace: "    const pair = ['No', 'Yes'];" },

  // Storage
  { name: 'list ignores the declared filters', file: 'runtime/store.mjs',
    find: '      clauses.push(`"${field}"=?`);\n      vals.push(coerce(this.field(entity, field), cmp));',
    replace: '      void field; void cmp;' },
  { name: 'search matches everything', file: 'runtime/store.mjs',
    find: "      clauses.push('(' + search.map((f) => `LOWER(\"${f}\") LIKE ?`).join(' OR ') + ')');",
    replace: "      clauses.push('(1=1)');" },
  { name: 'sort direction is inverted', file: 'runtime/store.mjs',
    find: "sort.dir === 'asc' ? 'ASC' : 'DESC'", replace: "sort.dir === 'asc' ? 'DESC' : 'ASC'" },
  { name: 'aggregate ignores the grouping', file: 'runtime/store.mjs',
    find: "    if (groupBy) sql += ` GROUP BY \"${groupBy}\"`;", replace: "    if (false) sql += '';" },
  { name: 'insert ignores declared defaults', file: 'runtime/store.mjs',
    find: "      vals.push(given === undefined || given === '' ? defaultValue(f) : coerce(f, given));",
    replace: "      vals.push(given === undefined || given === '' ? null : coerce(f, given));" },
  { name: 'a removed field is dropped silently', file: 'runtime/store.mjs',
    find: "      if (orphan.length && !this.graph.allowDestructive) {", replace: "      if (false) {" },

  // The checker
  { name: 'unknown blocks are accepted', file: 'runtime/validate.mjs',
    find: "      if (!block) {", replace: "      if (false) {" },
    // (the following lines still run; the point is that the error is never raised)
  { name: 'unknown fields in a view are accepted', file: 'runtime/validate.mjs',
    find: "    if (known(e).includes(f)) return true;", replace: "    if (true) return true;" },
  { name: 'a related section may point anywhere', file: 'runtime/validate.mjs',
    find: "        else if (f.target !== entity) err(`${p}/via`, `\"${rel.via}\" points at ${f.target}, not ${entity}`);",
    replace: "        else if (false) err(`${p}/via`, 'x');" },
  { name: 'block requirements are not enforced', file: 'runtime/validate.mjs',
    find: "        if (step[req] === undefined) err(`${path}/${j}`, `block \"${step.block}\" requires \"${req}\"`, block.summary);",
    replace: "        void req;" },
  { name: 'suggestions are dropped from error hints', file: 'runtime/validate.mjs',
    find: "      n.length ? `did you mean: ${n.join(', ')}? or add it to /data/${e}` : `known fields: ${known(e).join(', ')}`);",
    replace: "      `known fields: ${known(e).join(', ')}`);" },

  // The interpreter
  { name: 'required fields are not enforced on submit', file: 'runtime/server.mjs',
    find: "      if (f.required && (v === undefined || String(v).trim() === '')) problems.push(`${f.name} is required`);",
    replace: "      void v;" },
  { name: 'a number field accepts letters', file: 'runtime/server.mjs',
    find: "      if (f.kind === 'int' && v !== undefined && v !== '' && Number.isNaN(Number(v))) problems.push(`${f.name} must be a number`);",
    replace: "      void 0;" },
  { name: 'an enum accepts values outside its set', file: 'runtime/server.mjs',
    find: "      if (f.kind === 'enum' && v && !f.options.includes(String(v))) problems.push(`${f.name} must be one of: ${f.options.join(', ')}`);",
    replace: "      void 0;" },
  { name: 'events never fire', file: 'runtime/server.mjs',
    find: "      runSteps(ev.do, { entity, id, values });", replace: "      void ev;" },
  { name: 'identity resolves to nothing', file: 'runtime/server.mjs',
    find: "      if (path === 'me') return meId;", replace: "      if (path === 'me') return null;" },
  { name: 'seed rows are inserted on every boot', file: 'runtime/server.mjs',
    find: "    if (store.count(entity)) continue;", replace: "    if (false) continue;" },
  { name: 'the confirmation never reaches the page', file: 'runtime/server.mjs',
    find: "    const ok = (to, msg) => redirect(msg ? `${to}${to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}` : to);",
    replace: "    const ok = (to) => redirect(to);" },
  { name: 'a rejected form is stored anyway', file: 'runtime/server.mjs',
    find: "            return send(400, formView(graph, store, entity, fields, submitted, 'new', problems));",
    replace: "            void problems;" },

  // Blocks
  { name: 'toggle only ever sets, never clears', file: 'runtime/blocks.mjs',
    find: "      store.update(entity, id, { [step.field]: row[step.field] ? 0 : 1 });",
    replace: "      store.update(entity, id, { [step.field]: 1 });" },
  { name: 'grading becomes case sensitive', file: 'runtime/blocks.mjs',
    find: "      const ok = target && String(target[step.against]).trim().toLowerCase()\n        === String(row[step.field]).trim().toLowerCase() ? 1 : 0;",
    replace: "      const ok = target && String(target[step.against]) === String(row[step.field]) ? 1 : 0;" },
  { name: 'weights are ignored when picking', file: 'runtime/blocks.mjs',
    find: "      const weights = rows.map((r) => (step.weight ? Math.max(0, Number(r[step.weight]) || 0) : 1));",
    replace: "      const weights = rows.map(() => 1);" },

  // Rendering and patching
  { name: 'html escaping is disabled', file: 'runtime/render.mjs',
    find: "const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) =>",
    replace: "const esc = (s) => String(s ?? '').replace(/[\\u0000]/g, (c) =>" },
  { name: 'a reference renders as its raw id', file: 'runtime/render.mjs',
    find: "    return `<td>${row ? `<a href=\"/${f.target}/${row.id}\">${esc(store.label(f.target, row))}</a>` : '—'}</td>`;",
    replace: "    return `<td>${esc(v)}</td>`;" },
  { name: 'appending to an array overwrites its first item', file: 'runtime/patch.mjs',
    find: "    else if (last === '-' && Array.isArray(node)) node.push(op.value);",
    replace: "    else if (last === '-' && Array.isArray(node)) node[0] = op.value;" },
];

const run = () => {
  try { execFileSync('node', ['--no-warnings', '--test', 'tests/spec.test.mjs', 'tests/blocks.test.mjs',
    'tests/store.test.mjs', 'tests/validate.test.mjs', 'tests/server.test.mjs', 'tests/patch.test.mjs',
    'tests/cli.test.mjs', 'tests/render.test.mjs', 'tests/props.test.mjs', 'tests/edges.test.mjs'],
    // A mutated runtime can hang a test instead of failing it; a hang is a detection too.
    { stdio: 'pipe', timeout: 60_000, killSignal: 'SIGKILL' }); return true; } catch { return false; }
};

if (!run()) { console.error('the suite is red before any mutation — fix that first'); process.exit(2); }

let killed = 0;
const survivors = [];
for (const m of MUTATIONS) {
  const original = fs.readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    console.log(`? ${m.name}\n    the mutation no longer applies to ${m.file} — update it`);
    survivors.push(m.name);
    continue;
  }
  fs.writeFileSync(m.file, original.replace(m.find, m.replace));
  const green = run();
  fs.writeFileSync(m.file, original);
  if (green) { survivors.push(m.name); console.log(`✗ SURVIVED  ${m.name}`); }
  else { killed++; console.log(`✓ killed    ${m.name}`); }
}

console.log(`\n${killed}/${MUTATIONS.length} мутаций убито`);
if (survivors.length) {
  console.log('\nвыжили (значит, эти утверждения ничем не проверены):');
  for (const s of survivors) console.log(`  • ${s}`);
}
process.exit(survivors.length ? 1 : 0);
