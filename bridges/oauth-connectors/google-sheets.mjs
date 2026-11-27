const invalid = [400, { error: 'invalid Sheets request' }];
const drift = [502, { error: 'unexpected Sheets response' }];
const maxCells = 20, maxRows = 25;
const rowNumber = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000;
const cell = (value) => typeof value === 'boolean' || Number.isFinite(value) ||
  (typeof value === 'string' && value.length <= 1000);
const validRow = (row) => Array.isArray(row) && row.length <= maxCells && row.every(cell);

export function googleSheetsProvider(config) {
  const { spreadsheetId, sheet, clientId, clientSecret, redirectUri } = config;
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(spreadsheetId) ||
    typeof sheet !== 'string' || sheet.length < 1 || sheet.length > 100 || /[\x00-\x1f]/.test(sheet))
    throw new Error('invalid Google Sheets configuration');
  const prefix = "'" + sheet.replaceAll("'", "''") + "'!";
  return {
    name: 'google-sheets', mode: 'consent', clientId, clientSecret, redirectUri, pkce: true,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    account: [spreadsheetId, sheet],
    routes(token, fetchImpl) {
      async function call(method, cells, params, requestBody) {
        const { sheets } = await import('@googleapis/sheets');
        const { accessToken } = await token();
        const values = sheets('v4').spreadsheets.values;
        const r = await values[method]({ spreadsheetId, range: prefix + cells, ...params, requestBody }, {
          headers: { authorization: 'Bearer ' + accessToken },
          retry: false, redirect: 'manual', signal: AbortSignal.timeout(4500),
          fetchImplementation: (url, options) => fetchImpl(String(url), options),
        });
        return r.data;
      }
      return {
        '/google-sheets/read': async ({ firstRow, limit }) => {
          if (!rowNumber(firstRow) || !Number.isSafeInteger(limit) || limit < 1 || limit > maxRows ||
            !rowNumber(firstRow + limit - 1)) return invalid;
          const r = await call('get', 'A' + firstRow + ':T' + (firstRow + limit - 1), { valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' });
          const rows = r?.values ?? [];
          if (r?.majorDimension !== 'ROWS' || !Array.isArray(rows) || rows.length > limit ||
            !rows.every(validRow) || Buffer.byteLength(JSON.stringify(rows)) > 64_000) return drift;
          return [200, { firstRow, rows }];
        },
        '/google-sheets/append': async ({ row }) => {
          if (!validRow(row) || !row.length) return invalid;
          const r = await call('append', 'A:T', { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }, {
            majorDimension: 'ROWS', values: [row],
          });
          const updatedRange = r?.updates?.updatedRange;
          return r?.spreadsheetId === spreadsheetId && r.updates?.updatedRows === 1 &&
            typeof updatedRange === 'string' && updatedRange.length > 0 && updatedRange.length <= 130
            ? [200, { updatedRange }] : drift;
        },
      };
    },
  };
}
