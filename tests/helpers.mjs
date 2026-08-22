import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '../runtime/server.mjs';

export async function boot(graphFile = 'tests/fixtures/kitchen.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-srv-'));
  const traceFile = path.join(dir, 'trace.jsonl');
  const app = serve({ graphFile, dbFile: path.join(dir, 'data.sqlite'), traceFile, port: 0 });
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (p) => { const r = await fetch(base + p, { redirect: 'manual' }); return { status: r.status, location: r.headers.get('location') || '', html: await r.text() }; };
  const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString() });
    return { status: r.status, location: r.headers.get('location') || '', html: await r.text() };
  };
  const follow = async (p, body) => { const r = await post(p, body); return get(r.location || p); };
  const trace = () => fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // fetch keeps connections alive; without dropping them close() never resolves.
  const close = () => { app.server.closeAllConnections(); app.server.close(); };
  return { app, base, get, post, follow, trace, dir, close };
}

export const rows = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
export const flash = (html) => (/<p class="flash">([\s\S]*?)<\/p>/.exec(html) || [, ''])[1].trim();
