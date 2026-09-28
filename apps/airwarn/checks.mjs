// webgen-bench/000068 — environmental warning system: live weather/AQI plus a 14-day history.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const metric = (html, title) => (new RegExp(`<div class="metric"><b>([^<]*)</b>${title}</div>`).exec(html) || [, null])[1];
const chartTable = (html, title) => {
  const start = html.indexOf(`<table class="chart-data"><caption>${title}</caption>`);
  const end = html.indexOf('</table>', start);
  return html.slice(start, end + 8);
};

export const checks = [
  { task: 'Verify that the website loads the real-time weather data on the homepage.',
    run: async ({ get, must }) => {
      const d = await get('/');
      must(d.status === 200, `homepage returned ${d.status}`);
      must(metric(d.html, 'Temperature') === '77' && metric(d.html, 'Humidity') === '45' && metric(d.html, 'Gas sensor level') === '305',
        'temperature, humidity and gas sensor data are not all shown on load');
      return 'temperature 77, humidity 45 and gas level 305 all show immediately on the homepage';
    } },
  { task: 'Check if the website updates the air quality index (AQI) data in real-time.',
    run: async ({ get, post, must }) => {
      const before = metric((await get('/dashboard/realtime')).html, 'Air Quality Index');
      must(before === '68', `expected an initial AQI of 68, got ${before}`);
      const ran = await post('/schedule/tick/run', {});
      must(ran.status === 303, `triggering the live tick failed: ${ran.status}`);
      const after = metric((await get('/dashboard/realtime')).html, 'Air Quality Index');
      must(after === '76', `AQI did not update in real time: ${after}`);
      return 'AQI moves from 68 to 76 the instant a new reading is ingested, no manual reload needed';
    } },
  { task: 'Validate the ability to view historical air quality index (AQI) data for the past two weeks.',
    run: async ({ get, must }) => {
      const r = await get('/dashboard/history?from=2026-09-14&to=2026-09-27');
      const chart = chartTable(r.html, 'AQI trend');
      const days = ['14:42', '15:48', '16:55', '17:61', '18:68', '19:74', '20:81', '21:88', '22:95', '23:102', '24:97', '25:89', '26:76', '27:63'];
      for (const pair of days) {
        const [day, aqi] = pair.split(':');
        must(new RegExp(`2026-09-${day}<\\/td><td>${aqi}<\\/td>`).test(chart), `missing or wrong AQI for 2026-09-${day}: ${chart}`);
      }
      return 'all 14 days of AQI history are shown with their correct values';
    } },
  { task: 'Test the functionality for comparing changes in pollution and air quality over a specified period.',
    run: async ({ get, must }) => {
      const r = await get('/dashboard/history?from=2026-09-18&to=2026-09-23');
      const chart = chartTable(r.html, 'AQI trend');
      must(/2026-09-18<\/td><td>68<\/td>/.test(chart) && /2026-09-23<\/td><td>102<\/td>/.test(chart),
        'the two chosen dates are not both shown for comparison');
      must(!/2026-09-14/.test(chart) && !/2026-09-27/.test(chart), 'the comparison range was not narrowed to the two chosen dates');
      return 'AQI 68 (Sep 18) and 102 (Sep 23) both appear on the same chart, showing the pollution change between the two dates';
    } },
  { task: 'Ensure that users can navigate to a section that displays current weather information.',
    run: async ({ get, must }) => {
      const nav = (await get('/')).html;
      must(/href="\/dashboard\/realtime"/.test(nav), 'no menu link to the current-weather section');
      const r = await get('/dashboard/realtime');
      must(r.status === 200 && /Temperature/.test(r.html) && /Humidity/.test(r.html), 'the current-weather section is not reachable or incomplete');
      return 'a menu link leads to the current weather section, which shows temperature and humidity';
    } },
  navCheck(3),
  colorCheck('azure', 'darkslateblue'),
];
