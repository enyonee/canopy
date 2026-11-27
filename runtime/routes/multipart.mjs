import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { Busboy } from '@fastify/busboy';

export class TooBig extends Error {}

const MiB = 1024 * 1024;
const LIMITS = { files: 32, fields: 128, parts: 160, fieldSize: MiB };
const MAX_UPLOAD = Number(process.env.AG_MAX_UPLOAD || 8 * MiB);

function createParser(req, maxFile) {
  try {
    return new Busboy({ headers: { ...req.headers, 'content-type': req.headers['content-type'] }, limits: { ...LIMITS, fileSize: maxFile } });
  } catch {
    req.resume();
    throw new Error('Invalid multipart form');
  }
}

// Write at most one stream per file, without collecting its contents in memory.
async function save(file, filename, dir, files, signal) {
  await mkdir(dir, { recursive: true });
  const id = String(randomInt(10 ** 13)).padStart(13, '0');
  const name = `${id}-${filename.replace(/[^\w.-]/g, '_')}`;
  const target = path.join(dir, name);
  const writer = createWriteStream(target, { flags: 'wx' });
  writer.once('open', () => files.add(target));
  await pipeline(file, writer, { signal });
  if (file.bytesRead) return name;
  await rm(target);
  return '';
}

function meter(maxBody) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > maxBody) done(new TooBig('Multipart form is too large'));
    else done(null, chunk);
  } });
}

/** @param {import('node:http').IncomingMessage} req @param {string} dir @param {Map<string,string>} uploads */
export async function parseMultipart(req, dir, uploads, maxFile = MAX_UPLOAD) {
  const maxBody = 4 * maxFile + MiB;
  if (Number(req.headers['content-length']) > maxBody) {
    req.resume();
    throw new TooBig('Multipart form is too large');
  }
  const parser = createParser(req, maxFile);
  const body = meter(maxBody);
  const abort = new AbortController();
  const files = new Set();
  const parts = [], writes = [];
  const stop = (error) => { abort.abort(error); parser.destroy(error); };
  const malformed = () => new Error('Invalid multipart form');
  req.once('error', stop);
  body.once('error', stop);
  parser.on('error', () => abort.abort(malformed()));
  for (const limit of ['partsLimit', 'filesLimit', 'fieldsLimit']) parser.on(limit, () => stop(new TooBig('Too many multipart parts')));
  parser.on('field', (key, value, _nameTruncated, truncated) => {
    if (truncated) stop(new TooBig('Multipart field is too large'));
    else parts.push({ key, value, file: false });
  });
  parser.on('file', (key, file, filename) => {
    const part = { key, value: '', file: true };
    parts.push(part);
    const name = filename || 'file';
    file.on('error', () => stop(malformed()));
    file.on('limit', () => stop(new TooBig(`${name} is larger than ${Math.round(maxFile / MiB)} MB`)));
    writes.push(save(file, name, dir, files, abort.signal).then((value) => { part.value = value; }, stop));
  });
  const parsed = finished(parser, { cleanup: true });
  req.pipe(body).pipe(parser);
  try {
    await parsed;
    await Promise.all(writes);
    abort.signal.throwIfAborted();
    const result = Object.fromEntries(parts.map(({ key, value }) => [key, value]));
    for (const { key, value, file } of parts) {
      if (file && value) uploads.set(key, value);
      else uploads.delete(key);
    }
    return result;
  } catch (e) {
    abort.abort(e);
    await Promise.all(writes);
    await Promise.all([...files].map((target) => rm(target, { force: true })));
    throw abort.signal.reason ?? e;
  } finally {
    req.unpipe(body);
    body.destroy();
    req.resume();
    req.off('error', stop);
  }
}
