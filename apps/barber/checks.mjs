// webgen-bench/000049 — barber shop management: barbers, services, navigation, colours.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Add a new barber using the provided form with valid information',
    run: async ({ follow, rowWith, must, flashOf }) => {
      const r = await follow('/Barber', { name: 'Priya Nair', phone: '555-0300', specialty: 'Fades', bio: 'Ten years cutting downtown.', active: 'on' });
      must(/Barber added successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Priya Nair');
      must(row && /555-0300/.test(row) && /Fades/.test(row) && /Active/.test(row), `new barber row: ${row}`);
      return "Priya Nair added and listed among the barbers";
    } },
  { task: 'Add a new service using the provided form with valid details',
    run: async ({ follow, get, rowWith, rows, must, flashOf }) => {
      const r = await follow('/Service', { name: 'Skin Fade', description: 'Zero to two on the sides, blended.', price: 28, durationMinutes: 40, active: 'on' });
      must(/Service added successfully/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      const row = rowWith(r.html, 'Skin Fade');
      must(row && /28\.00/.test(row) && /<td>40<\/td>/.test(row), `new service row: ${row}`);
      const list = await get('/Service');
      must(rows(list.html).length === 5, `expected 5 services listed (4 seeded + 1 new), got ${rows(list.html).length}`);
      return "Skin Fade added and listed under available services";
    } },
  { task: 'Navigate through the website from the dashboard to the barbers and services section using a navigation menu',
    run: async (ctx) => navCheck(3).run(ctx) },
  colorCheck('snow', 'dimgray'),
];
