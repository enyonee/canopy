// webgen-bench/000084 — risk assessment tool with a subscription gate.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const chartTable = (html, title) => {
  const start = html.indexOf(`<table class="chart-data"><caption>${title}</caption>`);
  const end = html.indexOf('</table>', start);
  return html.slice(start, end + 8);
};

let assessmentId = null;

// A JSON read as a signed-in user, on a session of its own (the check's cookie jar answers HTML).
const jsonAs = async (base, login, password, p) => {
  const signIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login, password }).toString() });
  const cookie = (signIn.headers.get('set-cookie') || '').split(';')[0];
  const res = await fetch(base + p, { headers: { cookie, accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
};

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
      must(/Cyber<\/td><td>16<\/td>/.test(before), 'the chart does not yet reflect the item already selected');
      // The demo subscriber's seeded Financial item is hers: Jane's chart is built from Jane's selections only.
      must(!/Financial/.test(before), "another subscriber's Financial item shows on this subscriber's chart");
      must(!/Compliance/.test(before), 'Compliance should not be on the chart before this category is selected');
      const added = await post(`/Assessment/${assessmentId}/add/AssessmentItem`, { riskItem: 6 });
      must(added.status === 303, `selecting the second risk item failed: ${added.status}`);
      const after = chartTable((await get('/dashboard/risk')).html, 'Risk score by category');
      must(/Compliance<\/td><td>10<\/td>/.test(after) && /Cyber<\/td><td>16<\/td>/.test(after) && !/Financial/.test(after),
        'the chart does not reflect the newly selected item');
      return "the chart gains a labelled Compliance bar at 10 the moment that item is selected, earlier categories unchanged, another subscriber's items absent";
    } },
  { task: 'Test report creation functionality.',
    run: async ({ base, get, post, must }) => {
      const detail = await get(`/Assessment/${assessmentId}`);
      must(/<th>Item Count<\/th><td>2<\/td>/.test(detail.html) && /<th>Total Risk Score<\/th><td>26<\/td>/.test(detail.html) && /<th>Avg Risk Score<\/th><td>13<\/td>/.test(detail.html),
        'the report row does not summarise its selected items');
      const csv = await get(`/AssessmentItem.csv?assessment=${assessmentId}`);
      must(csv.type.includes('csv'), `expected a CSV download, got ${csv.type}`);
      must(/Phishing Attack Exposure/.test(csv.html) && /16/.test(csv.html), 'the downloadable report is missing the selected item\'s populated data');
      const dash = await get('/dashboard/risk');
      must(/<svg role="img"/.test(dash.html), 'the report has no generated chart to accompany it');
      // The demo subscriber's assessment (seed #1, its item seed #1) stays hers: Jane neither reads, exports, edits nor removes it.
      const theirs = await get('/AssessmentItem.csv?assessment=1');
      must(!/Vendor Payment Fraud|Q3 Vendor Risk Review/.test(theirs.html), "another subscriber's assessment items are in this subscriber's CSV");
      const listed = await jsonAs(base, 'jane@risk.test', 'jane123', '/AssessmentItem');
      must(listed.status === 200 && listed.body.total === 2 && listed.body.rows.every((r) => String(r.assessment) === String(assessmentId)),
        `this subscriber lists items that are not hers: ${JSON.stringify(listed.body).slice(0, 200)}`);
      must((await get('/AssessmentItem/1')).status === 403, "this subscriber opened another subscriber's item");
      must((await post('/AssessmentItem/1', { riskItem: 6 })).status === 403, "this subscriber edited another subscriber's item");
      must((await post('/AssessmentItem/1/delete', {})).status === 403, "this subscriber removed another subscriber's item");
      const intrusion = await post('/AssessmentItem', { assessment: 1, riskItem: 2 });
      const demo = await jsonAs(base, 'demo@riskassess.test', 'demo123', '/Assessment/1');
      must(demo.status === 200 && demo.body.itemCount === 1 && demo.body.totalRiskScore === 8, `another subscriber's assessment changed: ${JSON.stringify(demo.body).slice(0, 200)}`);
      must(intrusion.status !== 303, `this subscriber added an item to another subscriber's assessment: ${intrusion.status} ${intrusion.location}`);
      return "the assessment summarises its own items (count 2, total 26, avg 13); a CSV download and the dashboard chart both carry the same data; another subscriber's assessment is out of reach";
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
