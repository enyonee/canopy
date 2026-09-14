// WebGen-Bench 000097 — travel and camping portal for Europe. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

let eiffelId = null, tuscanyBooking = null;
const cells = (row) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

export const checks = [
  { task: 'Search for tourist attractions in Paris: name, location and a description are shown',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const { html, status } = await get('/Place?kind=attraction&q=Paris');
      must(status === 200, `search returned ${status}`);
      const eiffel = rowWith(html, 'Eiffel Tower'), louvre = rowWith(html, 'Louvre Museum');
      must(eiffel && louvre, 'the Paris attractions are missing from the result');
      must(!rowWith(html, 'Camping Bois de Boulogne'), 'a campsite is listed among the attractions');
      must(!rowWith(html, 'Colosseum') && !rowWith(html, 'Sagrada Familia'), 'the search does not narrow to Paris');
      must(/<td>attraction<\/td>/.test(eiffel) && /Paris/.test(eiffel) && /France<\/a>/.test(eiffel) && /25\.00/.test(eiffel),
        `the row lacks kind, city, country or price: ${eiffel}`);
      eiffelId = idOf(html, 'Eiffel Tower', 'Place');
      const detail = await get(`/Place/${eiffelId}`);
      must(/<th>About<\/th><td>Wrought-iron tower on the Champ de Mars/.test(detail.html), 'the description is not on the attraction page');
      must(/<th>City<\/th><td>Paris<\/td>/.test(detail.html) && /<th>Country<\/th><td><a href="\/Country\/\d+">France<\/a>/.test(detail.html), 'location is missing on the page');
      const all = await get('/Place?q=paris');
      must(rows(all.html).length === 3, `a case-insensitive search for paris should list 3 places, got ${rows(all.html).length}`);
      return 'Eiffel Tower and Louvre only; kind, city, country, price; description on the page';
    } },
  { task: 'Book a campsite in Tuscany, Italy, through to a confirmed booking with date and location',
    run: async ({ get, post, follow, rowWith, idOf, must, flashOf }) => {
      const italy = idOf((await get('/Country')).html, 'Italy', 'Country');
      const list = await get(`/Place?country=${italy}&kind=campsite`);
      must(rowWith(list.html, 'Camping Tuscany Hills') && !rowWith(list.html, 'Camping Bavaria Alpine'), 'the Italian campsites are not filtered');
      const tuscany = idOf(list.html, 'Camping Tuscany Hills', 'Place');
      const r = await post('/Booking', { place: tuscany, name: 'Mia Rossi', email: 'mia@example.test', date: '2026-10-03', time: '15:00', guests: 2, nights: 3 });
      must(r.status === 303 && /^\/Booking\/\d+/.test(r.location), `booking returned ${r.status} ${r.location}: ${r.html.slice(0, 200)}`);
      tuscanyBooking = /^\/Booking\/(\d+)/.exec(r.location)[1];
      let page = await get(r.location);
      must(/Booking received/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/<th>Location<\/th><td>Siena, Tuscany, Italy<\/td>/.test(page.html), 'the location is not derived from the campsite');
      must(/<th>Date<\/th><td>2026-10-03<\/td>/.test(page.html) && /<th>Total<\/th><td>168\.00<\/td>/.test(page.html), 'date or total (3 nights x 2 guests x 28.00) is wrong');
      must(/status">Requested/.test(page.html) && new RegExp(`action="/Booking/${tuscanyBooking}/go/confirm"`).test(page.html) && /name="paymentMethod"/.test(page.html),
        'the confirm-and-pay step is not offered');
      page = await follow(`/Booking/${tuscanyBooking}/go/confirm`, { paymentMethod: 'paypal' });
      must(new RegExp(`Booking #${tuscanyBooking} confirmed: Camping Tuscany Hills, Siena, Tuscany, Italy on 2026-10-03 at 15:00, total 168.00`).test(flashOf(page.html)),
        `confirmation flash: ${flashOf(page.html)}`);
      must(/status">Confirmed/.test(page.html) && /<th>Payment Method<\/th><td>paypal<\/td>/.test(page.html), 'the booking is not confirmed with its payment method');
      must((await post(`/Booking/${tuscanyBooking}/go/confirm`, { paymentMethod: 'card' })).status === 409, 'a confirmed booking could be confirmed twice');
      const outbox = await get('/outbox');
      const mail = rowWith(outbox.html, 'mia@example.test');
      must(mail && new RegExp(`Booking #${tuscanyBooking} confirmed`).test(mail) && /status">sent/.test(mail), 'the confirmation letter is not in the outbox');
      return 'requested, total 168.00, confirmed by paypal, letter sent, second confirm 409';
    } },
  { task: 'Submit a review with a rating for a campsite in Bavaria; it appears under the campsite',
    run: async ({ get, post, follow, rowWith, idOf, must, flashOf }) => {
      const list = await get('/Place?kind=campsite&q=Bavaria');
      const bavaria = idOf(list.html, 'Camping Bavaria Alpine', 'Place');
      const before = await get(`/Place/${bavaria}`);
      must(/<th>Reviews<\/th><td>2<\/td>/.test(before.html) && /<th>Rating<\/th><td>4<\/td>/.test(before.html), 'the seeded reviews are not counted');
      const bad = await post(`/Place/${bavaria}/add/Review`, { author: 'Jonas Weber', stars: 7, text: 'Great' });
      must(bad.status === 400 && /Rating must be between 1 and 5/.test(bad.html), 'a rating of 7 was accepted');
      const page = await follow(`/Place/${bavaria}/add/Review`, { author: 'Jonas Weber', stars: 4, text: 'Clean pitches and a great view of the Alps.' });
      must(/Review published/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      const row = rowWith(page.html, 'Clean pitches and a great view');
      must(row && /Jonas Weber/.test(row) && cells(row)[1] === '4', `the review row is missing or wrong: ${row}`);
      must(/<th>Reviews<\/th><td>3<\/td>/.test(page.html) && /<th>Rating<\/th><td>4<\/td>/.test(page.html), 'the derived count and average did not follow the new review');
      const catalog = await get('/Place?q=Bavaria+Alpine');
      must(cells(rowWith(catalog.html, 'Camping Bavaria Alpine'))[6] === '3', 'the public listing does not show the review count');
      return 'rule 1..5 enforced; review listed with 4 stars; 3 reviews, average 4';
    } },
  { task: 'Navigate the country sections: each shows its own attractions and campsites',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const countries = await get('/Country');
      must(rows(countries.html).length === 4, `expected 4 countries, got ${rows(countries.html).length}`);
      const expect = { France: ['Eiffel Tower', 'Camping Bois de Boulogne'], Italy: ['Colosseum', 'Camping Tuscany Hills'],
        Germany: ['Neuschwanstein Castle', 'Camping Bavaria Alpine'], Spain: ['Sagrada Familia', 'Camping Costa Brava'] };
      const others = (name) => Object.entries(expect).filter(([n]) => n !== name).flatMap(([, p]) => p);
      for (const [name, places] of Object.entries(expect)) {
        const id = idOf(countries.html, name, 'Country');
        const section = await get(`/Country/${id}`);
        must(section.status === 200, `${name} section returned ${section.status}`);
        for (const p of places) must(rowWith(section.html, p), `${p} is missing from the ${name} section`);
        for (const p of others(name)) must(!rowWith(section.html, p), `${p} leaked into the ${name} section`);
        const filtered = await get(`/Place?country=${id}`);
        for (const p of places) must(rowWith(filtered.html, p), `${p} is missing from the ${name} filter`);
        for (const p of others(name)) must(!rowWith(filtered.html, p), `${p} leaked into the ${name} filter`);
      }
      must(cells(rowWith(countries.html, 'France'))[1] === '3', 'the place count per country is not derived');
      return '4 sections, each with only its own places, count per country';
    } },
  { task: 'Book a tourist attraction: name, date and time are required, then a confirmation page shows the details',
    run: async ({ get, post, must, flashOf }) => {
      const form = await get('/Booking/new');
      must(form.status === 200 && /name="place"/.test(form.html), 'the booking form is missing');
      for (const f of ['name', 'email', 'time']) must(new RegExp(`<input type="text" id="f_${f}" name="${f}"[^>]*required>`).test(form.html), `${f} is not a required field`);
      must(/<input type="date" id="f_date" name="date"[^>]*required>/.test(form.html), 'date is not a required field');
      const bad = await post('/Booking', { place: eiffelId, guests: 2 });
      must(bad.status === 400, `an empty booking was accepted: ${bad.status}`);
      for (const f of ['name', 'email', 'date', 'time']) must(new RegExp(`${f} is required`).test(bad.html), `no message that ${f} is required`);
      const r = await post('/Booking', { place: eiffelId, name: 'Omar Haddad', email: 'omar@example.test', date: '2026-11-12', time: '10:30', guests: 2, nights: 1 });
      must(r.status === 303 && /^\/Booking\/\d+/.test(r.location), `booking returned ${r.status}`);
      const page = await get(r.location);
      must(/Booking received/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(new RegExp(`<th>Place</th><td><a href="/Place/${eiffelId}">Eiffel Tower</a></td>`).test(page.html), 'the attraction is not on the confirmation page');
      must(/<th>Name<\/th><td>Omar Haddad<\/td>/.test(page.html) && /<th>Date<\/th><td>2026-11-12<\/td>/.test(page.html) && /<th>Time<\/th><td>10:30<\/td>/.test(page.html),
        'name, date or time is missing on the confirmation page');
      must(/<th>Location<\/th><td>Paris, France<\/td>/.test(page.html) && /<th>Total<\/th><td>50\.00<\/td>/.test(page.html), 'location or total (2 x 25.00) is wrong');
      return 'four required fields refused when empty; confirmation page with place, name, date, time, total 50.00';
    } },
  colorCheck('lightpink', 'mediumvioletred'),
];
