// webgen-bench/000082 — food distribution: donations, applications, volunteers, own account.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let applicationId = null, benProfile = null, miaProfile = null;

export const checks = [
  { task: 'Navigate to the food donation section and view available food donations',
    run: async ({ asGuest, get, rows, rowWith, must }) => {
      asGuest();
      const { html, status } = await get('/Donation');
      must(status === 200, `donations returned ${status}`);
      must(/<th>(?:<a[^>]*>)?Food/.test(html) && /<th>(?:<a[^>]*>)?Quantity/.test(html) && /<th>(?:<a[^>]*>)?Expires/.test(html), 'food, quantity or expiry column is missing');
      must(rows(html).length === 4, `expected 4 available donations, got ${rows(html).length}`);
      const apples = rowWith(html, 'Apples');
      must(apples && /<td>produce<\/td>/.test(apples) && /<td>40<\/td>/.test(apples) && /2026-09-30/.test(apples) && /Green Farm/.test(apples), `apples row: ${apples}`);
      must(!rowWith(html, 'Hot meals'), 'a claimed donation is listed as available');
      const bakery = await get('/Donation?kind=bakery');
      must(rows(bakery.html).length === 1 && rowWith(bakery.html, 'Bread loaves'), 'the kind filter does not narrow');
      const q = await get('/Donation?q=dairy');
      must(rows(q.html).length === 1 && rowWith(q.html, 'Milk'), 'search by donor does not narrow');
      const detail = await get('/Donation/1');
      must(/<th>Donor<\/th><td>Green Farm<\/td>/.test(detail.html) && /<th>Expires<\/th><td>2026-09-30<\/td>/.test(detail.html), 'the donation detail lacks donor or expiry');
      return '4 available donations with kind, quantity, expiry; claimed hidden; kind filter and search narrow';
    } },
  { task: 'Submit a food distribution application form with valid details',
    run: async ({ asGuest, post, get, follow, rows, rowWith, must, flashOf }) => {
      asGuest();
      const reg = await post('/register', { email: 'ben@food.test', password: 'ben123', name: 'Ben' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const form = await get('/Application/new');
      must(form.status === 200 && /<select[^>]*name="donation"/.test(form.html) && !/name="applicant"/.test(form.html), 'the application form is wrong');
      const bad = await post('/Application', { donation: 1, household: 0 });
      must(bad.status === 400 && /Household size must be at least 1/.test(bad.html), 'a household of 0 was accepted');
      const p = await post('/Application', { donation: 1, household: 3, note: 'Two kids' });
      must(p.status === 303 && p.location.startsWith('/list/my-applications'), `application post: ${p.status} ${p.location}`);
      const r = await get(p.location);
      must(/Application submitted/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      const mine = rows(r.html);
      must(mine.length === 1 && /Apples/.test(mine[0]) && /<td>3<\/td>/.test(mine[0]) && /status">Submitted/.test(mine[0]), `my applications: ${mine.map((x) => x.slice(0, 120))}`);
      applicationId = /\/Application\/(\d+)/.exec(mine[0])[1];
      const all = await get('/Application');
      must(rows(all.html).length === 1, 'a member sees applications of other people');
      must(/<th>Requests<\/th><td>1<\/td>/.test((await get('/Donation/1')).html), 'the donation does not count the request');
      return 'registered, rule enforced, application recorded under My applications as Submitted';
    } },
  { task: 'View the volunteer information page',
    run: async ({ get, follow, rows, rowWith, idOf, must, flashOf }) => {
      const { html, status } = await get('/Opportunity');
      must(status === 200 && rows(html).length === 3, `expected 3 opportunities, got ${rows(html).length}`);
      const driver = rowWith(html, 'Delivery driver');
      must(driver && /2026-09-27/.test(driver) && /<td>2<\/td><td>0<\/td><td>2<\/td>/.test(driver), `driver row: ${driver}`);
      const sorting = idOf(html, 'Warehouse sorting', 'Opportunity');
      const detail = await get(`/Opportunity/${sorting}`);
      must(/<th>Description<\/th><td>Sort incoming donations/.test(detail.html) && /<th>Requirements<\/th><td>Able to lift 15 kg/.test(detail.html), 'description or requirements missing');
      must(/<th>Volunteers<\/th><td>1<\/td>/.test(detail.html) && /<th>Open<\/th><td>5<\/td>/.test(detail.html), 'the derived counts are wrong');
      const r = await follow(`/Opportunity/${sorting}/action/volunteer`, {});
      must(/You signed up for Warehouse sorting/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Volunteers<\/th><td>2<\/td>/.test(r.html) && /<th>Open<\/th><td>4<\/td>/.test(r.html), 'the sign-up did not change the counts');
      return '3 opportunities with role description and requirements; sign-up counts 1 → 2';
    } },
  { task: "Edit account information by updating the user's contact details",
    run: async ({ get, post, follow, rows, must, flashOf }) => {
      const account = await get('/list/account');
      must(account.status === 200 && rows(account.html).length === 1 && /ben@food.test/.test(rows(account.html)[0]), 'the account page does not show my profile');
      benProfile = /\/Profile\/(\d+)\/edit/.exec(rows(account.html)[0])[1];
      const form = await get(`/Profile/${benProfile}/edit`);
      must(form.status === 200 && /name="phone"/.test(form.html) && !/name="user"/.test(form.html), 'the account form is wrong');
      const r = await follow(`/Profile/${benProfile}`, { phone: '+1 555 0199', address: '9 Elm st', dietary: 'halal' });
      must(/Account updated/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rows(r.html)[0];
      must(/\+1 555 0199/.test(row) && /9 Elm st/.test(row) && /halal/.test(row) && /<td>1<\/td>/.test(row), `account row after edit: ${row}`);
      const detail = await get(`/Profile/${benProfile}`);
      must(/<th>Phone<\/th><td>\+1 555 0199<\/td>/.test(detail.html), 'the detail does not show the new phone');
      miaProfile = 2;
      must((await get(`/Profile/${miaProfile}/edit`)).status === 403, "ben opened mia's account");
      must((await post(`/Profile/${miaProfile}`, { phone: '0' })).status === 403, "ben edited mia's account");
      return 'phone, address, dietary saved and shown; another member\'s account is 403';
    } },
  navCheck(4),
  colorCheck('azure', 'midnightblue'),
];

export const changes = [
  { title: 'coordinator role: handles donations and applications, no users, dashboard or outbox', patch: 'change-role.patch.json', checks: [
    { task: 'The admin creates a coordinator; the coordinator approves the existing application and edits donations but cannot reach users, the dashboard or the outbox',
      run: async ({ asGuest, login, post, get, follow, rows, rowWith, must }) => {
        asGuest();
        must((await login('admin@food.test', 'admin123')).status === 303, 'admin could not log in');
        const made = await post('/User', { email: 'cora@food.test', password: 'cora123', name: 'Cora', role: 'coordinator' });
        must(made.status === 303, `creating the coordinator returned ${made.status}: ${made.html.slice(0, 200)}`);
        asGuest();
        must((await login('cora@food.test', 'cora123')).status === 303, 'the coordinator could not log in');
        const apps = await get('/Application');
        must(apps.status === 200 && rows(apps.html).length === 2, `the coordinator sees ${rows(apps.html).length} applications, expected 2 (seeded + Ben's)`);
        must(rowWith(apps.html, 'ben@food.test'), "Ben's application from the base run is gone");
        const r = await follow(`/Application/${applicationId}/go/approve`, {});
        must(/status">Approved/.test(r.html), 'the coordinator could not approve');
        // Round 5's db.set (an update on an arbitrary row named by entity+id,
        // not only the current one) closes the "no step updates a referenced
        // row" Miss: approving an application now marks its own donation
        // claimed automatically, instead of that staying a fully manual edit.
        must(/<th>Status<\/th><td>claimed<\/td>/.test((await get('/Donation/1')).html),
          'approving an application did not mark its donation claimed');
        const edited = await post('/Donation/1', { food: 'Apples', donor: 'Green Farm', kind: 'produce', quantity: 35, unit: 'kg', expires: '2026-09-30', location: 'North depot', status: 'available' });
        must(edited.status === 303, `the coordinator could not edit a donation: ${edited.status}`);
        must(/<td>35<\/td>/.test(rowWith((await get('/Donation')).html, 'Apples')), 'the edited quantity is not shown');
        const delivered = await follow(`/Application/${applicationId}/go/deliver`, {});
        must(/status">Delivered/.test(delivered.html), 'the coordinator could not mark the application delivered');
        must(/<th>Status<\/th><td>distributed<\/td>/.test((await get('/Donation/1')).html),
          'marking the application delivered did not mark its donation distributed');
        must((await post('/Donation/1/delete', {})).status === 403, 'the coordinator deleted a donation');
        must((await get('/User')).status === 403, 'the coordinator listed the users');
        must((await get('/dashboard/overview')).status === 403, 'the coordinator opened the dashboard');
        must((await get('/outbox')).status === 403, 'the coordinator opened the outbox');
        must((await get('/list/all-donations')).status === 403, "the coordinator opened the admin's donation list");
        must((await get(`/Profile/${benProfile}/edit`)).status === 403, "the coordinator edited a member's account");
        return 'coordinator: sees both applications, approves, edits a donation; delete, users, dashboard, outbox 403';
      } },
  ] },
];
