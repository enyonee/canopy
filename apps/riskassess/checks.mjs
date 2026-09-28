// webgen-bench/000084 — risk assessment tool with a subscription gate.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const chartTable = (html, title) => {
  const start = html.indexOf(`<table class="chart-data"><caption>${title}</caption>`);
  const end = html.indexOf('</table>', start);
  return html.slice(start, end + 8);
};

let assessmentId = null;

export const checks = [
  { task: 'Check the subscription feature.',
    run: async ({ asGuest, post, get, must }) => {
      asGuest();
      const blocked = await post('/Assessment', { title: 'Should not work' });
      must(blocked.status === 403 || blocked.status === 303, `a guest should not create an assessment: ${blocked.status}`);
      const reg = await post('/register', { email: 'jane@risk.test', password: 'jane123', name: 'Jane' });
      must(reg.status === 303, `subscribing (registering) failed: ${reg.status}: ${reg.html.slice(0, 200)}`);
      const home = await get(reg.location);
      must(/Signed in as jane@risk.test \(subscriber\)/.test(home.html), 'not signed in as a subscriber right after registering');
      const now = await get('/Assessment/new');
      must(now.status === 200, `subscriber access was not granted immediately: ${now.status}`);
      return 'a guest is refused, registering grants subscriber access immediately';
    } },
  { task: 'Test risk assessment item selection.',
    run: async ({ post, get, must }) => {
      const made = await post('/Assessment', { title: 'Vendor Q4 Review' });
      assessmentId = /\/Assessment\/(\d+)/.exec(made.location)[1];
      const detail = await get(`/Assessment/${assessmentId}`);
      must(/name="riskItem"/.test(detail.html), 'no item-selection control on the assessment page');
      must((detail.html.match(/<option/g) || []).length >= 6, 'the risk item list to select from looks incomplete');
      const picked = await post(`/Assessment/${assessmentId}/add/AssessmentItem`, { riskItem: 1 });
      must(picked.status === 303, `selecting a risk item failed: ${picked.status}`);
      const after = await get(`/Assessment/${assessmentId}`);
      must(/Phishing Attack Exposure/.test(after.html), 'the selected item is not shown (highlighted) in the assessment');
      return 'a risk item is selectable from a list of catalog items and appears in the assessment once selected';
    } },
  { task: 'Verify auto-population of data.',
    run: async ({ get, must }) => {
      const detail = await get(`/Assessment/${assessmentId}`);
      must(/Phishing Attack Exposure<\/a><\/td><td>4<\/td><td>4<\/td><td>Cyber<\/td><td>16<\/td>/.test(detail.html),
        'likelihood, impact, category and risk score did not auto-populate from the catalog');
      return 'likelihood 4, impact 4, category Cyber and risk score 16 all auto-filled from the catalog, no re-entry';
    } },
  { task: 'Test chart generation.',
    run: async ({ get, post, must }) => {
      const before = chartTable((await get('/dashboard/risk')).html, 'Risk score by category');
      must(/Cyber<\/td><td>16<\/td>/.test(before) && /Financial<\/td><td>8<\/td>/.test(before), 'the chart does not yet reflect the item already selected');
      must(!/Compliance/.test(before), 'Compliance should not be on the chart before this category is selected');
      const added = await post(`/Assessment/${assessmentId}/add/AssessmentItem`, { riskItem: 6 });
      must(added.status === 303, `selecting the second risk item failed: ${added.status}`);
      const after = chartTable((await get('/dashboard/risk')).html, 'Risk score by category');
      must(/Compliance<\/td><td>10<\/td>/.test(after) && /Cyber<\/td><td>16<\/td>/.test(after) && /Financial<\/td><td>8<\/td>/.test(after),
        'the chart does not reflect the newly selected item');
      return 'the chart gains a labelled Compliance bar at 10 the moment that item is selected, earlier categories unchanged';
    } },
  { task: 'Test report creation functionality.',
    run: async ({ get, must }) => {
      const detail = await get(`/Assessment/${assessmentId}`);
      must(/<th>Item Count<\/th><td>2<\/td>/.test(detail.html) && /<th>Total Risk Score<\/th><td>26<\/td>/.test(detail.html) && /<th>Avg Risk Score<\/th><td>13<\/td>/.test(detail.html),
        'the report row does not summarise its selected items');
      const csv = await get(`/AssessmentItem.csv?assessment=${assessmentId}`);
      must(csv.type.includes('csv'), `expected a CSV download, got ${csv.type}`);
      must(/Phishing Attack Exposure/.test(csv.html) && /16/.test(csv.html), 'the downloadable report is missing the selected item\'s populated data');
      const dash = await get('/dashboard/risk');
      must(/<svg role="img"/.test(dash.html), 'the report has no generated chart to accompany it');
      return 'the assessment summarises its own items (count 2, total 26, avg 13); a CSV download and the dashboard chart both carry the same data';
    } },
  { task: 'Test navigation between pages.',
    run: async ({ get, must }) => {
      const login = await get('/login');
      must(login.status === 200, `login page returned ${login.status}`);
      must((await get('/dashboard/risk')).status === 200, 'the dashboard is not reachable');
      must((await get('/Assessment')).status === 200, 'the reporting (assessments) page is not reachable');
      return 'login, dashboard and reporting pages are all reachable without errors';
    } },
  navCheck(3),
  colorCheck('aliceblue', 'steelblue'),
];
