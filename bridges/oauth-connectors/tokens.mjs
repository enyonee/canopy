import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const LIFE = 10 * 60_000;
const MARGIN = 60_000;
const present = (s) => typeof s === 'string' && /^[\x21-\x7e]{1,8192}$/.test(s);
const hash = (value) => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');

function endpoint(value, localhost = false) {
  const url = new URL(value);
  const loopback = localhost && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!(url.protocol === 'https:' || loopback) || url.username || url.password || url.hash || url.search)
    throw new Error('invalid OAuth endpoint');
  return url;
}

function sameState(a, b) {
  return typeof a === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCallback(input, redirect) {
  if (typeof input !== 'string' || input.length > 16384) return null;
  try {
    const url = new URL(input);
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname ||
      url.username || url.password || url.hash || url.searchParams.has('error') ||
      new Set(url.searchParams.keys()).size !== [...url.searchParams].length) return null;
    return Object.fromEntries(url.searchParams);
  } catch { return null; }
}

function tokenPayload(data, previous, now, mode, meta) {
  const accessToken = data?.access_token;
  const refreshToken = data?.refresh_token ?? previous?.refreshToken;
  const seconds = data?.expires_in;
  if (!present(accessToken) || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31_536_000 ||
    (mode === 'consent' && !present(refreshToken))) throw new Error('invalid OAuth token response');
  return { accessToken, ...(refreshToken && { refreshToken }), expiresAt: now + seconds * 1000, ...(meta && { meta }) };
}

export function tokenBroker(secrets, provider, fetchImpl = fetch, now = Date.now) {
  const { name, clientId, clientSecret, mode, pkce, scopes = [], separator = ' ' } = provider;
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name) || !present(clientId) || !present(clientSecret) ||
    !['consent', 'client_credentials'].includes(mode)) throw new Error('invalid OAuth provider');
  const tokenUrl = endpoint(provider.tokenUrl).href;
  const authorize = mode === 'consent' ? endpoint(provider.authorizeUrl) : null;
  const redirect = authorize ? endpoint(provider.redirectUri, true) : null;
  const key = 'oauth_' + name;
  const binding = hash(JSON.stringify([mode, tokenUrl, clientId, scopes, authorize?.href, redirect?.href, provider.account]));
  let pending;
  let exchange;

  function load() {
    const raw = secrets.current(key);
    if (raw === undefined) return null;
    const saved = JSON.parse(raw);
    return saved.binding === binding ? saved.grant : null;
  }

  async function request(params, previous, meta) {
    const { encoding = 'form', authentication = 'body' } = provider;
    const headers = { accept: 'application/json', 'content-type': encoding === 'form' ?
      'application/x-www-form-urlencoded' : 'application/json' };
    if (authentication === 'basic') headers.authorization = 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64');
    else Object.assign(params, { client_id: clientId, client_secret: clientSecret });
    const body = encoding === 'form' ? new URLSearchParams(params).toString() : JSON.stringify(params);
    const r = await fetchImpl(tokenUrl, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(4500) });
    if (!r.ok) throw new Error('OAuth exchange rejected');
    const grant = tokenPayload(await r.json(), previous, now(), mode, meta);
    secrets.set(key, JSON.stringify({ binding, grant }));
    return { accessToken: grant.accessToken, meta: grant.meta };
  }

  const serialized = (fn) => {
    exchange = fn().finally(() => { exchange = undefined; });
    return exchange;
  };
  return {
    begin() {
      if (!authorize || exchange) return null;
      const state = random(), verifier = pkce ? random() : undefined;
      pending = { state, verifier, expiresAt: now() + LIFE };
      const url = new URL(authorize);
      url.search = new URLSearchParams({ ...provider.authorizeParams, client_id: clientId, state,
        ...(!provider.customAuthorize && { redirect_uri: redirect.href, response_type: 'code' }),
        ...(scopes.length && { scope: scopes.join(separator) }),
        ...(provider.nonce && { nonce: random() }),
        ...(verifier && { code_challenge: hash(verifier), code_challenge_method: 'S256' }) }).toString();
      return url.href;
    },
    async finish(callback) {
      if (!pending || exchange || !redirect || pending.expiresAt <= now()) return false;
      const params = parseCallback(callback, redirect);
      if (!params || !sameState(params.state, pending.state) || !present(params.code)) return false;
      const meta = provider.callbackMeta?.(params);
      if (provider.callbackMeta && !meta) return false;
      const { verifier } = pending;
      pending = undefined;
      await serialized(() => request({ grant_type: 'authorization_code', code: params.code,
        redirect_uri: redirect.href, ...(verifier && { code_verifier: verifier }) }, null, meta));
      return true;
    },
    async token() {
      if (exchange) return exchange;
      const grant = load();
      if (grant && grant.expiresAt > now() + MARGIN) return { accessToken: grant.accessToken, meta: grant.meta };
      if (mode === 'client_credentials') return serialized(() => request({ grant_type: 'client_credentials',
        ...(provider.tokenScope && { scope: provider.tokenScope }) }));
      if (!grant) throw new Error('OAuth consent is required');
      return serialized(() => request({ grant_type: 'refresh_token', refresh_token: grant.refreshToken,
        ...(provider.refreshRedirect && { redirect_uri: redirect.href }) }, grant, grant.meta));
    },
  };
}
