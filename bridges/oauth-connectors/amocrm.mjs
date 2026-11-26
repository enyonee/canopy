const invalid = [400, { error: 'invalid CRM request' }];
const drift = [502, { error: 'unexpected CRM response' }];
const id = (v) => Number.isSafeInteger(v) && v > 0;
const name = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 255;
const email = (v) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const readLead = (r, expected) => r?.id === expected && id(r.status_id) && id(r.pipeline_id)
  ? [200, { id: r.id, stageId: r.status_id, pipelineId: r.pipeline_id }] : drift;

function created(r, kind) {
  const rows = r?._embedded?.[kind];
  return Array.isArray(rows) && rows.length === 1 && id(rows[0]?.id) ? [200, { id: rows[0].id }] : drift;
}

export function amoProvider(config) {
  if (typeof config.portal !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.portal))
    throw new Error('invalid amoCRM portal');
  const domain = config.portal + '.amocrm.ru';
  const base = 'https://' + domain;
  return {
    name: 'amocrm', mode: 'consent', clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri,
    authorizeUrl: 'https://www.amocrm.ru/oauth', authorizeParams: { mode: 'post_message' }, customAuthorize: true,
    tokenUrl: base + '/oauth2/access_token', encoding: 'json', refreshRedirect: true, account: domain,
    callbackMeta: ({ referer, platform }) => (referer === domain || referer === base || referer === base + '/') &&
      (platform === undefined || platform === '1') ? { domain } : null,
    routes(token, fetchImpl) {
      async function call(path, method, body) {
        const { accessToken } = await token();
        const r = await fetchImpl(base + '/api/v4/' + path, { method, redirect: 'manual',
          headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json',
            ...(body && { 'content-type': 'application/json' }) },
          ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4500) });
        if (!r.ok) throw new Error('amoCRM rejected the request');
        return r.json();
      }
      return {
        '/amocrm/create-contact': async ({ name: value, email: address }) => {
          if (!name(value) || !email(address)) return invalid;
          return created(await call('contacts', 'POST', [{ name: value,
            custom_fields_values: [{ field_code: 'EMAIL', values: [{ value: address, enum_code: 'WORK' }] }],
          }]), 'contacts');
        },
        '/amocrm/contact': async ({ id: contactId }) => {
          if (!id(contactId)) return invalid;
          const r = await call('contacts/' + contactId, 'GET');
          return r?.id === contactId && name(r.name) ? [200, { id: contactId, name: r.name }] : drift;
        },
        '/amocrm/create-deal': async ({ name: value, pipelineId, stageId }) => {
          if (!name(value) || !id(pipelineId) || !id(stageId)) return invalid;
          return created(await call('leads', 'POST', [{ name: value, pipeline_id: pipelineId, status_id: stageId }]), 'leads');
        },
        '/amocrm/set-stage': async ({ id: leadId, stageId }) => {
          if (!id(leadId) || !id(stageId)) return invalid;
          const r = await call('leads', 'PATCH', [{ id: leadId, status_id: stageId }]);
          const rows = r?._embedded?.leads;
          return Array.isArray(rows) && rows.length === 1 && rows[0]?.id === leadId ? [200, { id: leadId }] : drift;
        },
        '/amocrm/deal': async ({ id: leadId }) => id(leadId) ? readLead(await call('leads/' + leadId, 'GET'), leadId) : invalid,
      };
    },
  };
}
