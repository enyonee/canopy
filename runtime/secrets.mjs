// The secret store: one encrypted file, `secrets.enc`, beside the database. The whole blob is
// encrypted (AES-256-GCM), so even the names are hidden; the key comes from HKDF over a master key
// that is `CANOPY_MASTER_KEY` (base64, 32 bytes) or else the file `secrets.key` (0600, made by the
// first `set`). Fail closed: a wrong key, a changed byte or an unknown format throws — nothing is
// ever guessed or skipped. A name may have a `.prev` twin (the value before a rotation); `get`
// returns both, newest first. No dependencies: node:crypto and node:fs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[A-Za-z_][\w-]*(\.prev)?$/;
const INFO = 'canopy-secrets-v1';
const b64 = (buf) => buf.toString('base64');

function masterKey(dir, env, create) {
  const fromEnv = env.CANOPY_MASTER_KEY;
  const file = path.join(dir, 'secrets.key');
  let text = fromEnv;
  if (text === undefined && fs.existsSync(file)) text = fs.readFileSync(file, 'utf8').trim();
  if (text === undefined) {
    if (!create) throw new Error('secrets.enc exists but there is no master key: set CANOPY_MASTER_KEY or restore secrets.key');
    text = b64(crypto.randomBytes(32));
    fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('the master key must be 32 bytes, base64 (CANOPY_MASTER_KEY or secrets.key)');
  return key;
}

const derive = (master, salt) => Buffer.from(crypto.hkdfSync('sha256', master, salt, INFO, 32));
const aad = (app) => Buffer.from(`${app}|1`);

function seal(master, app, plain) {
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derive(master, salt), nonce);
  cipher.setAAD(aad(app));
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, alg: 'aes-256-gcm', salt: b64(salt), nonce: b64(nonce), tag: b64(cipher.getAuthTag()), ct: b64(ct) });
}

const broken = (why) => new Error(`secrets.enc cannot be read: ${why}`);

function unseal(master, app, text) {
  let blob;
  try { blob = JSON.parse(text); } catch { throw broken('it is not a secret store'); }
  if (!blob || blob.v !== 1 || blob.alg !== 'aes-256-gcm') throw broken('unknown format');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', derive(master, Buffer.from(blob.salt, 'base64')), Buffer.from(blob.nonce, 'base64'));
    decipher.setAAD(aad(app));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw broken('the master key is wrong or the file was changed'); }
}

/**
 * The store of the directory `dir` (where the database is). `app` is bound into the ciphertext, so a file
 * copied to another app does not open. Nothing is read until it is asked.
 * @param {{ dir: string, app?: string, env?: Record<string, string | undefined> }} opts
 */
export function openSecrets({ dir, app = '', env = process.env }) {
  const file = path.join(dir, 'secrets.enc');
  const load = () => (fs.existsSync(file) ? unseal(masterKey(dir, env, false), app, fs.readFileSync(file, 'utf8')).values : {});
  const save = (values) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, seal(masterKey(dir, env, true), app, { values }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const valid = (name) => { if (!NAME.test(name)) throw new Error(`"${name}" cannot be a secret name (letters, digits, "_" and "-", and an optional ".prev")`); };
  return {
    /** The values of a name, newest first: the name itself, then `name.prev` (during a rotation). */
    get: (name) => { const v = load(); return [v[name], v[`${name}.prev`]].filter((x) => x !== undefined); },
    /** The value of a name alone, without its `.prev`: what a request is signed with. */
    current: (name) => load()[name],
    /** Every value held, for masking. */
    values: () => Object.values(load()),
    names: () => Object.keys(load()).sort(),
    set: (name, value) => { valid(name); if (value === '') throw new Error('a secret cannot be empty'); save({ ...load(), [name]: value }); },
    remove: (name) => { const v = load(); if (!(name in v)) return false; delete v[name]; save(v); return true; },
  };
}
