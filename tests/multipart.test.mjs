import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseMultipart, TooBig } from '../runtime/routes/multipart.mjs';
import { boot, tmpDir, tmpGraph } from './helpers.mjs';

const boundary = 'CanopyBoundary123';
const headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
const field = (key, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
const upload = (key, filename, content) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`;
const end = `--${boundary}--\r\n`;
const request = (chunks, more = {}) => Object.assign(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), { headers: { ...headers, ...more } });

test('multipart streams exact-limit files, preserves order and empty uploads', async (t) => {
  const dir = tmpDir('ag-multipart-', t), uploads = new Map();
  const data = await parseMultipart(request([
    field('name', 'first'), upload('doc', 'x.txt', 'abcd'), upload('empty', 'empty.txt', ''),
    field('name', 'last'), end,
  ]), dir, uploads, 4);
  assert.equal(data.name, 'last');
  assert.equal(data.empty, '');
  assert.deepEqual([...uploads], [['doc', data.doc]]);
  assert.deepEqual(await fs.readdir(dir), [data.doc]);
  assert.equal(await fs.readFile(path.join(dir, data.doc), 'utf8'), 'abcd');
});

test('multipart refuses truncated, over-size and over-count forms without leaving uploaded files', async (t) => {
  const dir = tmpDir('ag-multipart-', t);
  const cases = [
    [request([upload('doc', 'first.txt', 'ok'), upload('another', 'over.txt', '123456'), end]), TooBig],
    [request([upload('doc', 'first.txt', 'ok'), upload('bad', 'cut.txt', 'x')]), /Invalid multipart form/],
    [request([field('f', 'x'.repeat(1024 * 1024 + 1)), end]), TooBig],
    [request([field('f', 'x'.repeat(1024 * 1024)), end]), TooBig],
    [request([field('f', 'x').repeat(129), end]), TooBig],
    [request([], { 'content-length': String(2 * 1024 * 1024) }), TooBig],
  ];
  for (const [req, ErrorType] of cases) {
    const uploads = new Map();
    await assert.rejects(parseMultipart(req, dir, uploads, 4), ErrorType);
    assert.deepEqual([...uploads], []);
    assert.deepEqual(await fs.readdir(dir), []);
  }
});

test('multipart without a boundary retains the existing error response', async () => {
  const s = await boot(tmpGraph({ app: 'upload', data: { Doc: { name: 'text' } } }));
  try {
    const reply = await fetch(s.base + '/Doc', { method: 'POST', headers: { 'content-type': 'multipart/form-data' }, body: 'bad' });
    assert.equal(reply.status, 500);
  } finally { s.close(); }
});
