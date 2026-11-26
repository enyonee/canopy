const invalid = [400, { error: 'invalid document request' }];
const drift = [502, { error: 'unexpected Diadoc response' }];
const guid = (s) => typeof s === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const text = (s, max) => typeof s === 'string' && s.length <= max;
const same = (a, b) => a?.toLowerCase() === b.toLowerCase();

function document(row) {
  if (!guid(row?.MessageId) || !guid(row.EntityId) || row.DocumentDirection !== 'Inbound' ||
    !text(row.DocumentType, 128)) return null;
  const number = row.DocumentNumber ?? '', status = row.DocflowStatus?.PrimaryStatus?.StatusText ?? '';
  if (!text(number, 128) || !text(status, 512)) return null;
  return { messageId: row.MessageId, entityId: row.EntityId, type: row.DocumentType, number, status };
}

export function diadocProvider(config) {
  const { boxId, clientId, clientSecret, redirectUri } = config;
  if (!guid(boxId)) throw new Error('invalid Diadoc box ID');
  const origin = 'https://diadoc-api.kontur.ru';
  return {
    name: 'diadoc', mode: 'consent', clientId, clientSecret, redirectUri, nonce: true,
    authorizeUrl: 'https://identity.kontur.ru/connect/authorize', tokenUrl: 'https://identity.kontur.ru/connect/token',
    scopes: ['openid', 'offline_access', 'Diadoc.PublicAPI'], account: boxId,
    routes(token, fetchImpl) {
      async function call(path, query, body) {
        const { accessToken } = await token();
        const r = await fetchImpl(origin + path + '?' + new URLSearchParams({ boxId, ...query }), {
          method: body ? 'POST' : 'GET', redirect: 'manual',
          headers: { accept: 'application/json', authorization: 'Bearer ' + accessToken,
            ...(body && { 'content-type': 'application/json; charset=utf-8' }) },
          ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4500),
        });
        if (!r.ok) throw new Error('Diadoc request failed');
        return r.json();
      }
      return {
        '/diadoc/documents': async ({ limit, after }) => {
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !text(after, 1024)) return invalid;
          const r = await call('/V4/GetDocuments', {}, { DocumentCategory: 'Inbound', SortDirection: 'Descending',
            Count: String(limit), ...(after && { AfterIndexKey: after }) });
          const rows = r?.Documents ?? (r?.TotalCount === 0 ? [] : null);
          if (!Array.isArray(rows) || rows.length > limit) return drift;
          const documents = rows.map(document);
          const next = rows.length === limit ? rows.at(-1)?.IndexKey : '';
          if (documents.includes(null) || !text(next, 1024) || (rows.length === limit && !next)) return drift;
          return [200, { documents, next }];
        },
        '/diadoc/document': async ({ messageId, entityId }) => {
          if (!guid(messageId) || !guid(entityId)) return invalid;
          const row = document(await call('/V3/GetDocument', { messageId, entityId }));
          return row && same(row.messageId, messageId) && same(row.entityId, entityId) ? [200, row] : drift;
        },
      };
    },
  };
}
