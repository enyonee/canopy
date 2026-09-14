// WebGen-Bench 000101 — travel reimbursement and payment system. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let tripId = null, claimId = null;
const cells = (row) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const money = (html, field) => (new RegExp(`<th>${field}</th><td>([\\d.]+)</td>`).exec(html) || [])[1];
const metric = (html, title) => (new RegExp(`<b>([\\d.]+)</b>${title}`).exec(html) || [])[1];

export const checks = [
  { task: 'The ticket booking section books a flight and shows a confirmation with the booking on the trip',
    run: async ({ get, post, follow, rowWith, idOf, must, flashOf }) => {
      const section = await get('/Flight');
      must(section.status === 200 && /href="\/Flight\/new">Book a flight/.test(section.html), 'the flight section has no booking button');
      const form = await get('/Flight/new');
      for (const f of ['trip', 'airline', 'origin', 'destination', 'date', 'amount']) must(new RegExp(`name="${f}"`).test(form.html), `the flight form lacks ${f}`);
      tripId = idOf((await get('/Trip')).html, 'Berlin sales kickoff', 'Trip');
      const bad = await post('/Flight', { trip: tripId, airline: 'Lufthansa', origin: 'BER', destination: 'MUC', date: '2026-08-13', amount: '0' });
      must(bad.status === 400 && /Amount must be positive/.test(bad.html), 'a zero-amount ticket was accepted');
      const page = await follow('/Flight', { trip: tripId, airline: 'Lufthansa', origin: 'BER', destination: 'MUC', date: '2026-08-13', flightNo: 'LH2037', amount: '210' });
      must(/Flight booked/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(new RegExp(`<h2>Berlin sales kickoff</h2>`).test(page.html), 'the confirmation did not land on the trip');
      const row = rowWith(page.html, 'LH2037');
      must(row && /BER/.test(row) && /MUC/.test(row) && /210\.00/.test(row), `the flight is not on the trip: ${row}`);
      must(money(page.html, 'Flights') === '574.00' && money(page.html, 'Total') === '1054.00', 'the trip totals did not follow the flight (189 + 175 + 210)');
      return 'flight LH2037 booked, trip flights 574.00, total 1054.00';
    } },
  { task: 'The hotel booking section books a room; nights and amount are derived and confirmed',
    run: async ({ get, post, follow, rowWith, must, flashOf }) => {
      must(/href="\/Hotel\/new">Book a hotel/.test((await get('/Hotel')).html), 'the hotel section has no booking button');
      const bad = await post('/Hotel', { trip: tripId, name: 'Motel One', city: 'Berlin', checkIn: '2026-08-15', checkOut: '2026-08-13', ratePerNight: '95' });
      must(bad.status === 400 && /Check-out must be after check-in/.test(bad.html), 'a check-out before check-in was accepted');
      const page = await follow('/Hotel', { trip: tripId, name: 'Motel One', city: 'Berlin', checkIn: '2026-08-13', checkOut: '2026-08-15', ratePerNight: '95' });
      must(/Hotel room booked/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      const row = rowWith(page.html, 'Motel One');
      must(row && cells(row)[4] === '2' && cells(row)[6] === '190.00', `nights or amount not derived (2 x 95.00): ${row}`);
      must(money(page.html, 'Hotels') === '670.00' && money(page.html, 'Total') === '1244.00', 'the trip totals did not follow the hotel (480 + 190)');
      return 'Motel One, 2 nights, 190.00; trip hotels 670.00, total 1244.00';
    } },
  { task: 'The train booking section books a ticket and confirms it on the trip',
    run: async ({ get, follow, rowWith, must, flashOf }) => {
      must(/href="\/Train\/new">Book a train/.test((await get('/Train')).html), 'the train section has no booking button');
      const page = await follow('/Train', { trip: tripId, operator: 'DB ICE', origin: 'Berlin', destination: 'Munich', date: '2026-08-15', amount: '89.9' });
      must(/Train ticket booked/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      const row = rowWith(page.html, 'DB ICE');
      must(row && /Berlin/.test(row) && /Munich/.test(row) && /89\.90/.test(row), `the train ticket is not on the trip: ${row}`);
      must(money(page.html, 'Trains') === '89.90' && money(page.html, 'Total') === '1333.90', 'the trip totals did not follow the train ticket');
      return 'DB ICE 89.90; trip trains 89.90, total 1333.90';
    } },
  { task: 'Submit a reimbursement application for the trip: a reference number is displayed',
    run: async ({ get, post, rowWith, must, flashOf }) => {
      const section = await get('/Claim');
      must(section.status === 200 && /href="\/Claim\/new">New reimbursement claim/.test(section.html), 'the reimbursement section has no application button');
      const form = await get('/Claim/new');
      must(/<h2>Reimbursement application<\/h2>/.test(form.html) && /name="trip"/.test(form.html) && /name="note"/.test(form.html) && !/name="employee"/.test(form.html),
        'the application form is wrong (trip and note, employee filled silently)');
      must(/action="\/Trip\/\d+\/add\/Claim"/.test((await get(`/Trip/${tripId}`)).html), 'the trip page has no claim form');
      const r = await post('/Claim', { trip: tripId, note: 'Kickoff week, all receipts attached' });
      must(r.status === 303 && /^\/Claim\/\d+/.test(r.location), `the application returned ${r.status}: ${r.html.slice(0, 200)}`);
      claimId = /^\/Claim\/(\d+)/.exec(r.location)[1];
      const claim = await get(r.location);
      must(/Reimbursement claim submitted: your reference is the claim number below/.test(flashOf(claim.html)), `flash: ${flashOf(claim.html)}`);
      must(new RegExp(`<h2>#${claimId}</h2>`).test(claim.html) && /status">Submitted/.test(claim.html), 'the claim page lacks its reference number or status');
      must(money(claim.html, 'Amount') === '1333.90' && /Kickoff week, all receipts attached/.test(claim.html) && /Berlin sales kickoff/.test(claim.html) && /Dana Kim/.test(claim.html),
        'the claim lacks amount, note, trip or employee');
      const outbox = await get('/outbox');
      const mail = rowWith(outbox.html, 'finance@corp.test');
      must(mail && new RegExp(`Claim #${claimId} from Dana Kim`).test(mail) && /status">sent/.test(mail), 'finance was not notified');
      return `claim #${claimId} for 1333.90, submitted, finance notified`;
    } },
  { task: 'The settlement report sums flights, hotels and trains per trip and narrows to a period',
    run: async ({ get, rowWith, must }) => {
      const d = await get('/dashboard/settlement');
      must(d.status === 200, `report returned ${d.status}`);
      const got = { flights: metric(d.html, 'Flights'), hotels: metric(d.html, 'Hotels'), trains: metric(d.html, 'Trains'), total: metric(d.html, 'Total expenses'), claims: metric(d.html, 'Claims'), approved: metric(d.html, 'Approved or paid') };
      must(got.flights === '574.00' && got.hotels === '1090.00' && got.trains === '247.90' && got.total === '1911.90', `totals are wrong: ${JSON.stringify(got)}`);
      must(got.claims === '2' && got.approved === '578.00', `claim cards are wrong: ${JSON.stringify(got)}`);
      const berlin = rowWith(d.html, 'Berlin sales kickoff'), vienna = rowWith(d.html, 'Vienna partner visit');
      must(berlin && cells(berlin).slice(1).join(' ') === '574.00 670.00 89.90 1333.90', `Berlin settlement row is wrong: ${berlin}`);
      must(vienna && cells(vienna).slice(1).join(' ') === '0.00 420.00 158.00 578.00', `Vienna settlement row is wrong: ${vienna}`);
      const sept = await get('/dashboard/settlement?from=2026-09-01&to=2026-09-30');
      must(metric(sept.html, 'Flights') === '0.00' && metric(sept.html, 'Hotels') === '420.00' && metric(sept.html, 'Trains') === '158.00' && metric(sept.html, 'Total expenses') === '578.00',
        'the period filter does not narrow to September');
      must(rowWith(sept.html, 'Vienna partner visit') && !rowWith(sept.html, 'Berlin sales kickoff'), 'the by-trip table ignores the period');
      return 'flights 574.00, hotels 1090.00, trains 247.90, total 1911.90; per trip; September → 578.00';
    } },
  { task: 'The reimbursement status page shows the claim and follows its approval and payment',
    run: async ({ get, follow, rowWith, must, flashOf }) => {
      let list = await get('/Claim');
      let row = rowWith(list.html, `<td>${claimId}</td>`);
      must(row && /Berlin sales kickoff/.test(row) && /1333\.90/.test(row) && /status">Submitted/.test(row), `the claim is not on the status page: ${row}`);
      must(/status">Approved/.test(rowWith(list.html, 'Vienna partner visit')), 'the seeded approved claim is not shown as approved');
      let page = await follow(`/Claim/${claimId}/go/approve`, {});
      must(new RegExp(`Claim #${claimId} approved`).test(flashOf(page.html)) && /status">Approved/.test(page.html), 'approval did not move the status');
      list = await get('/Claim?status=approved');
      must(rowWith(list.html, `<td>${claimId}</td>`) && /status">Approved/.test(rowWith(list.html, `<td>${claimId}</td>`)), 'the status page does not show the approval');
      page = await follow(`/Claim/${claimId}/go/pay`, {});
      must(new RegExp(`Claim #${claimId} paid out: 1333.90`).test(flashOf(page.html)) && /status">Paid/.test(page.html), 'payment did not move the status');
      list = await get('/Claim');
      must(/status">Paid/.test(rowWith(list.html, `<td>${claimId}</td>`)), 'the status page is not up to date after payment');
      const outbox = await get('/outbox');
      const mail = rowWith(outbox.html, 'dana.kim@corp.test');
      must(mail && new RegExp(`Claim #${claimId} approved`).test(mail), 'the employee was not told about the approval');
      return 'submitted → approved → paid, visible on the status page; approval letter to the employee';
    } },
  colorCheck('white', 'navy'),
];
