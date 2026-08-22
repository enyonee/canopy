import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyPatch } from '../runtime/patch.mjs';

const graph = () => ({ app: 'x', data: { Task: { title: 'text!' } },
  override: { 'Task.list': { columns: ['title'], filters: [{ field: 'title', options: [] }] } } });

test('add, replace and remove reach any node by its path', () => {
  const g = applyPatch(graph(), [
    { op: 'add', path: '/data/Task/priority', value: 'enum[low,high]=low' },
    { op: 'add', path: '/override/Task.list/columns/-', value: 'priority' },
    { op: 'replace', path: '/app', value: 'renamed' },
  ]);
  assert.equal(g.data.Task.priority, 'enum[low,high]=low');
  assert.deepEqual(g.override['Task.list'].columns, ['title', 'priority']);
  assert.equal(g.app, 'renamed');
  const back = applyPatch(g, [
    { op: 'remove', path: '/data/Task/priority' },
    { op: 'remove', path: '/override/Task.list/columns/1' },
  ]);
  assert.equal(back.data.Task.priority, undefined);
  assert.deepEqual(back.override['Task.list'].columns, ['title']);
});

test('array positions insert and replace, escaped segments resolve', () => {
  const g = applyPatch(graph(), [{ op: 'add', path: '/override/Task.list/columns/0', value: 'first' }]);
  assert.deepEqual(g.override['Task.list'].columns, ['first', 'title']);
  const r = applyPatch(g, [{ op: 'replace', path: '/override/Task.list/columns/0', value: 'other' }]);
  assert.deepEqual(r.override['Task.list'].columns, ['other', 'title']);
  const esc = applyPatch({ a: { 'b/c': 1, 'd~e': 2 } }, [
    { op: 'replace', path: '/a/b~1c', value: 9 }, { op: 'replace', path: '/a/d~0e', value: 8 }]);
  assert.deepEqual(esc.a, { 'b/c': 9, 'd~e': 8 });
});

test('a patch into nowhere names the missing segment', () => {
  assert.throws(() => applyPatch(graph(), [{ op: 'add', path: '/ghost/deep/x', value: 1 }]),
    /path \/ghost\/deep\/x: "ghost" does not exist/);
});

test('the CLI refuses a patch that would break the graph, and keeps the file intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-p-'));
  const gf = path.join(dir, 'app.json');
  const pf = path.join(dir, 'p.json');
  const original = JSON.stringify(graph());
  fs.writeFileSync(gf, original);
  fs.writeFileSync(pf, JSON.stringify([{ op: 'add', path: '/override/Task.list/columns/-', value: 'ghost' }]));
  assert.throws(() => execFileSync('node', ['runtime/patch.mjs', gf, pf], { stdio: 'pipe' }), (e) => {
    assert.match(String(e.stderr), /patch rejected/);
    assert.match(String(e.stderr), /field "ghost" does not exist on Task/);
    return true;
  });
  assert.equal(fs.readFileSync(gf, 'utf8'), original, 'a rejected patch must not touch the file');

  fs.writeFileSync(pf, JSON.stringify([{ op: 'add', path: '/data/Task/note', value: 'text' }]));
  const out = execFileSync('node', ['runtime/patch.mjs', gf, pf], { encoding: 'utf8' });
  assert.match(out, /patch applied/);
  assert.equal(JSON.parse(fs.readFileSync(gf, 'utf8')).data.Task.note, 'text');
});
