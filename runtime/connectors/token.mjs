// A descriptor can declare a fixed token endpoint; the access token never enters the graph or the outbox.
const fixedHttps = (s) => typeof s === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\/[a-zA-Z0-9/_-]*)?$/.test(s);
const slot = (s) => typeof s === 'string' && /^[A-Za-z_][\w-]*$/.test(s);
const keys = ['url', 'scheme', 'clientId', 'clientSecret', 'apiKey', 'grantType'];
export const validTokenScope = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]+( [A-Za-z0-9_-]+)*$/.test(s) && s.length <= 160;

export function checkToken(t, base) {
  if (t === null || typeof t !== 'object' || Array.isArray(t)) return [['/token', 'token is an object']];
  const out = Object.keys(t).filter((k) => !keys.includes(k)).map((k) => [`/token/${k}`, 'unknown token key']);
  if (!fixedHttps(t.url)) out.push(['/token/url', 'token needs a fixed HTTPS endpoint']);
  if (!fixedHttps(base)) out.push(['/base', 'a token connector needs a fixed HTTPS base']);
  if (t.scheme !== 'basic' && t.scheme !== 'form') out.push(['/token/scheme', 'token credentials use basic or form']);
  if (t.grantType !== undefined && !(t.scheme === 'form' && t.grantType === 'client_credentials'))
    out.push(['/token/grantType', 'form tokens optionally send grantType: client_credentials']);
  for (const k of ['clientId', 'clientSecret', ...(t.apiKey === undefined ? [] : ['apiKey'])]) {
    if (!slot(t[k])) out.push([`/token/${k}`, 'token credentials name a secret slot']);
  }
  return out;
}

export function tokenRequest(t, secret, timeout, scope = undefined) {
  const clientId = secret(t.clientId), clientSecret = secret(t.clientSecret);
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const form = new URLSearchParams();
  if (t.scheme === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    form.set('grant_type', 'client_credentials');
  } else {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
    if (t.grantType) form.set('grant_type', t.grantType);
  }
  if (scope !== undefined) form.set('scope', scope);
  if (t.apiKey !== undefined) headers.apikey = secret(t.apiKey);
  return { method: 'POST', url: t.url, headers, body: form.toString(), timeout, redirect: 'manual' };
}

export async function accessToken(res) {
  if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status}`);
  let token;
  try { token = (await res.json())?.access_token; } catch (e) { throw new Error('token endpoint did not return JSON', { cause: e }); }
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,8192}$/.test(token)) throw new Error('token endpoint returned no usable access token');
  return token;
}
