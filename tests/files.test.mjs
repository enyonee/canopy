// FILES: the safety of stored files — a form's upload field takes only the file that request uploaded (a text value naming
// another row's stored file is dropped), the file route shows inline only a raster image by its bytes and never an SVG,
// always with nosniff, and a seeded file stays inside the app directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, tmpGraph, tmpDir } from './helpers.mjs';
import { FIELDS } from '../runtime/fields.mjs';
import { validate } from '../runtime/validate.mjs';
import { DEFAULT } from '../runtime/registry.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

const graph = (seed = { Product: [{ name: 'Mug', photo: { from: 'seed/mug.png' } }] }) => ({
  app: 'files',
  data: {
    User: { email: 'text!', password: 'password!', role: 'enum[admin,member]=member' },
    Product: { name: 'text!', photo: 'image', manual: 'file' },
  },
  roles: { entity: 'User', login: 'email', password: 'password', role: 'role', register: 'member', anonymous: 'guest',
    can: { admin: '*', member: { Product: ['view', 'create', 'edit'] }, guest: { Product: ['view'] } } },
  seed: { User: [{ email: 'root@files', password: 'root', role: 'admin' }], ...seed },
});

// A graph file with its seed files beside it: `files` maps a path below the app directory to its bytes.
const appWith = (g, files = { 'seed/mug.png': PNG }) => {
  const file = tmpGraph(g);
  for (const [p, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(path.dirname(file), p)), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), p), bytes);
  }
  return file;
};

let s;
const created = async (name) => (await s.app.store.list('Product', { where: { name } }))[0];
before(async () => {
  s = await boot(appWith(graph()));
  await s.login('root@files', 'root');
});
after(() => s.close());

test('FILES: sniff names a raster image by its first bytes, never by its name, and never an SVG', () => {
  const sniff = FIELDS.image.sniff;
  assert.deepEqual([PNG, JPEG, GIF, WEBP].map(sniff), ['png', 'jpeg', 'gif', 'webp']);
  assert.equal(FIELDS.file.sniff, sniff);
  assert.equal(sniff(SVG), null, 'an SVG is text');
  assert.equal(sniff(Buffer.from('RIFF\x04\x00\x00\x00WAVEfmt ', 'latin1')), null, 'a RIFF that is not WebP');
  assert.equal(sniff(PNG.subarray(0, 7)), null, 'a cut PNG signature');
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('FILES: a text value naming a stored file is dropped, urlencoded or as a text part; a real upload is kept', async () => {
  const theirs = (await s.app.store.get('Product', 1)).photo;
  assert.equal((await s.post('/Product', { name: 'Thief1', photo: theirs })).status, 303);
  assert.equal((await s.upload('/Product', { name: 'Thief2', photo: theirs })).status, 303);
  assert.equal((await s.upload('/Product', { name: 'Thief3', photo: theirs }, { field: 'manual', name: 'm.txt', content: 'x' })).status, 303);
  for (const name of ['Thief1', 'Thief2', 'Thief3']) assert.equal((await created(name)).photo, null, name);
  assert.match((await created('Thief3')).manual, /-m\.txt$/, 'the file the request did upload is stored');
  const own = await created('Thief3');
  assert.equal((await s.post(`/Product/${own.id}`, { name: 'Thief3', photo: theirs })).status, 303);
  assert.equal((await s.app.store.get('Product', own.id)).photo, null, 'nor on an edit');
  const json = await s.post('/Product', { name: 'Thief4', photo: theirs }, { accept: 'application/json' });
  assert.equal(json.status, 200);
  assert.equal((await created('Thief4')).photo, null, 'the form path answering JSON is the form path');
});

test('FILES: inline is only a raster image by its bytes, a PDF, text or CSV; every file answer says nosniff', async () => {
  const at = async (name, field, file) => {
    assert.equal((await s.upload('/Product', { name }, { field, ...file })).status, 303);
    return `${s.base}/file/Product/${(await created(name)).id}/${field}`;
  };
  const mislabeled = await at('Cup', 'photo', { name: 'cup.jpg', content: PNG });
  const img = await fetch(`${mislabeled}?inline=1`);
  assert.equal(img.headers.get('content-type'), 'image/png', 'the type is the bytes\', not the name\'s');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-disposition'), /^inline/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  for (const [name, content, field] of [['x.svg', SVG, 'photo'], ['y.svg', SVG, 'manual'], ['fake.png', 'not a png', 'photo']]) {
    const r = await fetch(`${await at(name, field, { name, content })}?inline=1`);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream', `${name} is never shown inline`);
    assert.match(r.headers.get('content-disposition'), /^attachment/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    await r.arrayBuffer();
  }
  const doc = await fetch(`${await at('Doc', 'manual', { name: 'm.txt', content: 'read me' })}?inline=1`);
  assert.equal(doc.headers.get('content-type'), 'text/plain', 'a known document type is shown by its extension');
  assert.equal(await doc.text(), 'read me');
  const download = await fetch(mislabeled);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream', 'without ?inline=1 a download');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  await download.arrayBuffer();
});

test('FILES: a seeded file is copied in and served as the image its bytes are', async () => {
  assert.match((await s.app.store.get('Product', 1)).photo, /-mug\.png$/);
  const r = await fetch(`${s.base}/file/Product/1/photo?inline=1`);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
});

test('FILES: a seeded file must stay inside the app directory', async (t) => {
  const seeded = (from) => graph({ Product: [{ name: 'P', photo: { from } }] });
  for (const from of ['../mug.png', 'seed/../../mug.png', '/etc/passwd', 'C:/x.png', 'seed\\mug.png']) {
    const errors = validate(seeded(from), DEFAULT);
    assert.ok(errors.some((e) => e.path === '/seed/Product/0/photo/from' && /leaves the app directory/.test(e.message)), from);
  }
  assert.deepEqual(validate(seeded('seed/mug.png'), DEFAULT), []);
  const outside = tmpDir('ag-out-', t);
  fs.writeFileSync(path.join(outside, 'x.png'), PNG);
  const cases = [
    [{}, 'seed/gone.png', /seed Product\[0\] "photo": no file seed\/gone\.png in the app directory/],
    [{ 'seed/dir/x': 'x' }, 'seed/dir', /seed Product\[0\] "photo": seed\/dir is not a file inside the app directory/],
    ['link', 'seed/link.png', /seed\/link\.png is not a file inside the app directory/],
  ];
  for (const [files, from, message] of cases) {
    const file = appWith(seeded(from), files === 'link' ? {} : files);
    if (files === 'link') { fs.mkdirSync(path.join(path.dirname(file), 'seed')); fs.symlinkSync(path.join(outside, 'x.png'), path.join(path.dirname(file), 'seed/link.png')); }
    const app = await boot(file);
    try {
      assert.equal(app.app.invalid, true, from);
      assert.match((await app.get('/')).html.replaceAll('&quot;', '"'), message);
    } finally { app.close(); }
  }
});
