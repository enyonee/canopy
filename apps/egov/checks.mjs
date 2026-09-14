// WebGen-Bench 000047 — e-government office: infrastructure, procurement, leave, approvals, finance, decision-making.
import { colorCheck } from '../../verify/lib.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const metric = (html, title) => {
  const m = new RegExp(`<b>([\\d.\\-]+)</b>${title}`).exec(html);
  if (!m) throw new Error(`metric "${title}" is missing`);
  return Number(m[1]);
};
const optionOf = (html, field, label) => {
  const sel = new RegExp(`<select id="f_${field}" name="${field}">([\\s\\S]*?)</select>`).exec(html)?.[1] || '';
  const m = new RegExp(`<option value="(\\d+)"[^>]*>${label}</option>`).exec(sel);
  if (!m) throw new Error(`"${label}" is not offered for ${field}`);
  return m[1];
};
let leaveId = null, decisionId = null;

export const checks = [
  { task: 'Browsing infrastructure shows the asset register with details, filters and a page per asset',
    run: async ({ asGuest, login, get, rows, rowWith, idOf, must }) => {
      asGuest();
      must((await get('/Asset')).location.startsWith('/login'), 'infrastructure is open without a login');
      must((await login('li@egov.test', 'li123')).status === 303, 'staff could not sign in');
      const all = await get('/Asset');
      must(rows(all.html).length === 4, `expected 4 assets, got ${rows(all.html).length}`);
      const tower = rowWith(all.html, 'Civic Center Tower B');
      must(tower && /<td>building<\/td><td>12 Shennan Road<\/td><td>good<\/td><td>2015-06-01<\/td><td>25000000\.00<\/td>/.test(tower) && /Zhang Yan/.test(tower),
        `asset row: ${tower}`);
      const vehicles = await get('/Asset?kind=vehicle');
      must(rows(vehicles.html).length === 1 && /Service van SZ-4471/.test(rows(vehicles.html)[0]), 'the kind filter does not narrow');
      const found = await get('/Asset?q=switch');
      must(rows(found.html).length === 1, 'search does not find the switch rack');
      const detail = await get(`/Asset/${idOf(found.html, 'Core switch rack', 'Asset')}`);
      must(/<th>Location<\/th><td>Data room, floor 3<\/td>/.test(detail.html) && /<th>Value<\/th><td>96000\.00<\/td>/.test(detail.html), 'asset details are missing');
      must(!/href="\/Asset\/new"/.test(all.html) && (await get('/Asset/1/edit')).status === 403, 'staff can change the register');
      return '4 assets with kind, location, condition, value, custodian; filter by kind, search, detail page; read-only for staff';
    } },
  { task: 'A procurement application is submitted with a confirmation and its status is visible in the applicant\'s procurement section',
    run: async ({ get, post, follow, rows, rowWith, must, flashOf }) => {
      const form = await get('/Procurement/new');
      must(!/name="applicant"/.test(form.html) && !/name="status"/.test(form.html), 'the form should not ask for the applicant or the status');
      const r = await follow('/Procurement', { title: 'Laptops for field inspectors', item: 'Laptop', quantity: 6, budget: '54000.00', justification: 'Replacing 2019 units' });
      must(/Procurement application submitted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Laptops for field inspectors');
      must(row && /Li Wei/.test(row) && /<td>Laptop<\/td><td>6<\/td><td>54000\.00<\/td>/.test(row) && /status">Submitted/.test(row) && new RegExp(today()).test(row),
        `application row: ${row}`);
      must(rows(r.html).length === 2 && !/Toner cartridges/.test(r.html), 'the applicant sees applications of other people');
      must(/status">Approved/.test(rowWith(r.html, 'Office chairs for floor 4')), 'the earlier application does not show its approved status');
      const bad = await post('/Procurement', { title: 'Free stuff', item: 'x', quantity: 1, budget: '0' });
      must(bad.status === 400 && /Budget must be positive/.test(bad.html), 'a zero budget was accepted');
      return 'submitted with confirmation; own applications only, with statuses Submitted and Approved';
    } },
  { task: 'A leave application is submitted, confirmed and listed in the applicant\'s leave history with its length',
    run: async ({ post, follow, rows, rowWith, must, flashOf }) => {
      const backwards = await post('/LeaveRequest', { kind: 'annual', startDate: '2026-10-09', endDate: '2026-10-05', reason: 'x' });
      must(backwards.status === 400 && /end date cannot be before the start date/.test(backwards.html), 'a backwards leave was accepted');
      const r = await follow('/LeaveRequest', { kind: 'annual', startDate: '2026-10-05', endDate: '2026-10-09', reason: 'Family visit' });
      must(/Leave application submitted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, '2026-10-05');
      must(row && /Li Wei/.test(row) && /<td>annual<\/td><td>2026-10-05<\/td><td>2026-10-09<\/td><td>5<\/td>/.test(row) && /status">Pending/.test(row),
        `leave row: ${row}`);
      must(rows(r.html).length === 1, 'the history shows other employees\' leave');
      leaveId = /\/LeaveRequest\/(\d+)"/.exec(row)[1];
      return 'pending leave of 5 days in the applicant\'s history; backwards dates refused';
    } },
  { task: 'A manager approves a leave request; the requester is notified and the personnel record reflects it',
    run: async ({ asGuest, login, get, post, follow, rows, rowWith, must, flashOf }) => {
      must((await post(`/LeaveRequest/${leaveId}/go/approve`, {})).status === 403, 'staff could approve their own leave');
      asGuest();
      must((await login('chen@egov.test', 'chen123')).status === 303, 'the manager could not sign in');
      const all = await get('/LeaveRequest?status=pending');
      must(rows(all.html).length === 1 && /go\/approve"/.test(rows(all.html)[0]) === false, 'pending list wrong');
      const r = await follow(`/LeaveRequest/${leaveId}/go/approve`, {});
      must(/Leave approved, Li Wei notified/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/status">Approved/.test(r.html) && !/go\/approve"/.test(r.html), 'the request is not approved');
      const outbox = await get('/outbox');
      const mail = rows(outbox.html).find((x) => /Your leave request was approved/.test(x));
      must(mail && /<td>li@egov.test<\/td>/.test(mail) && /2026-10-05 to 2026-10-09 \(5 days\)/.test(mail), `no letter to the requester: ${mail?.slice(0, 200)}`);
      const personnel = await get('/User');
      must(/Li Wei.*<td>5<\/td>/.test(rowWith(personnel.html, 'Li Wei')) && /<td>5<\/td>/.test(rowWith(personnel.html, 'Zhang Yan')), 'approved leave days are not on the personnel record');
      must(/<td>0<\/td>/.test(rowWith(personnel.html, 'Chen Ming')), 'the manager has leave days without a request');
      return 'approved by the manager; letter to li@egov.test; personnel record shows 5 leave days';
    } },
  { task: 'Querying financial reports for a period returns totals by category, month and department',
    run: async ({ get, rows, must }) => {
      const q1 = await get('/dashboard/finance?from=2026-01-01&to=2026-03-31');
      must(q1.status === 200, `financial reports returned ${q1.status}`);
      must(metric(q1.html, 'Income') === 1200000 && metric(q1.html, 'Expenses') === 705000 && metric(q1.html, 'Entries') === 4, 'Q1 totals are wrong');
      must(/Salaries<\/td><td>2<\/td><td>620000\.00<\/td>/.test(q1.html), 'salaries by category is wrong');
      must(/2026-03<\/td><td>1<\/td><td>85000\.00<\/td>/.test(q1.html), 'March by month is wrong');
      must(/Infrastructure Office<\/td><td>85000\.00<\/td>/.test(q1.html), 'by department is wrong');
      must(!/Procurement Office/.test(q1.html), 'a July entry shows in the Q1 report');
      const all = await get('/dashboard/finance');
      must(metric(all.html, 'Expenses') === 737000, 'all-time expenses are wrong');
      const ledger = await get('/FinanceRecord?category=procurement');
      must(rows(ledger.html).length === 1 && /Office chairs/.test(rows(ledger.html)[0]), 'the ledger cannot be queried by category');
      return 'Q1: income 1200000.00, expenses 705000.00; by category, month, department; ledger query by category';
    } },
  { task: 'A decision is initiated and submitted for internal review; the parties are notified and the stages are visible',
    run: async ({ asGuest, login, get, post, follow, rows, must, flashOf }) => {
      asGuest();
      await login('zhang@egov.test', 'zhang123');
      const form = await get('/Decision/new');
      const reviewer = optionOf(form.html, 'reviewer', 'Chen Ming');
      const made = await post('/Decision', { title: 'Relocate the citizen service hall', power: 'execution', reviewer, summary: 'Move the hall to the ground floor of Tower B to shorten queues.' });
      must(made.status === 303 && /\/Decision\/\d+/.test(made.location), `initiating returned ${made.status}: ${made.html.slice(0, 200)}`);
      decisionId = /\/Decision\/(\d+)/.exec(made.location)[1];
      let page = await get(made.location);
      must(/Decision drafted/.test(flashOf(page.html)) && /status">Draft/.test(page.html) && /<th>Power<\/th><td>execution<\/td>/.test(page.html), 'the draft is not shown with its stage');
      must((await post(`/Decision/${decisionId}/go/approve`, { verdict: 'x' })).status === 403, 'the initiator could approve their own decision');
      page = await follow(`/Decision/${decisionId}/go/submit`, {});
      must(/Submitted for review/.test(flashOf(page.html)) && /status">Review/.test(page.html), 'the decision did not move to review');
      must(!/go\/submit"/.test(page.html), 'submit is still offered after submitting');
      asGuest();
      await login('chen@egov.test', 'chen123');
      let mails = rows((await get('/outbox')).html).filter((x) => /Relocate the citizen service hall/.test(x));
      must(mails.length === 2 && mails.some((m) => /<td>chen@egov.test<\/td>/.test(m) && /awaiting your review/.test(m)) && mails.some((m) => /<td>zhang@egov.test<\/td>/.test(m)),
        `expected letters to the reviewer and the initiator, got ${mails.length}`);
      page = await follow(`/Decision/${decisionId}/go/approve`, { verdict: 'Approved; move in Q1 next year' });
      must(/status">Approved/.test(page.html) && new RegExp(`<th>Decided At</th><td>${today()}</td>`).test(page.html) && /Approved; move in Q1 next year/.test(page.html),
        'the approval stage is not recorded');
      mails = rows((await get('/outbox')).html).filter((x) => /Decision approved: Relocate/.test(x));
      must(mails.length === 1 && /<td>zhang@egov.test<\/td>/.test(mails[0]), 'the initiator was not told of the approval');
      return 'draft → review (2 letters: reviewer, initiator) → approved with verdict and date (letter to initiator)';
    } },
  colorCheck('lightpink', 'mediumvioletred'),
];
