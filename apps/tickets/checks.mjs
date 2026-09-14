// WebGen-Bench 000099 — bus and railway ticket booking. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let busId = null, fullBusId = null, annBooking = null, overBooking = null;
const cells = (row) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const bookingId = (location) => (/^\/Booking\/(\d+)/.exec(location) || [])[1];

export const checks = [
  { task: 'The registration form creates a user and confirms it',
    run: async ({ asGuest, get, post, must, flashOf }) => {
      asGuest();
      const form = await get('/register');
      must(form.status === 200 && /name="email"/.test(form.html) && /name="password"/.test(form.html) && /name="name"/.test(form.html), 'the registration form is incomplete');
      const missing = await post('/register', { email: 'ann@tickets.test', password: 'secret1' });
      must(missing.status === 400 && /name is required/.test(missing.html), 'a registration without a name was accepted');
      const r = await post('/register', { email: 'ann@tickets.test', password: 'secret1', name: 'Ann Novak', phone: '+420 600 100' });
      must(r.status === 303, `register returned ${r.status}: ${r.html.slice(0, 300)}`);
      const home = await get(r.location);
      must(/Welcome, ann@tickets.test/.test(flashOf(home.html)), `no confirmation message: ${flashOf(home.html)}`);
      must(/Signed in as ann@tickets.test \(traveller\)/.test(home.html), 'not signed in after registering');
      const dup = await post('/register', { email: 'ann@tickets.test', password: 'x', name: 'Ann again' });
      must(dup.status === 400 && /already registered/.test(dup.html), 'a duplicate email was accepted');
      return 'registered with a welcome message; missing name and duplicate email refused';
    } },
  { task: 'Login with registered credentials opens the personal features such as booking history',
    run: async ({ asGuest, logout, login, get, post, must }) => {
      await logout();
      const closed = await get('/list/history');
      must(closed.location.startsWith('/login'), `booking history did not ask for a login: ${closed.status} ${closed.location}`);
      must((await post('/Booking', { trip: 1, passenger: 'Nobody', qty: 1 })).status === 403, 'a guest could book');
      const bad = await login('ann@tickets.test', 'nope');
      must(bad.status === 401 && /Wrong login or password/.test(bad.html), 'a wrong password was accepted');
      const r = await login('ann@tickets.test', 'secret1');
      must(r.status === 303, `login returned ${r.status}`);
      const history = await get('/list/history');
      must(history.status === 200 && /<h2>Booking history<\/h2>/.test(history.html) && /Signed in as ann@tickets.test/.test(history.html), 'booking history is not open after login');
      asGuest();
      return 'guest redirected and refused; wrong password 401; login opens the history page';
    } },
  { task: 'Search bus trips: options with free seats and prices are listed',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const { html, status } = await get('/Trip?mode=bus&q=Munich');
      must(status === 200, `search returned ${status}`);
      must(rows(html).length === 2, `expected 2 bus options through Munich, got ${rows(html).length}`);
      const berlin = rowWith(html, 'Berlin to Munich'), vienna = rowWith(html, 'Munich to Vienna');
      must(berlin && vienna, 'the bus options are missing');
      must(!/DB ICE/.test(html) && !/Railjet/.test(html), 'trains are listed among buses');
      must(cells(berlin)[1] === 'bus' && cells(berlin)[6] === '19.00' && cells(berlin)[7] === '40', `Berlin bus row lacks mode, price or seats: ${berlin}`);
      must(cells(vienna)[7] === '2', `the nearly full bus does not show 2 seats: ${vienna}`);
      busId = idOf(html, 'Berlin to Munich', 'Trip');
      fullBusId = idOf(html, 'Munich to Vienna', 'Trip');
      return '2 buses with mode, price and seats (40 and 2)';
    } },
  { task: 'Search railway trips: options with free seats and prices are listed',
    run: async ({ get, rows, rowWith, must }) => {
      const { html } = await get('/Trip?mode=train&q=Munich');
      must(rows(html).length === 2, `expected 2 train options through Munich, got ${rows(html).length}`);
      const ice = rowWith(html, 'DB ICE'), railjet = rowWith(html, 'OBB Railjet');
      must(ice && railjet, 'the train options are missing');
      must(!/FlixBus/.test(html), 'buses are listed among trains');
      must(cells(ice)[1] === 'train' && cells(ice)[6] === '59.00' && cells(ice)[7] === '119', `ICE row lacks mode, price or seats: ${ice}`);
      must(cells(railjet)[6] === '45.00' && cells(railjet)[7] === '80', `Railjet row lacks price or seats: ${railjet}`);
      const paris = await get('/Trip?mode=train&q=Paris');
      must(rows(paris.html).length === 1 && rowWith(paris.html, 'Eurostar'), 'the search does not narrow by city');
      return '2 trains with mode, price and seats (119 and 80); Paris → Eurostar only';
    } },
  { task: 'Pay for a booking: payment confirmed, seats taken, a confirmation letter sent',
    run: async ({ asGuest, login, get, post, follow, rowWith, must, flashOf }) => {
      await login('ann@tickets.test', 'secret1');
      const r = await post('/Booking', { trip: busId, passenger: 'Ann Novak', qty: 2 });
      must(r.status === 303 && bookingId(r.location), `booking returned ${r.status}: ${r.html.slice(0, 200)}`);
      annBooking = bookingId(r.location);
      let page = await get(r.location);
      must(/Reservation created/.test(flashOf(page.html)) && /<th>Total<\/th><td>38\.00<\/td>/.test(page.html), 'the reservation or its total (2 x 19.00) is wrong');
      must(/<th>Traveller<\/th><td><a href="\/User\/\d+">ann@tickets.test<\/a>/.test(page.html), 'the booking is not owned by the signed-in user');
      page = await follow(`/Booking/${annBooking}/go/pay`, { paymentMethod: 'card' });
      must(new RegExp(`Payment received: booking #${annBooking} confirmed, 2 seat\\(s\\) on Berlin to Munich`).test(flashOf(page.html)), `payment flash: ${flashOf(page.html)}`);
      must(/status">Paid/.test(page.html), 'the booking is not paid');
      must((await post(`/Booking/${annBooking}/go/pay`, { paymentMethod: 'card' })).status === 409, 'a paid booking could be paid twice');
      const trips = await get('/Trip?mode=bus&q=Berlin');
      must(cells(rowWith(trips.html, 'Berlin to Munich'))[7] === '38', 'the seats counter did not drop from 40 to 38');
      const over = await post('/Booking', { trip: fullBusId, passenger: 'Ann Novak', qty: 3 });
      overBooking = bookingId(over.location);
      const refused = await post(`/Booking/${overBooking}/go/pay`, { paymentMethod: 'paypal' });
      must(refused.status === 400 && /Not enough seats left/.test(refused.html), `overbooking returned ${refused.status}`);
      must(cells(rowWith((await get('/Trip?q=Vienna')).html, 'FlixBus'))[7] === '2', 'seats changed despite the refusal');
      asGuest();
      await login('admin@tickets.test', 'admin123');
      const outbox = await get('/outbox');
      const mail = rowWith(outbox.html, 'ann@tickets.test');
      must(mail && new RegExp(`Ticket #${annBooking}: Berlin to Munich on 2026-10-05`).test(mail) && /status">sent/.test(mail), 'the confirmation letter is not in the outbox');
      asGuest();
      return 'paid by card, seats 40 → 38, second pay 409, overbooking refused, letter to ann';
    } },
  { task: 'Booking history lists the signed-in user\'s past transactions only',
    run: async ({ asGuest, login, get, rows, rowWith, must }) => {
      await login('ann@tickets.test', 'secret1');
      const history = await get('/list/history');
      must(rows(history.html).length === 1, `ann's history has ${rows(history.html).length} row(s), expected the paid booking only`);
      const row = rows(history.html)[0];
      must(cells(row)[0] === annBooking && /Berlin to Munich/.test(row) && /Ann Novak/.test(row) && /38\.00/.test(row) && /<td>card<\/td>/.test(row) && /status">Paid/.test(row),
        `history row lacks details: ${row}`);
      const all = await get('/Booking');
      must(rows(all.html).length === 2 && rowWith(all.html, `<td>${overBooking}</td>`), 'the bookings page does not show both of ann\'s bookings');
      asGuest();
      await login('lena@tickets.test', 'lena123');
      const lena = await get('/list/history');
      must(rows(lena.html).length === 1 && /Lena Berg/.test(lena.html) && !/Ann Novak/.test(lena.html), 'lena sees bookings that are not hers');
      must((await get(`/Booking/${annBooking}`)).status === 403, "lena opened ann's booking");
      asGuest();
      return 'ann: 1 transaction with trip, passenger, total, method, status; lena sees only hers; 403 on foreign booking';
    } },
  { task: 'The ticket: a paid booking is listed under My tickets and its page carries every ticket detail',
    run: async ({ asGuest, login, get, rows, must }) => {
      await login('ann@tickets.test', 'secret1');
      const tickets = await get('/list/tickets');
      must(tickets.status === 200 && rows(tickets.html).length === 1 && cells(rows(tickets.html)[0])[0] === annBooking, 'My tickets does not list exactly the paid booking');
      const ticket = await get(`/Booking/${annBooking}`);
      must(/<h2>Ann Novak<\/h2>/.test(ticket.html), 'the ticket page is not titled with the passenger');
      must(new RegExp(`<th>Trip</th><td><a href="/Trip/${busId}">Berlin to Munich</a></td>`).test(ticket.html), 'the trip is missing from the ticket');
      must(/<th>Qty<\/th><td>2<\/td>/.test(ticket.html) && /<th>Total<\/th><td>38\.00<\/td>/.test(ticket.html) && /status">Paid/.test(ticket.html), 'seats, total or status are missing from the ticket');
      const trip = await get(`/Trip/${busId}`);
      must(/<th>Date<\/th><td>2026-10-05<\/td>/.test(trip.html) && /<th>Departure<\/th><td>08:15<\/td>/.test(trip.html), 'the trip page lacks date and departure');
      asGuest();
      return 'one ticket listed; ticket page with passenger, trip, seats, total, status';
    } },
  colorCheck('snow', 'dimgray'),
];
