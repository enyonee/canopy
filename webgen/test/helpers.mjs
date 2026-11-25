import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.join(import.meta.dirname, '..', '..');
export const shopGraph = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/shop/app.json'), 'utf8'));
// The contract snapshot generation reads (apps/shop/web/openapi.json, taken from the runtime with --openapi --out).
export const shopOpenapi = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/shop/web/openapi.json'), 'utf8'));
