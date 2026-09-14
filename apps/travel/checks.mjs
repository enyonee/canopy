// WebGen-Bench 000096 — online travel booking: search, booking, payment, order status.
import { colorCheck } from '../../verify/lib.mjs';

const confirmation = (flash) => /confirmation number is (\d+)/.exec(flash)?.[1];
const cell = (row, n) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1])[n];
let flightBooking = null, hotelBooking = null;

export const checks = [
  { task: 'Searching trains by departure city, arrival city and date lists only the matching trains',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const hit = await get('/Train?fromCity=Beijing&toCity=Shanghai&date_from=2026-10-01&date_to=2026-10-01');
      must(hit.status === 200, `train search returned ${hit.status}`);
      const found = rows(hit.html);
      must(found.length === 1 && /<td>G1<\/td><td>Beijing<\/td><td>Shanghai<\/td><td>2026-10-01<\/td><td>08:00<\/td><td>12:28<\/td><td>50<\/td><td>553\.00<\/td>/.test(found[0]),
        `expected only G1, got ${found.length} row(s): ${found.map((r) => cell(r, 0))}`);
      const anyDay = rows((await get('/Train?fromCity=Beijing&toCity=Shanghai')).html);
      must(anyDay.length === 2 && anyDay.every((r) => /Beijing<\/td><td>Shanghai/.test(r)), 'without a date both Beijing–Shanghai trains should match');
      must(rows((await get('/Train')).html).length === 5, 'the unfiltered list should show all 5 trains');
      must(!/action\/bookTrain/.test(hit.html) && /name="date_from"/.test(hit.html), 'a guest should see the search form but no Book button');
      return 'Beijing → Shanghai on 2026-10-01 = G1 only; 2 without the date; guests cannot book';
    } },
  { task: 'Booking a selected air ticket completes with a confirmation number',
    run: async ({ post, get, follow, rows, rowWith, idOf, must, flashOf }) => {
      const r = await post('/register', { email: 'ann@travel.test', password: 'secret1', name: 'Ann' });
      must(r.status === 303, `register returned ${r.status}: ${r.html.slice(0, 200)}`);
      const flights = await get('/Flight?fromCity=Beijing&toCity=Shanghai');
      must(rows(flights.html).length === 1 && /action\/bookFlight/.test(flights.html), 'the flight search does not offer CA1501 with a Book button');
      const flight = idOf(flights.html, 'CA1501', 'Flight');
      const booked = await follow(`/Flight/${flight}/action/bookFlight`, { passengers: 2 });
      flightBooking = confirmation(flashOf(booked.html));
      must(flightBooking && /Flight CA1501 booked/.test(flashOf(booked.html)), `no confirmation number: ${flashOf(booked.html)}`);
      const row = rowWith(booked.html, `href="/Booking/${flightBooking}"`);
      must(row && /<td>flight<\/td>/.test(row) && /CA1501/.test(row) && /<td>2<\/td>/.test(row) && /2400\.00/.test(row) && /status">Pending/.test(row), `booking row: ${row}`);
      must(/<td>18<\/td>/.test(rowWith((await get('/Flight')).html, 'CA1501')), 'the two seats were not taken from the flight');
      const detail = await get(`/Booking/${flightBooking}`);
      must(/<th>Amount<\/th><td>2400\.00<\/td>/.test(detail.html) && /go\/pay"/.test(detail.html), 'the booking page does not offer payment');
      return `booking #${flightBooking}: CA1501, 2 passengers, 2400.00, pending; seats 20 → 18`;
    } },
  { task: 'Paying for a hotel booking with a valid card confirms the transaction and emails a receipt',
    run: async ({ asGuest, login, get, post, follow, rows, rowWith, idOf, must, flashOf }) => {
      const hotels = await get('/Hotel?city=Shanghai');
      must(rows(hotels.html).length === 2, 'the city filter does not narrow the hotels');
      const hotel = idOf(hotels.html, 'Bund Riverside Hotel', 'Hotel');
      const booked = await follow(`/Hotel/${hotel}/action/bookHotel`, { nights: 2 });
      hotelBooking = confirmation(flashOf(booked.html));
      must(hotelBooking && /1360\.00/.test(rowWith(booked.html, `href="/Booking/${hotelBooking}"`)), `hotel booking wrong: ${flashOf(booked.html)}`);
      const bad = await post(`/Booking/${hotelBooking}/go/pay`, { card: '1234' });
      must(bad.status === 400 && /Enter a valid 16-digit card number/.test(bad.html), 'an invalid card was accepted');
      const none = await post(`/Booking/${hotelBooking}/go/pay`, {});
      must(none.status === 400 && /card is required/.test(none.html), 'paying without a card was accepted');
      const paid = await follow(`/Booking/${hotelBooking}/go/pay`, { card: '4111111111111111' });
      must(/Payment of 1360\.00 confirmed; a receipt was emailed to ann@travel.test/.test(flashOf(paid.html)), `flash: ${flashOf(paid.html)}`);
      must(/status">Paid/.test(paid.html) && /<th>Paid At<\/th><td>20\d\d-/.test(paid.html) && !/4111111111111111/.test(paid.html), 'the payment is not recorded, or the card is shown');
      must((await post(`/Booking/${hotelBooking}/go/pay`, { card: '4111111111111111' })).status === 409, 'a paid booking could be paid twice');
      must(/<td>11<\/td>/.test(rowWith((await get('/Hotel')).html, 'Bund Riverside Hotel')), 'the room was not taken from the hotel');
      must((await get('/outbox')).status === 403, 'a customer can read the outbox');
      asGuest();
      await login('admin@travel.test', 'admin123');
      const mails = rows((await get('/outbox')).html).filter((x) => x.includes('<td>mail</td>'));
      must(mails.length === 1 && /<td>ann@travel.test<\/td>/.test(mails[0]) && new RegExp(`Receipt for booking #${hotelBooking}`).test(mails[0]) && /1360\.00/.test(mails[0]),
        `receipt letter wrong: ${mails[0]?.slice(0, 300)}`);
      asGuest();
      must((await login('ann@travel.test', 'secret1')).status === 303, 'ann could not sign back in');
      return `booking #${hotelBooking} paid 1360.00 (2 nights); bad card 400; receipt to ann@travel.test; rooms 12 → 11`;
    } },
  { task: 'The order status page lists all past and current bookings with their statuses',
    run: async ({ asGuest, post, get, follow, rows, rowWith, idOf, must, flashOf }) => {
      const train = idOf((await get('/Train?fromCity=Beijing&toCity=Shanghai')).html, 'G1', 'Train');
      const booked = await follow(`/Train/${train}/action/bookTrain`, {});
      const trainBooking = confirmation(flashOf(booked.html));
      must(trainBooking, `no train confirmation: ${flashOf(booked.html)}`);
      const cancelled = await follow(`/Booking/${trainBooking}/go/cancel`, {});
      must(new RegExp(`Booking #${trainBooking} cancelled`).test(flashOf(cancelled.html)) && /status">Cancelled/.test(cancelled.html), 'the train booking was not cancelled');
      const orders = await get('/Booking');
      const listed = rows(orders.html);
      must(listed.length === 3, `expected 3 bookings, got ${listed.length}`);
      must(/status">Pending/.test(rowWith(orders.html, 'CA1501')) && /status">Paid/.test(rowWith(orders.html, 'Bund Riverside Hotel')) && /status">Cancelled/.test(rowWith(orders.html, '>G1<')),
        'statuses do not match the bookings');
      must(listed.every((r) => /href="\/Booking\/\d+"/.test(r)), 'a booking row has no page to open');
      must(cell(listed[0], 0) === String(trainBooking), 'the newest booking is not first');
      must(rows((await get('/Booking?status=paid')).html).length === 1, 'the status filter does not narrow');
      asGuest();
      must((await post('/register', { email: 'bob@travel.test', password: 'secret2', name: 'Bob' })).status === 303, 'bob could not register');
      must(rows((await get('/Booking')).html).length === 0 && (await get(`/Booking/${flightBooking}`)).status === 403, "bob sees ann's bookings");
      return 'pending flight, paid hotel, cancelled train, newest first; status filter; another customer sees none';
    } },
  colorCheck('peachpuff', 'indianred'),
];
