import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, search } from '../runtime/blocks.mjs';
import { Store } from '../runtime/store.mjs';

const graph = { app: 't', data: {
  Task: { title: 'text!', done: 'bool=false' },
  Log: { note: 'text!', task: 'ref:Task' },
  Question: { text: 'text!', answer: 'text!' },
  Answer: { question: 'ref:Question!', choice: 'text!', correct: 'bool=false' },
} };
const fresh = () => new Store(graph, ':memory:');

test('every block declares a summary, effects and requirements', () => {
  for (const [name, b] of Object.entries(CATALOG)) {
    assert.ok(b.summary.length > 10, `${name} has no usable summary`);
    assert.ok(Array.isArray(b.effects), `${name} does not declare effects`);
    assert.equal(typeof b.run, 'function');
  }
});

test('db.create, db.update, db.delete, db.toggle', () => {
  const store = fresh();
  const { id } = CATALOG['db.create'].run({ store, entity: 'Task', values: { title: 'a' } });
  assert.equal(store.get('Task', id).title, 'a');
  CATALOG['db.update'].run({ store, entity: 'Task', id, step: { set: { title: 'b' } } });
  assert.equal(store.get('Task', id).title, 'b');
  CATALOG['db.toggle'].run({ store, entity: 'Task', id, step: { field: 'done' } });
  assert.equal(store.get('Task', id).done, 1, 'toggle must flip 0 to 1');
  CATALOG['db.toggle'].run({ store, entity: 'Task', id, step: { field: 'done' } });
  assert.equal(store.get('Task', id).done, 0, 'toggle must flip back');
  CATALOG['db.delete'].run({ store, entity: 'Task', id });
  assert.equal(store.get('Task', id), undefined);
});

test('db.createRow writes into another entity and resolves references', () => {
  const store = fresh();
  const task = store.insert('Task', { title: 'parent' });
  const out = CATALOG['db.createRow'].run({
    store, step: { entity: 'Log', values: { note: 'x', task: '@row.id' } },
    resolve: (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '@row.id' ? task : v])),
  });
  assert.equal(store.get('Log', out.id).task, String(task));
});

test('random.pick honours weights and refuses an empty table', () => {
  const store = fresh();
  assert.throws(() => CATALOG['random.pick'].run({ store, step: { from: 'Task' } }), /Task is empty/);
  store.insert('Task', { title: 'never' });
  store.insert('Task', { title: 'always' });
  store.db.exec(`UPDATE task SET done = CASE title WHEN 'always' THEN 1 ELSE 0 END`);
  const picks = new Set();
  for (let i = 0; i < 40; i++) picks.add(CATALOG['random.pick'].run({ store, step: { from: 'Task', weight: 'done' } }).picked.title);
  assert.deepEqual([...picks], ['always'], 'a zero weight must never be picked');
  const any = new Set();
  for (let i = 0; i < 60; i++) any.add(CATALOG['random.pick'].run({ store, step: { from: 'Task' } }).picked.title);
  assert.equal(any.size, 2, 'without weights both rows must be reachable');
});

test('check.matchRef grades against the referenced row, case and space insensitive', () => {
  const store = fresh();
  const q = store.insert('Question', { text: 'capital?', answer: 'Paris' });
  const right = store.insert('Answer', { question: q, choice: ' paris ' });
  const wrong = store.insert('Answer', { question: q, choice: 'Rome' });
  const step = { ref: 'question', field: 'choice', against: 'answer', into: 'correct' };
  assert.equal(CATALOG['check.matchRef'].run({ store, entity: 'Answer', id: right, step }).matched, 1);
  assert.equal(store.get('Answer', right).correct, 1);
  assert.equal(CATALOG['check.matchRef'].run({ store, entity: 'Answer', id: wrong, step }).matched, 0);
  assert.equal(store.get('Answer', wrong).correct, 0);
});

test('catalog search finds blocks by name and by summary', () => {
  assert.ok(search('toggle').some((l) => l.startsWith('db.toggle')));
  assert.ok(search('random').length >= 1);
  assert.ok(search('flip a boolean').some((l) => l.startsWith('db.toggle')), 'search must look at summaries too');
  assert.deepEqual(search('nothing-like-this'), []);
});
