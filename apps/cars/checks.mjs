// WebGen-Bench 000098 — car rental platform. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let fiatId = null, transitId = null, fiatBooking = null, transitBooking = null;
const cells = (row) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const bookingId = (location) => (/^\/Booking\/(\d+)/.exec(location) || [])[1];
const rowById = (rows, id) => rows.find((r) => cells(r)[0] === String(id));

export const checks = [
  { task: 'Browse the cars for rental with their type and price per day; filter by type and search',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const { html, status } = await get('/Car');
      must(status === 200, `car list returned ${status}`);
      must(rows(html).length === 6, `expected 6 cars, got ${rows(html).length}`);
      const fiat = rowWith(html, 'Fiat 500'), rav = rowWith(html, 'Toyota RAV4');
      must(fiat && cells(fiat)[1] === 'economy' && cells(fiat)[4] === '29.00', `Fiat row lacks type or price: ${fiat}`);
      must(rav && cells(rav)[1] === 'suv' && cells(rav)[4] === '69.00' && cells(rav)[3] === 'automatic', `RAV4 row lacks type, transmission or price: ${rav}`);
      fiatId = idOf(html, 'Fiat 500', 'Car');
      transitId = idOf(html, 'Ford Transit', 'Car');
      const suv = await get('/Car?type=suv');
      must(rows(suv.html).length === 2 && rowWith(suv.html, 'Toyota RAV4') && rowWith(suv.html, 'Range Rover'), 'the type filter does not narrow to SUVs');
      const q = await get('/Car?q=golf');
      must(rows(q.html).length === 1 && rowWith(q.html, 'VW Golf'), 'the search does not narrow');
      const detail = await get(`/Car/${fiatId}`);
      must(/<th>Price Per Day<\/th><td>29\.00<\/td>/.test(detail.html) && /City car, 1\.0 petrol/.test(detail.html), 'the car page lacks price or description');
      return '6 cars with type and price per day; filter suv → 2; search golf → 1';
    } },
  { task: 'Select a car and rental dates; the draft shows whether the car is available (a unit is left)',
    run: async ({ get, post, must, flashOf }) => {
      const bad = await post('/Booking', { car: fiatId, start: '2026-10-10', end: '2026-10-08', pickupTime: '10:00', returnTime: '10:00' });
      must(bad.status === 400 && /Return date must be after the pick-up date/.test(bad.html), 'a return date before the pick-up date was accepted');
      const r = await post('/Booking', { car: fiatId, start: '2026-10-10', end: '2026-10-13', pickupTime: '10:00', returnTime: '12:00' });
      must(r.status === 303 && bookingId(r.location), `booking returned ${r.status} ${r.location}: ${r.html.slice(0, 200)}`);
      fiatBooking = bookingId(r.location);
      const page = await get(r.location);
      must(/Draft booking saved/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/<th>Available<\/th><td>Yes<\/td>/.test(page.html), 'an available car is not shown as available');
      must(/<th>Start<\/th><td>2026-10-10<\/td>/.test(page.html) && /<th>End<\/th><td>2026-10-13<\/td>/.test(page.html) && /<th>Pickup Time<\/th><td>10:00<\/td>/.test(page.html),
        'the chosen dates and times are not shown');
      const r2 = await post('/Booking', { car: transitId, start: '2026-10-10', end: '2026-10-13', pickupTime: '08:00', returnTime: '08:00' });
      must(r2.status === 303, `booking the sold-out car returned ${r2.status}`);
      transitBooking = bookingId(r2.location);
      const page2 = await get(r2.location);
      must(/<th>Available<\/th><td>No<\/td>/.test(page2.html), 'a car without units is shown as available');
      return 'bad dates refused; Fiat: Available Yes; Transit (0 units): Available No';
    } },
  { task: 'The booking summary shows car, type, dates and total cost, with Edit and Proceed to payment',
    run: async ({ get, follow, must, flashOf }) => {
      const page = await get(`/Booking/${fiatBooking}`);
      must(new RegExp(`<th>Car</th><td><a href="/Car/${fiatId}">Fiat 500</a></td>`).test(page.html), 'the car is not on the summary');
      must(/<th>Car Type<\/th><td>economy<\/td>/.test(page.html), 'the car type is not on the summary');
      must(/<th>Days<\/th><td>3<\/td>/.test(page.html) && /<th>Total<\/th><td>87\.00<\/td>/.test(page.html), 'days or total (3 x 29.00) is wrong');
      must(new RegExp(`href="/Booking/${fiatBooking}/edit"`).test(page.html), 'no Edit option');
      must(new RegExp(`action="/Booking/${fiatBooking}/go/pay"`).test(page.html) && /name="paymentMethod"/.test(page.html) && /Proceed to payment/.test(page.html),
        'no option to proceed to payment');
      const edited = await follow(`/Booking/${fiatBooking}`, { end: '2026-10-15', returnTime: '16:00' });
      must(/Booking details updated/.test(flashOf(edited.html)), `edit flash: ${flashOf(edited.html)}`);
      must(/<th>Days<\/th><td>5<\/td>/.test(edited.html) && /<th>Total<\/th><td>145\.00<\/td>/.test(edited.html) && /<th>Return Time<\/th><td>16:00<\/td>/.test(edited.html),
        'the total did not follow the edited return date');
      return 'summary with car, type, 3 days, 87.00; after edit 5 days, 145.00';
    } },
  { task: 'Pay with one of the payment methods; a confirmation with a unique booking reference appears',
    run: async ({ get, post, follow, rows, rowWith, must, flashOf }) => {
      const page = await follow(`/Booking/${fiatBooking}/go/pay`, { paymentMethod: 'paypal' });
      must(new RegExp(`Booking #${fiatBooking} paid by paypal: Fiat 500, 2026-10-10 to 2026-10-15, 5 day\\(s\\), total 145.00`).test(flashOf(page.html)),
        `confirmation flash: ${flashOf(page.html)}`);
      must(/status">Paid/.test(page.html) && /<th>Payment Method<\/th><td>paypal<\/td>/.test(page.html), 'the booking is not paid');
      const mine = rowById(rows((await get('/Booking')).html), fiatBooking);
      must(mine && cells(mine)[7] === '<span class="status">Paid</span>', `booking #${fiatBooking} is not listed as paid under My bookings: ${mine}`);
      must((await post(`/Booking/${fiatBooking}/go/pay`, { paymentMethod: 'card' })).status === 409, 'a paid booking could be paid twice');
      const cars = await get('/Car');
      must(cells(rowWith(cars.html, 'Fiat 500'))[5] === '2', 'the paid booking did not take a unit (3 → 2)');
      const refused = await post(`/Booking/${transitBooking}/go/pay`, { paymentMethod: 'card' });
      must(refused.status === 400 && /No unit of this car is left/.test(refused.html), `paying for the sold-out car returned ${refused.status}`);
      must(/status">Draft/.test((await get(`/Booking/${transitBooking}`)).html), 'the refused booking changed status');
      const paid = await get('/Booking?status=paid');
      must(rowById(rows(paid.html), fiatBooking) && !rowById(rows(paid.html), transitBooking), 'order management: the paid filter is wrong');
      const outbox = await get('/outbox');
      const mail = rowWith(outbox.html, 'alex@example.test');
      must(mail && new RegExp(`Booking #${fiatBooking} confirmed`).test(mail) && /status">sent/.test(mail), 'the confirmation letter is not in the outbox');
      return 'paid by paypal, reference #id, unit taken, second pay 409, sold-out car refused, letter sent';
    } },
  colorCheck('papayawhip', 'darkorange'),
];
