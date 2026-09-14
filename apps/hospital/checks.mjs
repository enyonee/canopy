// WebGen-Bench 000046 — hospital management: patient files, fees and finances, reports, daily reports, pharmacy, claims, laboratory, theater.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const metric = (html, title) => {
  const m = new RegExp(`<b>([\\d.\\-]+)</b>${title}`).exec(html);
  if (!m) throw new Error(`metric "${title}" is missing`);
  return Number(m[1]);
};
const sectionRows = (html, title) => {
  const part = html.split(`<h3>${title}</h3>`)[1];
  if (!part) throw new Error(`section "${title}" is missing`);
  return [...part.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
};
const stockOf = (row) => Number(/<td>(\d+)<\/td>/.exec(row)?.[1]);
// The value a form's <select> offers for a label: how a user picks a superior or a surgeon.
const optionOf = (html, field, label) => {
  const sel = new RegExp(`<select id="f_${field}" name="${field}">([\\s\\S]*?)</select>`).exec(html)?.[1] || '';
  const m = new RegExp(`<option value="(\\d+)"[^>]*>${label}</option>`).exec(sel);
  if (!m) throw new Error(`"${label}" is not offered for ${field}`);
  return m[1];
};
let patientId = null, adminId = null;

export const checks = [
  { task: 'A staff member creates a patient electronic file with name, visit date, diagnosis and comments, and retrieves it later',
    run: async ({ asGuest, login, post, get, rowWith, must, flashOf }) => {
      asGuest();
      must((await get('/Patient')).location.startsWith('/login'), 'the patient section is open without a login');
      must((await login('nina@hospital.test', 'nina123')).status === 303, 'staff could not sign in');
      const made = await post('/Patient', { name: 'Lucas Brandt', visitDate: '2026-09-14', diagnosis: 'Acute bronchitis', comments: 'Prescribed rest and fluids; review in a week', phone: '+1 555 0204' });
      must(made.status === 303 && /\/Patient\/\d+/.test(made.location), `saving the file returned ${made.status}: ${made.html.slice(0, 200)}`);
      patientId = /\/Patient\/(\d+)/.exec(made.location)[1];
      const detail = await get(made.location);
      must(/Patient file saved/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      for (const [k, v] of [['Name', 'Lucas Brandt'], ['Visit Date', '2026-09-14'], ['Diagnosis', 'Acute bronchitis'], ['Comments', 'Prescribed rest and fluids; review in a week']])
        must(new RegExp(`<th>${k}</th><td>${v}</td>`).test(detail.html), `${k} is not stored as entered`);
      const missing = await post('/Patient', { name: 'No diagnosis', visitDate: '2026-09-14' });
      must(missing.status === 400 && /diagnosis is required/.test(missing.html), 'a file without a diagnosis was accepted');
      const found = await get('/Patient?q=Brandt');
      const row = rowWith(found.html, 'Lucas Brandt');
      must(row && /2026-09-14/.test(row) && /Acute bronchitis/.test(row), 'the file cannot be found again by name');
      must((await get(`/Patient/${patientId}`)).status === 200, 'the file cannot be reopened');
      return `file #${patientId} saved with all four fields; found by search; diagnosis required`;
    } },
  { task: 'Collecting a patient fee marks it paid and writes the transaction into the financial records',
    run: async ({ get, post, follow, idOf, rowWith, must, flashOf }) => {
      const fees = await get('/Fee?status=unpaid');
      const fee = idOf(fees.html, 'Maria Santos', 'Fee');
      must(/<th>Due<\/th><td>150\.00<\/td>/.test((await get('/Patient/1')).html), 'the patient does not owe 150.00 before paying');
      const noMethod = await post(`/Fee/${fee}/go/pay`, {});
      must(noMethod.status === 400 && /method is required/.test(noMethod.html), 'a payment without a method was accepted');
      const r = await follow(`/Fee/${fee}/go/pay`, { method: 'card' });
      must(/Payment of 150\.00 received from Maria Santos/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/status">Paid/.test(r.html) && /<th>Method<\/th><td>card<\/td>/.test(r.html), 'the fee is not marked paid by card');
      must((await post(`/Fee/${fee}/go/pay`, { method: 'cash' })).status === 409, 'a paid fee could be paid again');
      const ledger = await get('/Transaction');
      const row = rowWith(ledger.html, 'Consultation (card)');
      must(row && /<td>income<\/td><td>Patient fee<\/td><td>150\.00<\/td>/.test(row) && /Maria Santos/.test(row) && new RegExp(`<td>${today()}</td>`).test(row),
        `the transaction is not in the financial records: ${row}`);
      must(/<th>Due<\/th><td>0\.00<\/td>/.test((await get('/Patient/1')).html), 'the patient balance did not drop to 0.00');
      return 'paid by card; ledger row 150.00 today; patient due 150.00 → 0.00; second payment 409';
    } },
  { task: 'The financial report reflects the ledger, including the payment just collected, and narrows to a period',
    run: async ({ asGuest, login, get, must }) => {
      must((await get('/dashboard/finance')).status === 403, 'staff opened the financial report');
      asGuest();
      await login('admin@hospital.test', 'admin123');
      const d = await get('/dashboard/finance');
      must(d.status === 200, `financial report returned ${d.status}`);
      must(metric(d.html, 'Income') === 5370, `income should be 5220.00 + 150.00, got ${metric(d.html, 'Income')}`);
      must(metric(d.html, 'Expenses') === 11000 && metric(d.html, 'Entries') === 6, 'expenses or entry count wrong');
      must(metric(d.html, 'Unpaid fees') === 150, 'unpaid fees should be the one remaining consultation');
      must(/Patient fee<\/td><td>2<\/td><td>370\.00<\/td>/.test(d.html), 'by-category row for patient fees is wrong');
      must(/2026-07<\/td><td>2<\/td><td>5600\.00<\/td>/.test(d.html), 'by-month row for July is wrong');
      const july = await get('/dashboard/finance?from=2026-07-01&to=2026-07-31');
      must(metric(july.html, 'Income') === 5000 && metric(july.html, 'Expenses') === 600, 'the period filter does not narrow to July');
      return 'income 5370.00, expenses 11000.00; by category and month; July 5000.00 / 600.00';
    } },
  { task: 'An employee submits a daily report; the chosen superior is notified with its details',
    run: async ({ asGuest, login, get, post, follow, rows, rowWith, must, flashOf }) => {
      asGuest();
      await login('nina@hospital.test', 'nina123');
      const form = await get('/DailyReport/new');
      must(!/name="author"/.test(form.html) && /name="superior"/.test(form.html), 'the form should ask for the superior, not the author');
      adminId = optionOf(form.html, 'superior', 'Dr. Helen Park');
      const r = await follow('/DailyReport', { superior: adminId, date: today(), activities: 'Ward rounds, 12 patients seen, two discharges prepared', hours: 8 });
      must(/Daily report submitted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'two discharges');
      must(row && /Nina Ortiz/.test(row) && /Dr. Helen Park/.test(row) && /<td>8<\/td>/.test(row), `report row: ${row}`);
      must(rows(r.html).length === 2, `staff should see only their own reports, got ${rows(r.html).length}`);
      must((await get('/outbox')).status === 403, 'staff opened the outbox');
      asGuest();
      await login('admin@hospital.test', 'admin123');
      const outbox = await get('/outbox');
      const mails = rows(outbox.html).filter((x) => x.includes('<td>mail</td>'));
      must(mails.length === 1, `expected one letter, got ${mails.length}`);
      must(/<td>admin@hospital.test<\/td>/.test(mails[0]) && new RegExp(`Daily report from Nina Ortiz for ${today()}`).test(mails[0]) && /12 patients seen/.test(mails[0]),
        `the superior's letter is wrong: ${mails[0].slice(0, 300)}`);
      must(rows((await get('/DailyReport')).html).length === 2, 'the superior does not see the submitted report');
      return 'acknowledged; letter to admin@hospital.test with author, date and activities; superior sees it';
    } },
  { task: 'Updating a medicine\'s inventory count in the pharmacy changes its current stock',
    run: async ({ get, post, follow, idOf, rowWith, must, flashOf }) => {
      const pharmacy = await get('/Medicine');
      const id = idOf(pharmacy.html, 'Amoxicillin 500mg', 'Medicine');
      must(stockOf(rowWith(pharmacy.html, 'Amoxicillin 500mg')) === 120, 'seed stock is not 120');
      let r = await follow(`/Medicine/${id}/add/StockMovement`, { kind: 'in', quantity: 50, reason: 'Supplier delivery' });
      must(/Stock updated/.test(flashOf(r.html)) && /<th>Stock<\/th><td>170<\/td>/.test(r.html), 'receiving 50 did not raise the stock to 170');
      r = await follow(`/Medicine/${id}/add/StockMovement`, { kind: 'out', quantity: 20, reason: 'Ward dispensing' });
      must(/<th>Stock<\/th><td>150<\/td>/.test(r.html), 'dispensing 20 did not lower the stock to 150');
      const moves = sectionRows(r.html, 'Stock movements');
      must(moves.length === 4 && moves.some((m) => /Supplier delivery/.test(m) && /Dr. Helen Park/.test(m) && /<td>50<\/td>/.test(m)), 'the movements are not recorded under the medicine');
      const over = await post(`/Medicine/${id}/add/StockMovement`, { kind: 'out', quantity: 999, reason: 'Typo' });
      must(over.status >= 400 && /Not enough stock/.test(over.html), `dispensing more than the stock was accepted: ${over.status}`);
      must(stockOf(rowWith((await get('/Medicine')).html, 'Amoxicillin 500mg')) === 150, 'the stock record does not show 150');
      return 'stock 120 → 170 → 150; movements recorded with who; over-dispensing refused';
    } },
  { task: 'A claim is formulated and submitted, and appears on the claims list with its details',
    run: async ({ asGuest, login, get, post, follow, rowWith, must, flashOf }) => {
      asGuest();
      await login('nina@hospital.test', 'nina123');
      const r = await follow('/Claim', { patient: patientId, insurer: 'MedSecure', amount: '420.00', note: 'Bronchitis treatment' });
      must(/Claim submitted/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Bronchitis treatment');
      must(row && /Lucas Brandt/.test(row) && /MedSecure/.test(row) && /420\.00/.test(row) && /status">Submitted/.test(row) && new RegExp(today()).test(row),
        `claim row: ${row}`);
      must(!/go\/approve"/.test(row), 'staff is offered the approve button');
      const claim = /\/Claim\/(\d+)"/.exec(row)[1];
      must((await post(`/Claim/${claim}/go/approve`, {})).status === 403, 'staff could approve a claim');
      const bad = await post('/Claim', { patient: patientId, insurer: 'MedSecure', amount: '0' });
      must(bad.status === 400 && /Amount must be positive/.test(bad.html), 'a zero claim was accepted');
      return 'submitted with patient, insurer, 420.00, status Submitted; approval reserved to the admin';
    } },
  { task: 'Laboratory results are recorded under a patient\'s test and can be retrieved from the file',
    run: async ({ get, follow, rows, must, flashOf }) => {
      const r = await follow(`/Patient/${patientId}/add/LabTest`, { test: 'Blood glucose', result: '5.4 mmol/L' });
      must(/Test result recorded/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const lab = sectionRows(r.html, 'Laboratory results');
      must(lab.length === 1 && /Blood glucose/.test(lab[0]) && /5\.4 mmol\/L/.test(lab[0]) && /Nina Ortiz/.test(lab[0]), `lab rows: ${lab}`);
      must(/<th>Tests<\/th><td>1<\/td>/.test(r.html), 'the test count on the file is not derived');
      const list = await get(`/LabTest?patient=${patientId}`);
      must(rows(list.html).length === 1 && /Blood glucose/.test(rows(list.html)[0]), 'the result is not filed under the right patient in the laboratory');
      must(!rows((await get('/LabTest?patient=1')).html).some((x) => /Blood glucose/.test(x)), 'the result leaked into another patient\'s file');
      return 'result stored under the file with the technician; filtered by patient in the laboratory';
    } },
  navCheck(6),
  { task: 'The inventory report shows stock levels and movements for a chosen date range',
    run: async ({ get, must }) => {
      const all = await get('/dashboard/inventory-report');
      must(all.status === 200, `inventory report returned ${all.status}`);
      must(metric(all.html, 'Units received') === 280 && metric(all.html, 'Units dispensed') === 200, 'all-time movement totals are wrong');
      must(metric(all.html, 'Units in stock') === 480 && metric(all.html, 'Medicines') === 3, 'stock level cards are wrong');
      must(/Amoxicillin 500mg<\/td><td>250<\/td>/.test(all.html.split('<h3>Received by medicine</h3>')[1]), 'received by medicine is wrong');
      const aug = await get('/dashboard/inventory-report?from=2026-08-01&to=2026-08-31');
      must(metric(aug.html, 'Units received') === 200 && metric(aug.html, 'Units dispensed') === 180, 'the August range is not reflected');
      must(!/Insulin glargine/.test(aug.html.split('<h3>Received by medicine</h3>')[1]), 'a September delivery shows in the August report');
      return 'all time 280 in / 200 out, 480 in stock; August 200 / 180';
    } },
  { task: 'A surgery is scheduled in the theater with its date, time, room and surgeon, and shows on the schedule',
    run: async ({ get, post, follow, rows, rowWith, must, flashOf }) => {
      const surgeon = optionOf((await get('/Surgery/new')).html, 'surgeon', 'Dr. Omar Reyes');
      const r = await follow('/Surgery', { patient: patientId, procedure: 'Appendectomy', room: 'minor', date: '2026-09-20', startTime: '09:30', surgeon, note: 'Fasting from midnight' });
      must(/Surgery scheduled/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Appendectomy');
      must(row && /<td>2026-09-20<\/td><td>09:30<\/td><td>minor<\/td>/.test(row) && /Lucas Brandt/.test(row) && /Dr. Omar Reyes/.test(row) && /status">Scheduled/.test(row),
        `schedule row: ${row}`);
      const day = await get('/Surgery?date_from=2026-09-20&date_to=2026-09-20');
      must(rows(day.html).length === 1 && /Appendectomy/.test(rows(day.html)[0]), 'the schedule cannot be narrowed to the day');
      const bad = await post('/Surgery', { patient: patientId, procedure: 'No date', room: 'main', startTime: '10:00', surgeon });
      must(bad.status === 400 && /date is required/.test(bad.html), 'a surgery without a date was scheduled');
      must(/<td>Appendectomy<\/td>/.test((await get(`/Patient/${patientId}`)).html), 'the surgery is not on the patient file');
      return 'scheduled 2026-09-20 09:30, minor theater, Dr. Omar Reyes; day filter; on the patient file';
    } },
  colorCheck('peachpuff', 'indianred'),
];
