// webgen-bench/000002 — neighborhood mapping and comparison.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

// Pulls out one dashboard chart's own <table class="chart-data">…</table> block so a check can
// read exactly that chart's rows (via the shared `rows` helper) without the rest of the page.
const chartTable = (html, title) => {
  const start = html.indexOf(`<table class="chart-data"><caption>${title}</caption>`);
  if (start === -1) return '';
  const end = html.indexOf('</table>', start);
  return html.slice(start, end + 8);
};

export const checks = [
  { task: 'Navigate to the homepage of the neighborhood mapping application.',
    run: async ({ get, must }) => {
      const home = await get('/');
      must(home.status === 200, `homepage returned ${home.status}`);
      must(/demographic/i.test(home.html) && /economic/i.test(home.html) && /crime/i.test(home.html),
        'the homepage does not prominently mention demographic, economic and crime data');
      must(/href="\/Neighborhood"/.test(home.html) && /href="\/dashboard\/areas"/.test(home.html), 'no links to browse or compare areas');
      return 'homepage mentions all three data categories and links to the comparison views';
    } },
  { task: "Use the application's search function to select and compare demographic data for two different neighborhoods.",
    run: async ({ get, rows, rowWith, must }) => {
      const s = await get('/Neighborhood?q=Springfield');
      must(s.status === 200, `search returned ${s.status}`);
      must(rows(s.html).length === 2, `expected exactly 2 neighborhoods, got ${rows(s.html).length}`);
      const a = rowWith(s.html, 'Riverside Heights'), b = rowWith(s.html, 'Oak Hill');
      must(a && a.includes('<td>8400</td>') && b && b.includes('<td>6200</td>'), 'demographic data (population) is not shown side by side for both neighborhoods');
      must(!rowWith(s.html, 'Maple Grove'), 'the search did not narrow to the two neighborhoods');
      return 'search by shared city narrows to two neighborhoods, demographic data shown side by side';
    } },
  { task: "Interact with a data dashboard by modifying a chart's time range.",
    run: async ({ get, rows, must }) => {
      const full = await get('/dashboard/areas');
      const fullChart = chartTable(full.html, 'Median income by neighborhood');
      must(rows(fullChart).length === 6, `expected all 6 neighborhoods on the chart, got ${rows(fullChart).length}`);
      const narrow = await get('/dashboard/areas?from=2026-01-01&to=2026-04-01');
      const narrowChart = chartTable(narrow.html, 'Median income by neighborhood');
      const narrowRows = rows(narrowChart);
      must(narrowRows.length === 2, `expected the narrowed range to leave 2 neighborhoods, got ${narrowRows.length}`);
      must(narrowRows.some((r) => r.includes('Riverside Heights')) && narrowRows.some((r) => r.includes('Oak Hill')), 'the narrowed chart does not show the two surveyed in range');
      return 'chart went from 6 neighborhoods to 2 once the time range was narrowed to Jan-Apr 2026';
    } },
  { task: 'Rearrange the components of a dashboard by exchanging the display of demographic data and ecnomic data to create a customized layout.',
    run: async ({ get, must }) => {
      const base = await get('/dashboard/areas');
      const baseDemo = base.html.indexOf('Demographic data'), baseEcon = base.html.indexOf('Economic data');
      must(baseDemo > -1 && baseEcon > -1 && baseDemo < baseEcon, 'the default layout is not demographic-then-economic');
      const swapped = await get('/dashboard/areas-swapped');
      must(swapped.status === 200, `swapped layout returned ${swapped.status}`);
      const swapDemo = swapped.html.indexOf('Demographic data'), swapEcon = swapped.html.indexOf('Economic data');
      must(swapDemo > -1 && swapEcon > -1 && swapEcon < swapDemo, 'the swapped layout does not show economic before demographic');
      must(/<td>8400<\/td>/.test(swapped.html), 'the swapped layout lost the underlying demographic data');
      return 'the saved alternate layout shows economic data before demographic data; same underlying numbers';
    } },
  navCheck(3),
  colorCheck('ivory', 'forestgreen'),
];
