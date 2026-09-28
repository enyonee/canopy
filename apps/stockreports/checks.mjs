// webgen-bench/000001 — stock research and reporting.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify the stock search functionality by entering a valid stock code.',
    run: async ({ get, idOf, must }) => {
      const s = await get('/Stock?q=AAPL');
      must(s.status === 200, `search returned ${s.status}`);
      const id = idOf(s.html, 'Apple Inc.');
      const d = await get(`/Stock/${id}`);
      must(/<th>Sector<\/th><td>Technology<\/td>/.test(d.html), 'sector (basic info) is missing');
      must(/<th>Change Pct<\/th><td>1\.23<\/td>/.test(d.html) && /<th>Trend<\/th><td>Up<\/td>/.test(d.html), 'market trend is missing or wrong');
      must(/<th>Revenue<\/th><td>383\.80<\/td>/.test(d.html) && /<th>Eps<\/th><td>6\.13<\/td>/.test(d.html), 'financial data is missing');
      return 'AAPL found by code; basic info, trend and financials all shown';
    } },
  { task: 'Test the report customization feature by selecting different report formats and content options.',
    run: async ({ get, must }) => {
      const f = await get('/Report/new');
      must(f.status === 200, `report form returned ${f.status}`);
      must(/<select[^>]*name="format">(?:(?!<\/select>)[\s\S])*<option>summary<\/option>(?:(?!<\/select>)[\s\S])*<option>detailed<\/option>(?:(?!<\/select>)[\s\S])*<option>full<\/option>/.test(f.html),
        'the three report formats are not offered');
      must(/name="includeTrends"/.test(f.html) && /name="includeFinancials"/.test(f.html), 'content options (trends, financials) are not offered');
      return 'format select (summary/detailed/full) and two content checkboxes are offered';
    } },
  { task: 'Input a stock name instead of a stock code to search for stock information.',
    run: async ({ get, rowWith, must }) => {
      const s = await get('/Stock?q=Apple');
      must(rowWith(s.html, 'Apple Inc.'), 'searching by name did not find the stock');
      must(!rowWith(s.html, 'JPMorgan Chase'), 'name search did not narrow');
      return 'stock name recognised, result narrowed to the matching company';
    } },
  { task: 'Generate a customized stock report by choosing specific elements to include (e.g., market trends, financial data).',
    run: async ({ follow, get, idOf, must }) => {
      const stockId = idOf((await get('/Stock')).html, 'Apple Inc.');
      const trendsDetail = await follow('/Report', { stock: stockId, format: 'summary', includeTrends: 1 });
      // Round 5: Entity.form.confirm now interpolates {row.*} (including a
      // one-hop reference), same as an action's/transition's confirm always
      // could — the create flash names the actual stock, not a static string.
      must(/class="flash">Report generated for Apple Inc\. \(AAPL\)</.test(trendsDetail.html),
        `the create flash does not name the report's own stock: ${trendsDetail.html.match(/class="flash">[^<]*/)}`);
      must(/trend: Up \(1\.23%\)/.test(trendsDetail.html), 'the trends-only report is missing the trend section');
      must(!/net income/.test(trendsDetail.html), 'the trends-only report leaked financial data');
      const finDetail = await follow('/Report', { stock: stockId, format: 'summary', includeFinancials: 1 });
      must(/revenue: 383\.8, net income: 97, EPS: 6\.13/.test(finDetail.html), 'the financials-only report is missing its section');
      must(!/trend:/.test(finDetail.html), 'the financials-only report leaked the trend section');
      return 'a report including only trends omits financials and vice versa';
    } },
  navCheck(3),
  { task: 'Evaluate the website\'s form inputs by submitting incomplete or incorrect stock information.',
    run: async ({ post, must }) => {
      const incomplete = await post('/Stock', { sector: 'Technology' });
      must(incomplete.status === 400 && /is required/.test(incomplete.html), `missing name/symbol was accepted: ${incomplete.status}`);
      const bad = await post('/Stock', { name: 'Bad Co', symbol: 'BAD', price: -5, prevClose: 1 });
      must(bad.status === 400 && /Price cannot be negative/.test(bad.html), `a negative price was accepted: ${bad.status}`);
      return 'missing required fields and a negative price are both refused with a guiding message';
    } },
  colorCheck('white', 'navy'),
];
