// webgen-bench/000085 — construction management: schedule, messages, costing, time, resources, progress.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the project scheduling feature and create a new project timeline',
    run: async ({ asGuest, login, post, get, follow, rows, must, flashOf }) => {
      asGuest();
      must((await login('maria@construction.test', 'maria123')).status === 303, 'the project manager could not log in');
      const created = await post('/Project', { name: 'Elm Street Bridge', client: 'County Highways', description: 'Single-span pedestrian bridge replacement.',
        startDate: '2026-11-01', endDate: '2027-02-15', budget: 95000, status: 'planning', manager: 2 });
      must(created.status === 303, `creating a project returned ${created.status}: ${created.html.slice(0, 200)}`);
      const id = /\/Project\/(\d+)/.exec(created.location)[1];
      const r = await get(created.location);
      must(/Project created/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Name<\/th><td>Elm Street Bridge<\/td>/.test(r.html) && /<th>Start Date<\/th><td>2026-11-01<\/td>/.test(r.html) && /<th>End Date<\/th><td>2027-02-15<\/td>/.test(r.html),
        `new project page: ${r.html.slice(0, 400)}`);
      const t1 = await follow(`/Project/${id}/add/Task`, { title: 'Demolish old bridge deck', dueDate: '2026-11-20' });
      must(/Task added/.test(flashOf(t1.html)), `task add flash: ${flashOf(t1.html)}`);
      const t2 = await follow(`/Project/${id}/add/Task`, { title: 'Pour new deck', dueDate: '2026-12-15' });
      must(rows(t2.html).some((row) => row.includes('Demolish old bridge deck')) && rows(t2.html).some((row) => row.includes('Pour new deck')),
        `project schedule after adding two tasks: ${t2.html}`);
      must(/<th>Task Count<\/th><td>2<\/td>/.test(t2.html), 'the new project does not count its two scheduled tasks');
      return `project #${id} "Elm Street Bridge" saved with a start/end date; both scheduled tasks appear in its task list`;
    } },

  { task: 'Use the communication tool to send a message to a team member',
    run: async ({ asGuest, login, get, follow, rowWith, must, flashOf }) => {
      const before = Date.now();
      const sent = await follow('/Message', { recipient: 3, project: 1, body: 'Please bring the updated drawings tomorrow.' });
      must(/Message sent/.test(flashOf(sent.html)), `flash: ${flashOf(sent.html)}`);
      // Round 4 (item 1): own may now name several fields, so Maria (the sender) sees her own
      // sent message too — a real two-party inbox, not the old shared team log.
      const mariaOwn = await get('/Message');
      must(rowWith(mariaOwn.html, 'Please bring the updated drawings tomorrow.'), 'Maria (the sender) cannot see the message she just sent');
      asGuest();
      must((await login('sam@construction.test', 'sam123')).status === 303, 'the recipient could not log in');
      const inbox = await get('/list/inbox');
      must(inbox.status === 200, `inbox returned ${inbox.status}`);
      const row = rowWith(inbox.html, 'Please bring the updated drawings tomorrow.');
      must(row && /maria@construction\.test/.test(row), `inbox row: ${row}`);
      const ts = /<td>(20\d\d-\d\d-\d\dT[\d:.]+Z)<\/td>/.exec(row)[1];
      must(new Date(ts).getTime() >= before, `the message timestamp looks wrong: ${ts}`);
      must(rowWith((await get('/Message')).html, 'Please bring the updated drawings tomorrow.'), 'Sam (the recipient) cannot see it through the base /Message route either, only the fixed-where inbox list');
      return "Maria's message to Sam appears in Sam's inbox, correctly timestamped and attributed to Maria, and in Sam's own /Message too";
    } },

  { task: 'Input estimated project costs using the estimating feature',
    run: async ({ asGuest, login, follow, must, flashOf }) => {
      asGuest();
      must((await login('maria@construction.test', 'maria123')).status === 303, 'could not log back in as the manager');
      const r = await follow('/Project/1/add/CostItem', { category: 'Permits', description: 'Building and occupancy permits', estimatedAmount: 15000, actualAmount: 2000 });
      must(/Cost item added/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      // seeded: Labor 500000 + Materials 800000 = 1300000, plus the new 15000 = 1315000
      must(/<th>Estimated Total<\/th><td>1315000\.00<\/td>/.test(r.html), `financial overview after adding a cost item: ${r.html.slice(0, 500)}`);
      must(/<th>Actual Total<\/th><td>422000\.00<\/td>/.test(r.html), `actual total: ${r.html.slice(0, 500)}`);
      return "a new cost estimate (Permits, 15000) is added; the project's estimated total updates from 1,300,000.00 to 1,315,000.00";
    } },

  { task: 'Track time spent on a particular project using the time tracking tool',
    run: async ({ get, post, follow, rowWith, must, flashOf }) => {
      const before = await get('/Project/1');
      const beforeHours = Number(/<th>Total Hours<\/th><td>(\d+)<\/td>/.exec(before.html)[1]);
      // Round 4 (item 3): the related form no longer asks for "project" at all — it is
      // silently filled from the parent Task's own row — so there is no "wrong project" to
      // submit any more; attempting one (a client posting a stray "project" directly) is
      // simply ignored in favour of the real one, not merely caught by the rule afterwards.
      const overridden = await post('/Task/3/add/TimeEntry', { project: 2, date: '2026-09-25', hours: 4, notes: 'Attempted override' });
      must(overridden.status === 303, `logging time was refused even though "project" cannot mismatch any more: ${overridden.status}`);
      const sheetAfterOverride = await get('/list/my-timesheet');
      const overriddenRow = rowWith(sheetAfterOverride.html, 'Attempted override');
      must(overriddenRow && /Riverside Office Tower/.test(overriddenRow) && !/Maple Street Renovation/.test(overriddenRow),
        `the submitted "project: 2" leaked through instead of being silently replaced by the task's own: ${overriddenRow}`);
      const r = await follow('/Task/3/add/TimeEntry', { date: '2026-09-25', hours: 5, notes: 'HVAC ductwork rough-in' });
      must(/Time logged/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(rowWith(r.html, 'HVAC ductwork rough-in'), 'the new time entry is not shown on the task');
      const after = await get('/Project/1');
      const afterHours = Number(/<th>Total Hours<\/th><td>(\d+)<\/td>/.exec(after.html)[1]);
      must(afterHours === beforeHours + 4 + 5, `expected total hours ${beforeHours} + 4 + 5, got ${afterHours}`);
      const sheet = await get('/list/my-timesheet');
      must(rowWith(sheet.html, 'HVAC ductwork rough-in'), 'the logged time is not accessible for review in the timesheet');
      return `9 hours logged on the HVAC task (4 with an ignored project override, 5 plain); the project's total hours went from ${beforeHours} to ${afterHours}; visible in My Timesheet`;
    } },

  { task: 'Access and manage resources in the resource management section',
    run: async ({ get, post, follow, must, flashOf }) => {
      const before = await get('/Resource/1');
      must(/<th>Capacity<\/th><td>2<\/td>/.test(before.html) && /<th>Allocated<\/th><td>1<\/td>/.test(before.html) && /<th>Available<\/th><td>1<\/td>/.test(before.html),
        `tower crane before allocating: ${before.html.slice(0, 400)}`);
      const r = await follow('/Resource/1/add/ResourceAllocation', { project: 2, quantity: 1 });
      must(/Resource allocated/.test(flashOf(r.html)), `allocation flash: ${r.html.slice(0, 200)}`);
      must(/<th>Allocated<\/th><td>2<\/td>/.test(r.html) && /<th>Available<\/th><td>0<\/td>/.test(r.html), `tower crane after allocating: ${r.html.slice(0, 400)}`);
      const over = await post('/Resource/1/add/ResourceAllocation', { project: 2, quantity: 1 });
      must(over.status === 400 && /Not enough of this resource is available/.test(over.html), `over-allocating past capacity was accepted: ${over.status}`);
      return 'allocating the last available tower crane takes availability from 1 to 0; a further allocation past capacity is refused';
    } },

  { task: 'Validate project progress tracking feature by marking a task as complete',
    run: async ({ get, follow, must }) => {
      const before = await get('/Project/1');
      must(/<th>Completed Tasks<\/th><td>1<\/td>/.test(before.html) && /<th>Progress Percent<\/th><td>33<\/td>/.test(before.html),
        `progress before completing a task: ${before.html.slice(0, 400)}`);
      const r = await follow('/Task/2/go/complete', {});
      must(/marked complete/.test(r.html) || r.status === 200, `completing the task: ${r.html.slice(0, 200)}`);
      const after = await get('/Project/1');
      must(/<th>Completed Tasks<\/th><td>2<\/td>/.test(after.html) && /<th>Progress Percent<\/th><td>67<\/td>/.test(after.html),
        `progress after completing a second task: ${after.html.slice(0, 400)}`);
      return "marking 'Erect steel frame' complete moves the project from 1/3 (33%) to 2/3 (67%) tasks done";
    } },

  colorCheck('lightgray', 'darkred'),
];
