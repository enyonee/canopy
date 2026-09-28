// Opens the storage driver a Store talks to: a path becomes the SQLite driver, an
// object that already has the Driver shape (see runtime/types.d.ts) is used as is.
import { openSqlite } from './driver/sqlite.mjs';

/** @param {string | import('./types.d.ts').Driver} fileOrDriver */
export function open(fileOrDriver) {
  return typeof fileOrDriver === 'string' ? openSqlite(fileOrDriver) : fileOrDriver;
}
