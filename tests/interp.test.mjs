// The step interpreter (runtime/interp.mjs), isolated from HTTP: validateValues's
// fail-closed behaviour on a rule that throws — the checker makes this
// unreachable for a graph built only from built-ins, so a plugin function that
// throws for one input is the only way to reach it.
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
