// WebGen-Bench 000023 — sales leads CRM. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let leadId = null;

export const checks = [
  { task: 'The "Add New Lead" form takes the details and the lead is added to the system',
    run: async ({ get, post, rowWith, idOf, must, flashOf }) => {
      const form = await get('/Lead/new');
      must(form.status === 200 && /<h2>Add New Lead<\/h2>/.test(form.html), 'the Add New Lead form is missing');
      const select = /<select id="f_category" name="category">([\s\S]*?)<\/select>/.exec(form.html)?.[1] || '';
      must(/>Enterprise</.test(select) && />Small business</.test(select) && />Partner</.test(select), 'the category dropdown is not fed from the settings');
      must(!/name="status"/.test(form.html), 'the status is offered on the form although transitions own it');
      const bad = await post('/Lead', { name: 'No mail', category: 1 });
      must(bad.status === 400 && /email is required/.test(bad.html), 'a lead without an email was accepted');
      const r = await post('/Lead', { name: 'Dana Pike', company: 'Pike & Co', email: 'dana@pike.test', phone: '+1 555 0500', category: 1, source: 'referral', value: '15000', notes: 'Met at the expo' });
      must(r.status === 303, `submitting the form returned ${r.status}: ${r.html.slice(0, 300)}`);
      const list = await get(r.location);
      must(/Lead added successfully/.test(flashOf(list.html)), `no confirmation: ${flashOf(list.html)}`);
      const row = rowWith(list.html, 'Dana Pike');
      must(row && /Pike &amp; Co/.test(row) && /Enterprise/.test(row) && /15000\.00/.test(row) && /status">New</.test(row), `the lead row is wrong: ${row}`);
      leadId = idOf(list.html, 'Dana Pike', 'Lead');
      const dup = await post('/Lead', { name: 'Dana again', email: 'dana@pike.test', category: 1 });
      must(dup.status === 400 && /A lead with this email already exists/.test(dup.html), 'a duplicate lead email was accepted');
      return 'form submitted, lead listed as new with category and value; email required and unique';
    } },
  { task: 'Initiating a message to a specific lead sends it automatically and shows a confirmation',
    run: async ({ get, follow, rows, must, flashOf }) => {
      const before = rows((await get('/outbox')).html).filter((x) => /dana@pike.test/.test(x));
      must(before.length === 1 && /Welcome, Dana Pike/.test(before[0]) && /dedicated account manager/.test(before[0]), `the automated welcome letter was not sent on creation: ${before.length}`);
      const r = await follow(`/Lead/${leadId}/action/message`, {});
      must(/Message sent to dana@pike.test/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      must(new RegExp(`<h2>Dana Pike</h2>`).test(r.html), 'the confirmation is not shown on the lead');
      const outbox = await get('/outbox');
      const letters = rows(outbox.html).filter((x) => /dana@pike.test/.test(x));
      must(letters.length === 2, `expected 2 letters to the lead, got ${letters.length}`);
      must(/Following up, Dana Pike/.test(letters[0]) && /dedicated account manager/.test(letters[0]) && /status">sent</.test(letters[0]), `the follow-up letter is wrong: ${letters[0].slice(0, 300)}`);
      return 'welcome letter on creation; follow-up letter sent from the category pitch; both recorded as sent';
    } },
  { task: "Modifying an existing lead's status updates it and the profile shows the new status",
    run: async ({ get, post, follow, must, flashOf }) => {
      const skip = await post(`/Lead/${leadId}/go/qualify`, {});
      must(skip.status === 409, `qualifying a new lead returned ${skip.status}`);
      let r = await follow(`/Lead/${leadId}/go/contact`, {});
      must(/Status updated: Dana Pike is now contacted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Status<\/th><td><span class="status">Contacted<\/span>/.test(r.html), 'the profile does not show the new status');
      must(!/go\/contact"/.test(r.html) && /go\/qualify"/.test(r.html), 'the offered transitions do not follow the status');
      r = await follow(`/Lead/${leadId}/go/qualify`, {});
      must(/<th>Status<\/th><td><span class="status">Qualified<\/span>/.test(r.html), 'the second status change is not shown');
      const list = await get('/Lead?status=qualified');
      must(/Dana Pike/.test(list.html) && !/Hal Helio/.test(list.html), 'the status filter does not follow the change');
      return 'new → contacted → qualified shown on the profile; skipped step 409; filter follows';
    } },
  { task: 'The menu opens the best practice and integration advice page',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      const link = /<a href="(\/page\/advice)">Advice<\/a>/.exec(nav);
      must(link, 'the menu has no advice item');
      const page = await get(link[1]);
      must(page.status === 200 && /<h2>Best practice and integration advice<\/h2>/.test(page.html), `the advice page returned ${page.status}`);
      must((page.html.match(/<p>Best practice:/g) || []).length >= 3 && (page.html.match(/<p>Integration advice:/g) || []).length >= 2, 'the page lacks best practice or integration advice');
      must(/href="\/Lead"/.test(page.html) && /href="\/dashboard\/reports"/.test(page.html), 'the page does not link back to leads and reports');
      must((await get('/dashboard/reports')).html.includes('<b>5</b>Leads'), 'the reports page does not count the leads');
      return 'advice page from the menu: 3 best practices, 2 integration notes, links to leads and reports';
    } },
  colorCheck('papayawhip', 'darkorange'),
];
