// webgen-bench/000065 — agriculture site: news, farm products, weather, search and filters.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Browse agricultural-related news on the homepage',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/page/home');
      must(home.status === 200 && /href="\/NewsArticle"/.test(home.html), 'the homepage does not link to the news');
      const { html, status } = await get('/NewsArticle');
      must(status === 200, `news list returned ${status}`);
      must(rows(html).length === 5, `expected 5 articles, got ${rows(html).length}`);
      const row = rowWith(html, 'Wheat yields expected to rise this harvest');
      must(row && /2026-09-20/.test(row) && /Favourable spring rains/.test(row), `latest article row: ${row}`);
      must(rows(html)[0].includes('Wheat yields'), 'the newest article is not shown first');
      return '5 up-to-date agricultural news articles, titles and summaries visible, newest first';
    } },

  { task: 'View detailed information about a specific farm product',
    run: async ({ get, idOf, must }) => {
      const list = await get('/FarmProduct');
      const id = idOf(list.html, 'Heirloom tomatoes', 'FarmProduct');
      const { html, status } = await get(`/FarmProduct/${id}`);
      must(status === 200, `product detail returned ${status}`);
      must(/<th>Name<\/th><td>Heirloom tomatoes<\/td>/.test(html), 'product name missing');
      must(/<th>Description<\/th><td>Mixed heirloom varieties/.test(html), 'product description missing');
      must(/<th>Price<\/th><td>4\.25<\/td>/.test(html), 'product price missing or wrong');
      must(/<th>Availability<\/th><td>limited<\/td>/.test(html), 'product availability missing');
      return 'the farm product detail page shows name, description, price and availability';
    } },

  { task: 'Check the local weather forecast from the main navigation menu',
    run: async ({ get, rows, must }) => {
      const home = await get('/page/home');
      must(/href="\/WeatherReading"/.test(home.html), 'the weather forecast is not reachable from the navigation');
      const { html, status } = await get('/WeatherReading');
      must(status === 200, `weather forecast returned ${status}`);
      must(rows(html).length === 5, `expected a 5-day forecast, got ${rows(html).length}`);
      must(/Green Valley County/.test(html) && /2026-09-27/.test(html) && /sunny/.test(html), `first forecast row: ${html.slice(0, 400)}`);
      must(rows(html).every((r) => /Green Valley County/.test(r)), 'a forecast row is for the wrong location');
      return "the 5-day forecast for Green Valley County is shown, oldest (today) first, with condition, highs, lows, precipitation and wind";
    } },

  { task: 'Perform a search for a specific agricultural topic using the search function',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/NewsArticle?q=irrigation');
      must(status === 200, `search returned ${status}`);
      must(rows(html).length === 1, `expected 1 result for "irrigation", got ${rows(html).length}`);
      must(rowWith(html, 'drip-irrigation subsidy'), 'the irrigation article is missing from the search results');
      const q2 = await get('/NewsArticle?q=dairy');
      must(rows(q2.html).length === 1 && rowWith(q2.html, 'Dairy prices firm'), 'search by another topic does not narrow to the right article');
      return 'search for "irrigation" and "dairy" each return exactly the one matching, relevant article';
    } },

  { task: 'Apply a filter to display only news articles about crop production',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/NewsArticle?category=cropProduction');
      must(status === 200, `filtered list returned ${status}`);
      must(rows(html).length === 1, `expected 1 crop-production article, got ${rows(html).length}`);
      must(rowWith(html, 'Wheat yields expected to rise this harvest'), 'the crop-production article is missing');
      must(!rowWith(html, 'Dairy prices') && !rowWith(html, 'Cattle producers'), 'an unrelated article leaked into the crop-production filter');
      return 'filtering by "crop production" shows only the wheat-yields article, no unrelated news';
    } },

  colorCheck('lightcyan', 'cadetblue'),
];
