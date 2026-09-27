// webgen-bench/000083 — detective agency case management: cases, reports, hours, expense sheet.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify that case information is displayed accurately and can be browsed',
    run: async ({ asGuest, login, get, rows, rowWith, must }) => {
      asGuest();
      must((await login('jordan@detective.test', 'jordan123')).status === 303, 'jordan could not log in');
      const list = await get('/Case');
      must(list.status === 200 && rows(list.html).length === 2, `expected 2 cases, got ${rows(list.html).length}`);
      must(rowWith(list.html, 'The Hartley Disappearance') && rowWith(list.html, 'Bellview Insurance Fraud'), 'both cases should be listed');
      const hartley = await get('/Case/1');
      must(/<th>Client<\/th><td>Eleanor Hartley<\/td>/.test(hartley.html) && /docks/.test(hartley.html) && /<th>Status<\/th><td>active<\/td>/.test(hartley.html),
        `Hartley case detail wrong: ${hartley.html.slice(0, 900)}`);
      const bellview = await get('/Case/2');
      must(/<th>Client<\/th><td>Bellview Mutual<\/td>/.test(bellview.html) && /staged burglary/.test(bellview.html) && /<th>Status<\/th><td>open<\/td>/.test(bellview.html),
        `Bellview case detail wrong: ${bellview.html.slice(0, 900)}`);
      return 'both cases browsed; each detail page shows its own correct client, description and status';
    } },
  { task: 'Attempt to submit a real-time report on a case',
    run: async ({ follow, rowWith, must, flashOf }) => {
      const r = await follow('/Case/1/add/Report', { body: "Followed up with the van's registered owner; he denies involvement but seemed evasive." });
      must(/Report submitted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, "denies involvement");
      must(row && /jordan@detective\.test/.test(row), `new report not in the case's report history: ${row}`);
      must(/<th>Report Count<\/th><td>2<\/td>/.test(r.html), `report count did not update: ${r.html.slice(0, 900)}`);
      return 'report submitted with a confirmation and listed in the case report history (2 reports now)';
    } },
  { task: 'Log work hours for a specific case',
    run: async ({ follow, rowWith, must, flashOf }) => {
      const r = await follow('/Case/1/add/TimeLog', { hours: 2.25, date: '2026-09-10', notes: 'Van owner interview' });
      must(/Hours logged/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Van owner interview');
      must(row && /<td>2\.25<\/td>/.test(row), `new time log not shown: ${row}`);
      must(/<th>Total Hours<\/th><td>5\.75<\/td>/.test(r.html), `total hours did not update in real time: ${r.html.slice(0, 900)}`);
      return 'work hours logged; total hours on the case updated immediately from 3.50 to 5.75';
    } },
  { task: 'Generate an estimated expense sheet for a particular case',
    run: async ({ get, must }) => {
      const detail = await get('/Case/1');
      must(/<th>Hourly Rate<\/th><td>75\.00<\/td>/.test(detail.html), `hourly rate missing: ${detail.html.slice(0, 900)}`);
      must(/<th>Misc Expenses<\/th><td>150\.00<\/td>/.test(detail.html), `misc expenses missing: ${detail.html.slice(0, 900)}`);
      must(/<th>Total Hours<\/th><td>5\.75<\/td>/.test(detail.html), `total hours missing from the sheet: ${detail.html.slice(0, 900)}`);
      must(/<th>Labor Cost<\/th><td>431\.25<\/td>/.test(detail.html), `labor cost wrong (5.75 x 75.00): ${detail.html.slice(0, 900)}`);
      must(/<th>Estimated Expense<\/th><td>581\.25<\/td>/.test(detail.html), `estimated expense wrong (431.25 + 150.00): ${detail.html.slice(0, 900)}`);
      return 'expense sheet: rate 75.00, hours 5.75, labor cost 431.25, misc 150.00, total estimated expense 581.25';
    } },
  { task: 'Access the service assignment sheet and ensure it is displayed correctly',
    run: async ({ get, must }) => {
      const detail = await get('/Case/1');
      must(/<h3>Service assignment sheet<\/h3>/.test(detail.html), 'no service assignment sheet section on the case page');
      must(/jordan@detective\.test/.test(detail.html) && /Lead investigator/.test(detail.html), `assignment sheet missing Jordan's assignment: ${detail.html.slice(0, 900)}`);
      const unassigned = await get('/Case/2');
      must(/<h3>Service assignment sheet<\/h3>/.test(unassigned.html), 'the assignment sheet section should still appear even with nobody assigned yet');
      return "Hartley's assignment sheet lists Jordan Vance as Lead investigator; Bellview's is present but empty";
    } },
  { task: 'Test the navigation functionality from the case management screen back to the dashboard',
    run: async ({ get, must }) => {
      const fromCase = await get('/Case/1');
      must(/href="\/dashboard\/overview"/.test(fromCase.html), 'no link back to the dashboard from the case screen');
      const dash = await get('/dashboard/overview');
      must(dash.status === 200, `dashboard returned ${dash.status}`);
      must(/<b>2<\/b>Open cases/.test(dash.html), `open-cases card wrong: ${dash.html.slice(0, 900)}`);
      must(/<b>5\.75<\/b>Hours logged/.test(dash.html), `hours-logged card wrong: ${dash.html.slice(0, 900)}`);
      must(/<b>2<\/b>Reports filed/.test(dash.html), `reports-filed card wrong: ${dash.html.slice(0, 900)}`);
      return 'navigated from the case screen back to the agency dashboard without errors';
    } },
  colorCheck('beige', 'saddlebrown'),
];
