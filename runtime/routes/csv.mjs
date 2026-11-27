import { pipeline } from 'node:stream/promises';
import { stringify } from 'csv-stringify/sync';

const options = { record_delimiter: 'windows', quoted_match: /[\r\n]/ };

function cell(value) {
  const text = String(value ?? '');
  if (/^-\d+(?:\.\d+)?$/.test(text)) return text;
  // CSV quoting alone does not stop spreadsheet formula interpretation.
  return /^[\t\r\n]|^\s*[=+@\uFF1D\uFF0B\uFF0D\uFF20-]/u.test(text) ? "'" + text : text;
}

export async function streamCsv(res, headers, name, header, batches) {
  async function* chunks() {
    yield stringify([header.map(cell)], options);
    for await (const batch of batches)
      yield stringify(batch.map((row) => row.map(cell)), options);
  }
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${name}.csv"`, ...headers });
  res.flushHeaders();
  await pipeline(chunks(), res).catch((e) => {
    // allow-swallow: a disconnected browser has already abandoned the download.
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  });
}
