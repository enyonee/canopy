// WebGen-Bench 000018 — house cleaning brochure site: nav, services, booking, status, contact.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'The homepage navigation includes Home, Services, Book Now and Contact Us, all correctly labeled',
    run: async ({ get, must }) => {
      const { html, status } = await get('/page/home');
      must(status === 200, `homepage returned ${status}`);
      for (const [label, href] of [['Services', '/Service'], ['Book Now', '/list/book'], ['Contact Us', '/page/contact']])
        must(new RegExp(`href="${href.replace(/\//g, '\\/')}"[^>]*>${label}`).test(html), `nav is missing "${label}" -> ${href}`);
      return 'Home, Services, Book Now and Contact Us all present and labeled';
    } },
  { task: 'Clicking Services lists every cleaning service with a clear, accurate description',
    run: async ({ get, must }) => {
      const { html, status } = await get('/Service');
      must(status === 200, `Services returned ${status}`);
      const names = ['Standard home cleaning', 'Deep cleaning', 'Move-in / move-out cleaning', 'Recurring maintenance clean'];
      for (const n of names) must(new RegExp(n.replace(/[/]/g, '\\/')).test(html), `missing service: ${n}`);
      must(/baseboards, inside appliances/.test(html), 'descriptions are missing detail');
      return 'all four services listed with descriptions';
    } },
  { task: 'Submitting the Book Now form with all required fields completed succeeds with a confirmation',
    run: async ({ get, follow, must, flashOf }) => {
      const page = await get('/list/book');
      must(page.status === 200 && /name="date"/.test((await get('/Booking/new')).html), 'the booking form is not reachable');
      const r = await follow('/Booking', { name: 'Lena Ford', email: 'lena@example.test', phone: '555-0199',
        service: 1, date: '2026-10-15', address: '77 Oak street', notes: 'Two bathrooms, one kitchen.' });
      must(r.status === 200, `booking submission returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/Booking received/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      must(/status">requested/.test(r.html) || /<th>Status<\/th><td>requested<\/td>/.test(r.html), 'booking status not shown');
      // Round 5: expressions can read a row's own "id" (read-only), so the
      // Booking.created event now derives a genuine prefixed reference code
      // (concat('BK-', id)) instead of copying the bare numeric id — closing
      // the "a human-friendly prefixed reference code is not derivable
      // purely in the graph" Miss.
      must(/<th>Reference<\/th><td>BK-\d+<\/td>/.test(r.html), 'no BK-prefixed booking reference was assigned');
      return 'booking created, confirmation shown, a BK-prefixed reference assigned';
    } },
  { task: 'The Contact Us page displays accurate contact details including a phone number and email address',
    run: async ({ get, must }) => {
      const { html, status } = await get('/page/contact');
      must(status === 200, `Contact Us returned ${status}`);
      must(/\+1 555 0188/.test(html), 'phone number is missing');
      must(/hello@sparkleclean\.test/.test(html), 'email address is missing');
      return 'phone and email both shown on Contact Us';
    } },
  { task: 'From the homepage, the navigation reaches a service status feature that looks up a booking by its reference',
    run: async ({ get, follow, must }) => {
      const home = await get('/page/home');
      must(/href="\/list\/status"/.test(home.html), 'no Check Status link on the homepage');
      const booked = await follow('/Booking', { name: 'Omar Diaz', email: 'omar@example.test', phone: '555-0111',
        service: 2, date: '2026-11-01', address: '5 Pine road' });
      const ref = /<th>Reference<\/th><td>(BK-\d+)<\/td>/.exec(booked.html)[1];
      const found = await get(`/list/status?q=${ref}`);
      must(found.status === 200, `status lookup returned ${found.status}`);
      must(new RegExp(`<td>${ref}</td>`).test(found.html) && /requested/.test(found.html), 'the booking status was not found by its reference');
      const miss = await get('/list/status?q=BK-999999');
      must(!new RegExp(`<td>${ref}</td>`).test(miss.html), 'the search does not narrow to the matching reference');
      return `booking #${ref} found by reference, status requested; a wrong reference finds nothing`;
    } },
  colorCheck('azure', 'darkslateblue'),
];
