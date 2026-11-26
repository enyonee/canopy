import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSecrets } from '../../runtime/secrets.mjs';
import { merchantServer } from '../merchant-http.mjs';
import { amoProvider } from './amocrm.mjs';
import { googleSheetsProvider } from './google-sheets.mjs';
import { shopifyProvider } from './shopify.mjs';
import { tokenBroker } from './tokens.mjs';

export function createBridge({ dataToken, adminToken, providers, secrets, fetchImpl = fetch, now = Date.now }) {
  if (!providers.length) throw new Error('configure at least one OAuth provider');
  const api = {}, admin = {};
  if (new Set(providers.map(({ name }) => name)).size !== providers.length)
    throw new Error('duplicate OAuth provider');
  for (const provider of providers) {
    const broker = tokenBroker(secrets, provider, fetchImpl, now);
    for (const [route, action] of Object.entries(provider.routes(broker.token, fetchImpl))) {
      if (!route.startsWith('/' + provider.name + '/') || Object.hasOwn(api, route)) throw new Error('invalid provider route');
      api[route] = action;
    }
    if (provider.mode !== 'consent') continue;
    const base = '/' + provider.name;
    admin[base + '/begin'] = () => {
      const url = broker.begin();
      return url ? [200, { url }] : [409, { error: 'authorization already in progress' }];
    };
    admin[base + '/finish'] = async ({ callback }) => await broker.finish(callback)
      ? [200, { connected: true }] : [400, { error: 'invalid or expired authorization' }];
  }
  const hasConsent = Object.keys(admin).length > 0;
  if (hasConsent && adminToken === dataToken) throw new Error('use separate OAuth administrator and connector tokens');
  return { data: merchantServer(dataToken, api), admin: hasConsent ? merchantServer(adminToken, admin) : null };
}

function privateStore(dir) {
  if (!dir || !isAbsolute(dir)) throw new Error('CANOPY_OAUTH_SECRETS_DIR must be an absolute path');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stats = statSync(dir);
  if (!stats.isDirectory() || (stats.mode & 0o077)) throw new Error('OAuth secrets directory must be private (0700)');
  return openSecrets({ dir, app: 'canopy-oauth-connectors' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  process.umask(0o077);
  const providers = [];
  if (env.SHOPIFY_SHOP) providers.push(shopifyProvider({ shop: env.SHOPIFY_SHOP,
    clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET }));
  if (env.GOOGLE_SHEETS_SPREADSHEET_ID) providers.push(googleSheetsProvider({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, sheet: env.GOOGLE_SHEETS_SHEET,
    clientId: env.GOOGLE_SHEETS_CLIENT_ID, clientSecret: env.GOOGLE_SHEETS_CLIENT_SECRET,
    redirectUri: env.GOOGLE_SHEETS_REDIRECT_URI,
  }));
  if (env.AMOCRM_PORTAL) providers.push(amoProvider({ portal: env.AMOCRM_PORTAL,
    clientId: env.AMOCRM_CLIENT_ID, clientSecret: env.AMOCRM_CLIENT_SECRET, redirectUri: env.AMOCRM_REDIRECT_URI }));
  const { data, admin } = createBridge({ providers, dataToken: env.CANOPY_OAUTH_DATA_TOKEN,
    adminToken: env.CANOPY_OAUTH_ADMIN_TOKEN, secrets: privateStore(env.CANOPY_OAUTH_SECRETS_DIR) });
  data.listen(8905, '127.0.0.1');
  admin?.listen(8906, '127.0.0.1');
}
