// WebGen-Bench 000025 — insurance automation. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

const today = () => new Date().toISOString().slice(0, 10);
let firstPolicy = null;

export const checks = [
  { task: 'The customer management section lists the customers with names, ids and contact details',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      must(/<a href="\/Customer">Customers<\/a>/.test(home.html), 'the menu has no customer management item');
      const list = await get('/Customer');
      must(list.status === 200 && /<h2>Customers<\/h2>/.test(list.html), `customers returned ${list.status}`);
      must(rows(list.html).length === 4, `expected 4 customers, got ${rows(list.html).length}`);
      const alice = rowWith(list.html, 'Alice Brown');
      must(alice && /^<td>1<\/td><td>Alice Brown<\/td><td>alice@example.test<\/td><td>\+1 555 0101<\/td><td>2<\/td><td>3<\/td>/.test(alice), `Alice's row lacks id, contact details or derived counts: ${alice}`);
      must(/<th>Id<\/th><th>Name<\/th><th>Email<\/th><th>Phone<\/th><th>Policies<\/th><th>Claims<\/th>/.test(list.html), 'the column headers are wrong');
      const found = await get('/Customer?q=ben');
      must(rowWith(found.html, 'Ben Carter') && rows(found.html).length === 1, 'the customer search does not narrow');
      return '4 customers with id, email, phone, policy and claim counts; search narrows';
    } },
  { task: "A customer's profile shows personal details, the associated policies and the claim history",
    run: async ({ get, rows, rowWith, must }) => {
      const profile = await get('/Customer/1');
      must(profile.status === 200 && /<h2>Alice Brown<\/h2>/.test(profile.html), `the profile returned ${profile.status}`);
      for (const pair of ['<th>Email</th><td>alice@example.test</td>', '<th>Phone</th><td>+1 555 0101</td>', '<th>Address</th><td>1 Elm st, Springfield</td>',
        '<th>Birth Date</th><td>1985-04-12</td>', '<th>Policies</th><td>2</td>', '<th>Claims</th><td>3</td>', '<th>Premiums</th><td>1840.00</td>'])
        must(profile.html.includes(pair), `the profile lacks ${pair}`);
      must(/<h3>Policies<\/h3>/.test(profile.html) && /<h3>Claim history<\/h3>/.test(profile.html), 'policy or claim sections are missing');
      const pol = rowWith(profile.html, 'POL-1001');
      must(pol && /<td>auto<\/td>/.test(pol) && /25000\.00/.test(pol) && /status">Active/.test(pol), `the policy association is wrong: ${pol}`);
      must(rowWith(profile.html, 'POL-1002') && !rowWith(profile.html, 'POL-1003'), 'the policies of another customer leak in, or one is missing');
      const claims = ['CLM-2001', 'CLM-2002', 'CLM-2004'].map((n) => rowWith(profile.html, n));
      must(claims.every(Boolean) && /status">Paid/.test(claims[0]) && /POL-1002/.test(claims[1]) && /status">Filed/.test(claims[2]), 'the claim history is incomplete');
      must(!rowWith(profile.html, 'CLM-2003'), "another customer's claim is in the history");
      return 'details, 2 policies, 3 claims with statuses, premiums 1840.00';
    } },
  { task: 'The policy management section lists the policies with numbers, types and statuses',
    run: async ({ get, rows, rowWith, must }) => {
      const list = await get('/Policy');
      must(list.status === 200 && /<h2>Policies<\/h2>/.test(list.html), `policies returned ${list.status}`);
      const shown = rows(list.html);
      must(shown.length === 5, `expected 5 policies, got ${shown.length}`);
      must(/POL-1001/.test(shown[0]) && /POL-1005/.test(shown[4]), 'the policies are not ordered by number');
      const p3 = rowWith(list.html, 'POL-1003');
      must(p3 && /Ben Carter/.test(p3) && /<td>life<\/td>/.test(p3) && /500000\.00/.test(p3) && /status">Active/.test(p3), `the policy row is wrong: ${p3}`);
      must(rows((await get('/Policy?status=expired')).html).length === 1 && rows((await get('/Policy?type=auto')).html).length === 2, 'the status and type filters do not narrow');
      firstPolicy = /\/Policy\/(\d+)"/.exec(shown[0])[1];
      return '5 policies ordered by number with customer, type, coverage, status; filters narrow';
    } },
  { task: 'The first policy opens with its coverage, premium and expiration details',
    run: async ({ get, rowWith, must }) => {
      const detail = await get(`/Policy/${firstPolicy}`);
      must(detail.status === 200 && /<h2>POL-1001<\/h2>/.test(detail.html), `the policy returned ${detail.status}`);
      for (const pair of ['<th>Customer</th><td><a href="/Customer/1">Alice Brown</a></td>', '<th>Type</th><td>auto</td>', '<th>Coverage</th><td>25000.00</td>',
        '<th>Premium</th><td>640.00</td>', '<th>Start Date</th><td>2026-01-15</td>', '<th>End Date</th><td>2027-01-14</td>', '<th>Claims</th><td>2</td>', '<th>Claimed</th><td>4150.00</td>'])
        must(detail.html.includes(pair), `the policy lacks ${pair}`);
      must(/<th>Days Left<\/th><td>-?\d+<\/td>/.test(detail.html), 'days to expiry are not derived');
      must(rowWith(detail.html, 'CLM-2001') && rowWith(detail.html, 'CLM-2004') && !rowWith(detail.html, 'CLM-2002'), 'the claims under the policy are wrong');
      must(/go\/cancel"/.test(detail.html) && /go\/expire"/.test(detail.html) && !/go\/renew"/.test(detail.html), 'the lifecycle buttons do not follow the status');
      return 'coverage 25000.00, premium 640.00, expires 2027-01-14, 2 claims worth 4150.00';
    } },
  { task: 'The claims management section lists the claims with numbers, statuses and policy numbers; a new claim takes its customer from the policy',
    run: async ({ get, post, rows, rowWith, must, flashOf }) => {
      const list = await get('/Claim');
      must(list.status === 200 && rows(list.html).length === 4, `claims returned ${list.status} with ${rows(list.html).length} rows`);
      const c2 = rowWith(list.html, 'CLM-2002');
      must(c2 && /<a href="\/Policy\/2">POL-1002<\/a>/.test(c2) && /Alice Brown/.test(c2) && /1500\.00/.test(c2) && /status">Review/.test(c2), `the claim row is wrong: ${c2}`);
      must(rows((await get('/Claim?status=filed')).html).length === 1, 'the status filter does not narrow');
      const bad = await post('/Claim', { number: 'CLM-2001', policy: 3, amount: '10' });
      must(bad.status === 400 && /This claim number is already used/.test(bad.html), 'a duplicate claim number was accepted');
      const r = await post('/Claim', { number: 'CLM-2005', policy: 3, amount: '2500', filedAt: today(), description: 'Hospital stay' });
      must(r.status === 303, `filing a claim returned ${r.status}: ${r.html.slice(0, 300)}`);
      const detail = await get(r.location);
      must(/Claim filed successfully/.test(flashOf(detail.html)), `no confirmation: ${flashOf(detail.html)}`);
      must(/<th>Customer<\/th><td><a href="\/Customer\/2">Ben Carter<\/a><\/td>/.test(detail.html), 'the customer was not copied from the policy');
      must(rows((await get('/Claim')).html).length === 5, 'the new claim is not listed');
      return '4 claims with policy links and statuses; new claim filed, customer derived from the policy';
    } },
  { task: 'The reporting feature produces a report with accurate totals and breakdowns',
    run: async ({ get, must }) => {
      const d = await get('/dashboard/reports');
      must(d.status === 200 && /<h2>Reports<\/h2>/.test(d.html), `reports returned ${d.status}`);
      for (const card of ['<b>4</b>Customers', '<b>3</b>Active policies', '<b>4240.00</b>Annual premiums', '<b>5</b>Claims', '<b>8950.00</b>Claims amount', '<b>3200.00</b>Paid out'])
        must(d.html.includes(card), `the report lacks ${card}`);
      must(/Auto<\/td><td>2<\/td><td>43000\.00<\/td><td>1160\.00<\/td>/.test(d.html), 'policies by type is wrong');
      must(/Active<\/td><td>3<\/td>/.test(d.html) && /Expired<\/td><td>1<\/td>/.test(d.html), 'policies by status is wrong');
      must(/Review<\/td><td>1<\/td><td>1500\.00<\/td>/.test(d.html) && /Filed<\/td><td>2<\/td><td>3450\.00<\/td>/.test(d.html), 'claims by status is wrong');
      must(/2026-08<\/td><td>3<\/td><td>3250\.00<\/td>/.test(d.html) && /2026-07<\/td><td>1<\/td><td>3200\.00<\/td>/.test(d.html), 'claims by month is wrong');
      must(/Alice Brown<\/td><td>3<\/td><td>5650\.00<\/td>/.test(d.html), 'claims by customer is wrong');
      const july = await get('/dashboard/reports?from=2026-07-01&to=2026-07-31');
      must(/<b>1<\/b>Claims/.test(july.html) && /<b>3200\.00<\/b>Claims amount/.test(july.html) && /<b>4<\/b>Customers/.test(july.html), 'the period filter does not narrow the claims to July');
      return 'totals; by type, status, month, customer; July filter';
    } },
  colorCheck('whitesmoke', 'darkcyan'),
];
