import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const validOperatorToken = (value) => typeof value === 'string' && /^[\x21-\x7E]{24,256}$/.test(value);

function reply(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function read(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('body too large');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected JSON object');
  return data;
}

export function merchantServer(token, routes) {
  if (!validOperatorToken(token)) throw new Error('invalid bridge operator token');
  const expected = Buffer.from('Bearer ' + token);
  return createServer(async (req, res) => {
    const provided = Buffer.from(req.headers.authorization || '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
      return reply(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST' || !Object.hasOwn(routes, req.url))
      return reply(res, 404, { error: 'not found' });
    let body;
    try { body = await read(req); }
    catch { return reply(res, 400, { error: 'invalid request' }); }
    try {
      const [code, data] = await routes[req.url](body);
      return reply(res, code, data);
    } catch { return reply(res, 502, { error: 'provider request failed' }); }
  });
}
