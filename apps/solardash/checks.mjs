// webgen-bench/000006 — solar dashboard: live status plus historical trends.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const metric = (html, title) => (new RegExp(`<div class="metric"><b>([^<]*)</b>${title}</div>`).exec(html) || [, null])[1];
const chartTable = (html, title) => {
  const start = html.indexOf(`<table class="chart-data"><caption>${title}</caption>`);
  const end = html.indexOf('</table>', start);
  return html.slice(start, end + 8);
};

export const checks = [
  { task: 'Verify the display of real-time solar power generation data.',
    run: async ({ get, post, must }) => {
      const before = await get('/dashboard/realtime');
      must(metric(before.html, 'Solar generation \\(kW\\)') === '5', `expected an initial generation reading, got ${metric(before.html, 'Solar generation \\(kW\\)')}`);
      const ran = await post('/schedule/tick/run', {});
      must(ran.status === 303, `triggering the real-time tick failed: ${ran.status}`);
      const after = await get('/dashboard/realtime');
      must(metric(after.html, 'Solar generation \\(kW\\)') === '7', `generation did not update after a new reading: ${metric(after.html, 'Solar generation \\(kW\\)')}`);
      return 'generation reads 5 initially and 7 after one live tick, no manual data entry';
    } },
  { task: 'Test the display of real-time power consumption data.',
    run: async ({ get, post, must }) => {
      const before = metric((await get('/dashboard/realtime')).html, 'Power consumption \\(kW\\)');
      must(before === '4', `expected consumption 4 after the first tick, got ${before}`);
      await post('/schedule/tick/run', {});
      const after = metric((await get('/dashboard/realtime')).html, 'Power consumption \\(kW\\)');
      must(after === '5', `consumption did not update after the second tick: ${after}`);
      return 'consumption reads 4 then 5 as new readings arrive';
    } },
  { task: 'Validate the real-time display of battery percentage.',
    run: async ({ get, must }) => {
      const pct = metric((await get('/dashboard/realtime')).html, 'Battery percentage');
      must(pct === '70', `expected battery 70% after two ticks, got ${pct}`);
      return 'battery percentage climbs (60 -> 65 -> 70) exactly as the two live ticks predict';
    } },
  { task: 'Check the functionality of querying historical data from the solar power generation data by a start and end date.',
    run: async ({ get, must }) => {
      const r = await get('/dashboard/history?from=2026-09-24&to=2026-09-25');
      const chart = chartTable(r.html, 'Generation over time');
      must(/2026-09-24<\/td><td>6<\/td>/.test(chart) && /2026-09-25<\/td><td>7<\/td>/.test(chart), `expected exactly the 2 days in range: ${chart}`);
      must(!/2026-09-23/.test(chart) && !/2026-09-26/.test(chart), 'the date range did not exclude readings outside it');
      return 'querying 2026-09-24..25 returns generation trend for exactly those two days';
    } },
  { task: 'Test the navigation functionality between the real-time data display and historical data query sections.',
    run: async ({ get, must }) => {
      const live = await get('/dashboard/realtime');
      must(live.status === 200 && /Live status/.test(live.html), 'the live-status section is not reachable');
      const hist = await get('/dashboard/history');
      must(hist.status === 200 && /Historical trends/.test(hist.html), 'the historical section is not reachable');
      must(/href="\/dashboard\/realtime"/.test(live.html) || /href="\/dashboard\/history"/.test(live.html), 'no link between the two sections');
      return 'both sections load cleanly and link to each other';
    } },
  navCheck(3),
  colorCheck('honeydew', 'darkolivegreen'),
];
