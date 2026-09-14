// WebGen-Bench 000100 — golf travel package booking. One check per ui_instruct case.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let harryId = null, algarveId = null, catalunyaId = null, harryQuote = null, newBooking = null;
const cells = (row) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const bookingId = (location) => (/^\/Booking\/(\d+)/.exec(location) || [])[1];
const money = (html, field) => (new RegExp(`<th>${field}</th><td>([\\d.]+)</td>`).exec(html) || [])[1];

export const checks = [
  { task: 'The homepage request form accepts dates, destination and preferences and confirms the submission',
    run: async ({ get, post, follow, rowWith, must, flashOf }) => {
      const home = await get('/');
      must(home.location === '/Request/new' && /Plan your golf trip/.test(home.html), `the homepage is not the request form: ${home.location}`);
      for (const f of ['name', 'email', 'destination', 'start', 'end', 'golfers', 'preferences']) must(new RegExp(`name="${f}"`).test(home.html), `the form lacks ${f}`);
      const bad = await post('/Request', { name: 'Ida Park', email: 'ida@example.test', start: '2026-12-01', end: '2026-12-06', golfers: 2 });
      must(bad.status === 400 && /destination is required/.test(bad.html), 'a request without a destination was accepted');
      const dates = await post('/Request', { name: 'Ida Park', email: 'ida@example.test', destination: 'Algarve', start: '2026-12-06', end: '2026-12-01', golfers: 2 });
      must(dates.status === 400 && /Return date must be after the departure date/.test(dates.html), 'a return before the departure was accepted');
      const page = await follow('/Request', { name: 'Ida Park', email: 'ida@example.test', destination: 'Algarve', start: '2026-12-01', end: '2026-12-06', golfers: 2, preferences: 'Two rounds a day, ocean views' });
      must(/Thank you, your request has been received/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/<h2>Ida Park<\/h2>/.test(page.html) && /<th>Destination<\/th><td>Algarve<\/td>/.test(page.html) && /<th>Start<\/th><td>2026-12-01<\/td>/.test(page.html)
        && /Two rounds a day, ocean views/.test(page.html) && /status">New/.test(page.html), 'the confirmation page does not echo the submitted request');
      const inbox = await get('/Request');
      const row = rowWith(inbox.html, 'Ida Park');
      must(row && /Algarve/.test(row) && /2026-12-01/.test(row) && /status">New/.test(row), `the request is not in the inbox: ${row}`);
      return 'required destination and date order enforced; request received and listed as New';
    } },
  { task: 'Book a travel package: pick a package and a customer, confirm, and get a clear confirmation',
    run: async ({ get, post, follow, idOf, must, flashOf }) => {
      const packages = await get('/Package');
      algarveId = idOf(packages.html, 'Algarve Classic', 'Package');
      catalunyaId = idOf(packages.html, 'Catalunya Escape', 'Package');
      harryId = idOf((await get('/Customer')).html, 'Harry Lime', 'Customer');
      const r = await post('/Booking', { customer: harryId, package: catalunyaId, golfers: 1, start: '2026-11-02' });
      must(r.status === 303 && bookingId(r.location), `booking returned ${r.status}: ${r.html.slice(0, 200)}`);
      newBooking = bookingId(r.location);
      let page = await get(r.location);
      must(/Quote ready/.test(flashOf(page.html)) && /status">Quoted/.test(page.html), 'the quote was not created');
      must(new RegExp(`action="/Booking/${newBooking}/go/confirm"`).test(page.html), 'no confirm step is offered');
      page = await follow(`/Booking/${newBooking}/go/confirm`, {});
      must(new RegExp(`Booking #${newBooking} confirmed: Catalunya Escape for Harry Lime, total 880.00. Voucher and invoice sent to harry@example.test`).test(flashOf(page.html)),
        `confirmation flash: ${flashOf(page.html)}`);
      must(/status">Confirmed/.test(page.html), 'the booking is not confirmed');
      must((await post(`/Booking/${newBooking}/go/confirm`, {})).status === 409, 'a confirmed booking could be confirmed twice');
      return 'quote → confirmed, flash with number, package, customer and total 880.00';
    } },
  { task: 'The online quote breaks a package down into hotel, golf, flights, transport and extras from the rates and preferences',
    run: async ({ get, post, rowWith, idOf, must }) => {
      const list = await get('/Booking?status=quoted');
      harryQuote = idOf(list.html, 'Algarve Classic', 'Booking');
      const quote = await get(`/Booking/${harryQuote}`);
      const got = Object.fromEntries(['Hotel', 'Golf', 'Flights', 'Transport', 'Extras', 'Total'].map((f) => [f, money(quote.html, f)]));
      must(got.Hotel === '960.00' && got.Golf === '570.00' && got.Flights === '360.00' && got.Transport === '60.00' && got.Extras === '0.00' && got.Total === '1950.00',
        `Algarve quote for 2 golfers is wrong: ${JSON.stringify(got)}`);
      const other = await get(`/Booking/${newBooking}`);
      must(money(other.html, 'Hotel') === '420.00' && money(other.html, 'Golf') === '220.00' && money(other.html, 'Total') === '880.00', 'the Catalunya quote for 1 golfer is wrong');
      const r = await post('/Booking', { customer: harryId, package: algarveId, golfers: 3, start: '2027-03-05' });
      const three = await get(r.location);
      must(money(three.html, 'Hotel') === '1440.00' && money(three.html, 'Golf') === '855.00' && money(three.html, 'Flights') === '540.00' && money(three.html, 'Transport') === '60.00' && money(three.html, 'Total') === '2895.00',
        'the quote does not scale with the number of golfers');
      must(cells(rowWith((await get('/Package')).html, 'Algarve Classic'))[6] === '945.00', 'the package base price is not derived from the supplier rates');
      return 'breakdown 960/570/360/60/0 = 1950.00; 1 golfer 880.00; 3 golfers 2895.00; base price 945.00';
    } },
  { task: 'The digital voucher carries the package details, the confirmation number and the customer',
    run: async ({ get, rowWith, must }) => {
      const page = await get(`/Booking/${newBooking}`);
      must(new RegExp(`<h2>#${newBooking}</h2>`).test(page.html) && /status">Confirmed/.test(page.html), 'the confirmed booking page lacks its number');
      const outbox = await get('/outbox');
      const voucher = rowWith(outbox.html, `Voucher #${newBooking}: Catalunya Escape`);
      must(voucher, 'no voucher letter in the outbox');
      must(/harry@example\.test/.test(voucher) && /status">sent/.test(voucher), 'the voucher was not sent to the customer');
      for (const detail of ['Harry Lime', 'Costa Brava', '1 golfer(s) from 2026-11-02', '3 nights at Costa Brava Resort', '2 rounds at PGA Catalunya',
        'hotel 420.00', 'golf 220.00', 'flights 180.00', 'transport 60.00', 'extras 0.00', 'total 880.00'])
        must(voucher.includes(detail), `the voucher lacks "${detail}"`);
      return 'voucher letter with number, customer, package, hotel, course, dates and invoice lines';
    } },
  navCheck(4),
  { task: 'Supplier management: add a supplier, then update it, with confirmation each time',
    run: async ({ get, follow, rowWith, idOf, must, flashOf }) => {
      let page = await follow('/Supplier', { name: 'Vilamoura Marina Hotel', kind: 'hotel', country: 'Portugal', contact: 'stay@vilamoura.test', rate: '150', notes: 'Rate per room per night' });
      must(/Supplier saved/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      let row = rowWith(page.html, 'Vilamoura Marina Hotel');
      must(row && cells(row)[1] === 'hotel' && cells(row)[4] === '150.00', `the new supplier row is wrong: ${row}`);
      const id = idOf(page.html, 'Vilamoura Marina Hotel', 'Supplier');
      page = await follow(`/Supplier/${id}`, { rate: '135', contact: 'sales@vilamoura.test' });
      must(/Supplier updated/.test(flashOf(page.html)), `edit flash: ${flashOf(page.html)}`);
      row = rowWith(page.html, 'Vilamoura Marina Hotel');
      must(cells(row)[4] === '135.00' && /sales@vilamoura\.test/.test(row), 'the update did not persist');
      const shuttle = idOf(page.html, 'Faro Shuttle', 'Supplier');
      await follow(`/Supplier/${shuttle}`, { rate: '70' });
      const quote = await get(`/Booking/${harryQuote}`);
      must(money(quote.html, 'Transport') === '70.00' && money(quote.html, 'Total') === '1960.00', 'a supplier rate change did not reach the quote');
      return 'added at 150.00, updated to 135.00; shuttle 60 → 70 moves the quote to 1960.00';
    } },
  { task: 'CRM: updating customer preferences changes the customer\'s quotes immediately',
    run: async ({ get, follow, rowWith, must, flashOf }) => {
      const page = await follow(`/Customer/${harryId}`, { roomType: 'suite', caddie: 'on', preferences: 'Suite with sea view, caddie on every round', handicap: 11 });
      must(/Customer preferences updated/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/<th>Room Type<\/th><td>suite<\/td>/.test(page.html) && /<th>Caddie<\/th><td>Yes<\/td>/.test(page.html) && /Suite with sea view/.test(page.html) && /<th>Handicap<\/th><td>11<\/td>/.test(page.html),
        'the customer record was not updated');
      const row = rowWith(page.html, 'Algarve Classic');
      must(row && cells(row)[4] === '468.00' && cells(row)[5] === '2428.00', `the quote under the customer does not reflect the preferences: ${row}`);
      const quote = await get(`/Booking/${harryQuote}`);
      must(money(quote.html, 'Extras') === '468.00' && money(quote.html, 'Total') === '2428.00', 'the quote page does not reflect the preferences');
      const crm = await get('/Customer?q=Harry');
      must(/<td>suite<\/td>/.test(rowWith(crm.html, 'Harry Lime')), 'the CRM list does not show the new preference');
      return 'suite + caddie: extras 468.00, total 1960.00 → 2428.00 under the customer and on the quote';
    } },
  colorCheck('whitesmoke', 'darkcyan'),
];
