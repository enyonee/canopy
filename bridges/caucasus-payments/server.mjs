import { pathToFileURL } from 'node:url';
import { merchantServer } from '../merchant-http.mjs';
import { ameriaRoutes } from './ameriabank.mjs';
import { epointRoutes } from './epoint.mjs';

export function createBridge(config, fetchImpl = fetch) {
  if (!config.ameriabank && !config.epoint) throw new Error('configure at least one payment provider');
  return merchantServer(config.operatorToken, {
    ...(config.ameriabank && ameriaRoutes(config.ameriabank, fetchImpl)),
    ...(config.epoint && epointRoutes(config.epoint, fetchImpl)),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const ameria = { clientId: env.AMERIA_CLIENT_ID, username: env.AMERIA_USERNAME, password: env.AMERIA_PASSWORD,
    returnUrl: env.AMERIA_RETURN_URL, test: env.AMERIA_TEST === '1' };
  const epoint = { publicKey: env.EPOINT_PUBLIC_KEY, privateKey: env.EPOINT_PRIVATE_KEY, checkoutOrigin: env.EPOINT_CHECKOUT_ORIGIN,
    successUrl: env.EPOINT_SUCCESS_URL, failUrl: env.EPOINT_FAIL_URL };
  createBridge({ operatorToken: env.CAUCASUS_OPERATOR_TOKEN, ameriabank: ameria.clientId && ameria,
    epoint: epoint.publicKey && epoint }).listen(8903, '127.0.0.1');
}
