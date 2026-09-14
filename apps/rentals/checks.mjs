// WebGen-Bench 000038 — short-term apartment rentals.
import { colorCheck } from '../../verify/lib.mjs';

let loft = null, bookingId = null;
const field = (html, name) => (new RegExp(`<th>${name}</th><td>([\\s\\S]*?)</td>`).exec(html) || [, null])[1];

export const checks = [
  { task: 'Searching by a location keyword lists the apartments there',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const all = await get('/Apartment');
      must(all.status === 200 && rows(all.html).length === 6, `catalogue shows ${rows(all.html).length} apartments`);
      loft = idOf(all.html, 'Sunny loft by the river');
      const lisbon = await get('/Apartment?q=lisbon');
      const shown = rows(lisbon.html);
      must(shown.length === 2 && shown.every((r) => /Lisbon/.test(r)), `Lisbon search shows ${shown.length} row(s): ${shown.map((r) => r.slice(0, 60))}`);
      must(rowWith(lisbon.html, 'Sunny loft by the river') && rowWith(lisbon.html, 'Quiet studio near Baixa'), 'a Lisbon apartment is missing');
      const district = await get('/Apartment?q=foz');
      must(rows(district.html).length === 1 && rowWith(district.html, 'Harbour studio'), 'search does not match the neighbourhood');
      must(rows((await get('/Apartment?q=nowhere')).html).length === 0, 'an unknown keyword still lists apartments');
      return 'lisbon → 2, foz → 1, nowhere → 0';
    } },
  { task: 'Filtering by one-bedroom shows only one-bedroom apartments',
    run: async ({ get, rows, must }) => {
      const r = await get('/Apartment?type=one-bedroom');
      const shown = rows(r.html);
      must(shown.length === 2 && shown.every((x) => /<td>one-bedroom<\/td>/.test(x)), `expected 2 one-bedroom rows, got ${shown.length}`);
      must(/aria-current="true">One-bedroom</.test(r.html), 'the active filter is not marked');
      const studios = rows((await get('/Apartment?type=studio')).html);
      must(studios.length === 2 && studios.every((x) => /<td>studio<\/td>/.test(x)), 'the type filter does not switch');
      return '2 one-bedroom rows only; studio filter 2';
    } },
  { task: 'Booking an apartment for chosen dates and confirming it shows the confirmation and marks the dates as booked',
    run: async ({ get, post, follow, rowWith, must, flashOf }) => {
      const wrong = await post(`/Apartment/${loft}/add/Booking`, { checkIn: '2026-10-05', checkOut: '2026-10-01' });
      must(wrong.status === 400 && /Check-out must be after check-in/.test(wrong.html), 'check-out before check-in was accepted');
      let page = await follow(`/Apartment/${loft}/add/Booking`, { checkIn: '2026-10-01', checkOut: '2026-10-05' });
      must(/Booking requested/.test(flashOf(page.html)), `no request confirmation: ${flashOf(page.html)}`);
      const row = rowWith(page.html, '2026-10-01');
      must(row && /2026-10-05/.test(row) && /<td>4<\/td>/.test(row) && /status">Requested/.test(row), `the booking row is wrong: ${row}`);
      bookingId = /\/Booking\/(\d+)/.exec(row)[1];
      page = await follow(`/Booking/${bookingId}/go/confirm`, {});
      must(new RegExp(`Booking #${bookingId} confirmed: Sunny loft by the river, 2026-10-01 to 2026-10-05, 4 night\\(s\\), total 340\\.00`).test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/status">Confirmed/.test(page.html) && field(page.html, 'Total') === '340.00' && field(page.html, 'Nights') === '4', 'the confirmed booking is wrong');
      must(!/go\/confirm"/.test(page.html), 'confirm is still offered');
      const apt = await get(`/Apartment/${loft}`);
      const booked = rowWith(apt.html, '2026-10-01');
      must(booked && /status">Confirmed/.test(booked) && field(apt.html, 'Bookings') === '1', 'the dates are not shown as booked on the apartment');
      return 'bad dates refused; requested → confirmed with total 340.00; dates listed as booked on the apartment';
    } },
  { task: 'The booking records show all past and current bookings of the guest',
    run: async ({ get, rows, rowWith, must }) => {
      const mine = await get('/list/my-bookings');
      must(mine.status === 200, `booking records returned ${mine.status}`);
      const shown = rows(mine.html);
      must(shown.length === 2, `expected 2 bookings (one past, one new), got ${shown.length}`);
      const past = rowWith(mine.html, 'Family flat with terrace');
      must(past && /2026-05-02/.test(past) && /2026-05-06/.test(past) && /<td>4<\/td>/.test(past) && /480\.00/.test(past) && /status">Confirmed/.test(past), `the past booking is wrong: ${past}`);
      const current = rowWith(mine.html, 'Sunny loft by the river');
      must(current && /340\.00/.test(current) && /status">Confirmed/.test(current) && /\d{4}-\d{2}-\d{2}T/.test(current), `the new booking is wrong: ${current}`);
      must(shown[0].includes('Sunny loft'), 'records are not sorted with the latest stay first');
      return 'two records with apartment, dates, nights, total, status and booking time';
    } },
  { task: 'From the booking confirmation page the main menu leads back to a working homepage',
    run: async ({ get, rows, must }) => {
      const page = await get(`/Booking/${bookingId}`);
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(page.html)[1];
      const link = /<a href="([^"]+)">Apartments<\/a>/.exec(nav);
      must(link, 'the menu has no link to the homepage');
      const root = await get('/');
      must(root.location === link[1], `the menu link ${link[1]} is not the homepage ${root.location}`);
      const home = await get(link[1]);
      must(home.status === 200 && rows(home.html).length === 6 && /name="q"/.test(home.html), 'the homepage is not fully loaded');
      return `menu → ${link[1]} = homepage, 6 apartments and the search box`;
    } },
  colorCheck('linen', 'maroon'),
];
