// WebGen-Bench 000021 — The All-In Bourbon Bar brochure site: menu, poker room, events, reservations.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigating to the menu page using the main navigation bar shows an up-to-date list of food and drink items with descriptions and prices',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(/href="\/MenuItem"[^>]*>Menu/.test(home.html), 'no Menu link in the main navigation');
      const { html, status } = await get('/MenuItem');
      must(status === 200, `menu page returned ${status}`);
      must(/All-In Old Fashioned/.test(html) && /14\.00/.test(html), 'a drink is missing its price');
      must(/Bourbon-Glazed Wings/.test(html) && /pickled celery/.test(html), 'a food item is missing its description');
      must(/High-Rye Single Barrel/.test(html) && /26\.00/.test(html), 'a bourbon pour is missing');
      return 'five menu items with descriptions and prices, reached from the main nav';
    } },
  { task: 'Accessing the private poker room information page from the main menu gives a detailed introduction including membership benefits and how to join',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(/href="\/page\/poker-room"[^>]*>Poker Room/.test(home.html), 'no Poker Room link in the main navigation');
      const { html, status } = await get('/page/poker-room');
      must(status === 200, `poker room page returned ${status}`);
      must(/Membership benefits/.test(html) && /private bourbon locker/.test(html), 'membership benefits are missing');
      must(/How to join/.test(html) && /referral from a current member/.test(html), 'how to join is missing');
      return 'poker room page details membership benefits and how to join';
    } },
  { task: "Clicking the events and promotions section from the homepage shows current and upcoming events and promotions with dates and offers",
    run: async ({ get, rows, must }) => {
      const home = await get('/page/home');
      must(/href="\/Happening"[^>]*>Events &amp; Promotions/.test(home.html), 'no Events & Promotions link on the homepage');
      const { html, status } = await get('/Happening');
      must(status === 200, `events and promotions page returned ${status}`);
      const items = rows(html);
      must(items.length === 4, `expected 4 events/promotions, got ${items.length}`);
      must(/2026-10-03/.test(items[0]) && /Live blues Friday/.test(items[0]), 'the soonest happening is not first');
      must(/50% off bourbon flights/.test(html), 'a promotion offer is missing');
      must(/Whiskey tasting night/.test(html), 'an event is missing');
      return '4 events/promotions, soonest first, with descriptions and offers';
    } },
  { task: "Attempting a reservation through the website's reservation form accepts the input and confirms success",
    run: async ({ follow, post, must, flashOf }) => {
      const r = await follow('/Reservation', { name: 'Gale Mercer', email: 'gale@example.test', phone: '555-0161',
        partySize: 4, date: '2026-10-25', time: '20:00', notes: 'Celebrating a birthday, window table if possible.' });
      must(r.status === 200, `reservation submission returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/Reservation received/.test(flashOf(r.html)), `no confirmation message: ${flashOf(r.html)}`);
      must(/<td>4<\/td>/.test(r.html) && /<td>requested<\/td>/.test(r.html), 'the reservation was not recorded with the submitted details');
      const bad = await post('/Reservation', { name: 'Bad Guest', email: 'bad@example.test', partySize: 0, date: '2026-10-25', time: '20:00' });
      must(bad.status === 400 && /Party size must be at least 1/.test(bad.html), `an invalid party size was accepted: ${bad.status}`);
      return 'valid reservation recorded and confirmed; a zero party size is refused';
    } },
  colorCheck('peachpuff', 'indianred'),
];
