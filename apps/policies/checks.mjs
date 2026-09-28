// webgen-bench/000005 — regulatory policy dashboard.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const chartTable = (html, title) => {
  const start = html.indexOf(`<table class="chart-data"><caption>${title}</caption>`);
  const end = html.indexOf('</table>', start);
  return html.slice(start, end + 8);
};

export const checks = [
  { task: 'Test the data visualization feature for a selected regulatory policy.',
    run: async ({ get, must }) => {
      const detail = await get('/Policy/5');
      must(/Healthcare Data Privacy Extension/.test(detail.html), 'could not open the selected policy');
      const dash = await get('/dashboard/policies');
      const chart = chartTable(dash.html, 'Compliance cost by policy');
      must(/Healthcare Data Privacy Extension<\/td><td>22000000\.00<\/td>/.test(chart), 'the chart does not accurately represent the selected policy\'s data');
      return 'selecting a policy and opening the dashboard shows a chart bar matching its own compliance cost';
    } },
  { task: 'Check the filter function for regulatory policies.',
    run: async ({ get, rows, rowWith, must }) => {
      const byType = await get('/Policy?type=Environmental');
      must(rows(byType.html).length === 2 && rowWith(byType.html, 'Clean Air Standards Update') && rowWith(byType.html, 'Renewable Energy Incentive Repeal'),
        'the policy type filter does not narrow correctly');
      const byDate = await get('/Policy?enactedDate_from=2022-01-01&enactedDate_to=2024-12-31');
      must(rows(byDate.html).length === 3, `expected 3 policies enacted 2022-2024, got ${rows(byDate.html).length}`);
      const byRelevance = await get('/Policy?relevanceScore_from=70&relevanceScore_to=100');
      must(rows(byRelevance.html).length === 3 && rowWith(byRelevance.html, 'Healthcare Data Privacy Extension'), 'the relevance filter does not narrow correctly');
      return 'type, date and relevance filters each narrow the policy list correctly';
    } },
  { task: 'Assess the sorting functionality within the dashboard.',
    run: async ({ get, rows, must }) => {
      const byDate = await get('/Policy?sort=enactedDate&dir=asc');
      must(rows(byDate.html)[0].includes('Renewable Energy Incentive Repeal'), 'sorting by date ascending did not put the oldest policy first');
      const byTitle = await get('/Policy?sort=title&dir=asc');
      must(rows(byTitle.html)[0].includes('Clean Air Standards Update'), 'sorting by name did not order alphabetically');
      const byRelevance = await get('/Policy?sort=relevanceScore&dir=asc');
      must(rows(byRelevance.html)[0].includes('Renewable Energy Incentive Repeal'), 'sorting by relevance ascending did not put the lowest score first');
      return 'sort by date, name and relevance all reorder the list as expected';
    } },
  { task: 'Confirm navigation between different sections of the website.',
    run: async ({ get, must }) => {
      const overview = await get('/Policy');
      must(/<title>Policies/.test(overview.html), 'the overview section is not clearly indicated');
      const detail = await get('/Policy/1');
      must(/Yearly data/.test(detail.html), 'the related-data section is not reachable from a policy');
      const dash = await get('/dashboard/policies');
      must(/<title>Policy analytics/.test(dash.html), 'the visualization section is not clearly indicated');
      return 'overview, related data and visualization sections are each reachable and identified by their own title';
    } },
  { task: 'Evaluate the clarity and relevance of the content displayed for the first regulatory policy.',
    run: async ({ get, must }) => {
      const d = await get('/Policy/1');
      must(/Tightens emission limits for industrial facilities/.test(d.html), 'the first policy\'s description is missing or unclear');
      must(/<th>Agency<\/th><td>EPA<\/td>/.test(d.html) && /<th>Status<\/th><td>active<\/td>/.test(d.html) && /<th>Enacted Date<\/th><td>2024-03-01<\/td>/.test(d.html),
        'the first policy is missing clear agency, status or date details');
      return 'the first policy shows a clear, relevant description alongside agency, status and date';
    } },
  { task: 'Assess the policy search functionality on the website.',
    run: async ({ get, rows, rowWith, must }) => {
      const s = await get('/Policy?q=privacy');
      must(rows(s.html).length === 1 && rowWith(s.html, 'Healthcare Data Privacy Extension'), 'the search did not return the relevant policy');
      return 'searching "privacy" returns the one relevant policy';
    } },
  navCheck(3),
  colorCheck('lavender', 'indigo'),
];
