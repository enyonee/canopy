// The step interpreter (runtime/interp.mjs) and the store's own write guard
// (Store#checkRules, runtime/store/rules.mjs) it now delegates to:
// validateValues's fail-closed behaviour on a rule that throws — the checker
// makes this unreachable for a graph built only from built-ins, so a plugin
// function that throws for one input is the only way to reach it — plus
// round 6's guard covering every write, not only an HTTP form: a block
// (built-in or a plugin's own store.insert/update), and a seed row at boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { boot, tmpGraph } from './helpers.mjs';

const throwing = path.resolve('tests/fixtures/throwing.mjs');
const graph = {
  app: 'thr', plugins: [throwing],
  data: { Item: { qty: 'int!' } },
  rules: { Item: [{ check: 'boom(qty)', message: 'qty must be positive' }] },
};

test('a rule whose expression throws refuses the write, not lets it through', async () => {
  const s = await boot(tmpGraph(graph));
  try {
    const bad = await s.post('/Item', { qty: '13' });
    assert.equal(bad.status, 400, 'the throwing rule refuses the write instead of passing it');
    assert.match(bad.html, /qty must be positive/, 'the declared rule message is shown, not the raw error');
    assert.equal((await s.trace()).some((e) => e.kind === 'error' && /unlucky/.test(e.message)), true, 'the underlying error is traced');
    const ok = await s.post('/Item', { qty: '5' });
    assert.equal(ok.status, 303, 'the same rule passes normally when the expression does not throw');
  } finally { s.close(); }
});

// --- round 6: rules reach every write, not only an HTTP form -------------

const rawwrite = path.resolve('tests/fixtures/rawwrite.mjs');
const uniqueGraph = {
  app: 'rawg', plugins: [rawwrite],
  data: { Item: { tag: 'text!' } },
  rules: { Item: [{ unique: 'tag', message: 'tag must be unique' }] },
  actions: [{ name: 'make', do: [{ block: 'raw.insert', entity: 'Item', values: { tag: 'x' } }] }],
};

test('a plugin block that writes straight through store.insert cannot skip the guard', async () => {
  const s = await boot(tmpGraph(uniqueGraph));
  try {
    const first = await s.post('/action/make', {});
    assert.equal(first.status, 303, 'the first insert is fine — nothing else has this tag yet');
    const dup = await s.post('/action/make', {});
    assert.equal(dup.status, 400, 'a plugin block has no path around Store#insert\'s own guard');
    assert.match(dup.html, /tag must be unique/, 'the declared rule message is shown');
    const list = await s.get('/Item');
    assert.equal((list.html.match(/<td>x<\/td>/g) || []).length, 1, 'the duplicate row was never committed');
  } finally { s.close(); }
});

const updateGraph = {
  app: 'upd',
  data: { Item: { qty: 'int!' } },
  rules: { Item: [{ check: 'qty >= 0', message: 'qty must not go negative' }] },
  seed: { Item: [{ qty: 5 }] },
  actions: [{ name: 'break', in: 'Item', do: [{ block: 'db.update', set: { qty: -1 } }] }],
};

test('a built-in block (db.update) writing a rule-violating value is refused, not just an HTTP form edit', async () => {
  const s = await boot(tmpGraph(updateGraph));
  try {
    const broken = await s.post('/Item/1/action/break', {});
    assert.equal(broken.status, 400, 'db.update has no path around Store#update\'s own guard');
    assert.match(broken.html, /qty must not go negative/, 'the declared rule message is shown');
    const row = await s.get('/Item/1');
    assert.match(row.html, />5</, 'the refused write never touched the stored row');
  } finally { s.close(); }
});

const seedGraph = {
  app: 'seedbad',
  data: { Item: { tag: 'text!' } },
  rules: { Item: [{ unique: 'tag', message: 'tag must be unique' }] },
  seed: { Item: [{ tag: 'x' }, { tag: 'x' }] },
};

test('a seed row that violates a rule is a boot error naming the entity, row and rule — not a crash', async () => {
  const s = await boot(tmpGraph(seedGraph));
  try {
    assert.equal(s.app.invalid, true, 'a boot-time rule violation is served as an error, like a statically invalid graph');
    const r = await s.get('/anything');
    assert.equal(r.status, 500);
    assert.match(r.html, /seed Item\[1\]/, 'the boot error names the entity and the row');
    assert.match(r.html, /tag must be unique/, 'the boot error names the rule that failed');
  } finally { s.close(); }
});
