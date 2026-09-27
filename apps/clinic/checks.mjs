// WebGen-Bench 000015 — clinical office brochure site: About, Services, Contact.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Clicking "About Us" in the navigation loads accurate office information (history, mission, team)',
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(/href="\/page\/about"/.test(home.html), 'the homepage has no About Us link');
      const { html, status } = await get('/page/about');
      must(status === 200, `About Us returned ${status}`);
      must(/History/.test(html) && /2009/.test(html), 'no history section');
      must(/Mission/.test(html), 'no mission section');
      must(/Dr\. Amina Farouk/.test(html) && /Dr\. Ben Ostrander/.test(html), 'no team section');
      return 'About Us shows history, mission and team, reached from the homepage';
    } },
  { task: 'Clicking "Services" in the navigation loads every service with an accurate, non-overlapping description',
    run: async ({ get, must }) => {
      const { html, status } = await get('/Service');
      must(status === 200, `Services returned ${status}`);
      const names = ['General consultation', 'Preventive check-ups', 'Chronic care management', 'Minor procedures'];
      for (const n of names) must(new RegExp(n).test(html), `missing service: ${n}`);
      must((html.match(/<tr class="">/g) || []).length === 4, `expected 4 distinct service rows, structure suggests overlap: ${html.match(/<tr class="">/g)?.length}`);
      return 'all four services listed once each with descriptions';
    } },
  { task: 'Clicking "Contact Us" loads a page with a form for name, email, phone and message, with clear instructions',
    run: async ({ get, must }) => {
      const contact = await get('/ContactMessage');
      must(contact.status === 200 && /Riverside Family Clinic/.test(contact.html) && /office@riversideclinic\.test/.test(contact.html), 'contact details are missing');
      const form = await get('/ContactMessage/new');
      must(form.status === 200, `contact form returned ${form.status}`);
      must(/Fill in your name, email, phone and message/.test(form.html), 'no instructions for filling the form');
      for (const f of ['name', 'email', 'phone', 'message']) must(new RegExp(`name="${f}"`).test(form.html), `contact form is missing field ${f}`);
      return 'Contact Us shows office details and a linked form with name, email, phone, message';
    } },
  { task: 'Filling out and submitting the contact form with valid input succeeds with a confirmation',
    run: async ({ follow, must, flashOf }) => {
      const r = await follow('/ContactMessage', { name: 'Wendy Cole', email: 'wendy@example.test', phone: '555-0177', message: 'I would like to schedule a preventive check-up next week.' });
      must(r.status === 200, `submitting the contact form returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/received your message/.test(flashOf(r.html)), `no confirmation message: ${flashOf(r.html)}`);
      must(/Wendy Cole/.test(r.html), 'the message was not recorded');
      return 'contact message recorded with a confirmation message';
    } },
  colorCheck('lightcyan', 'cadetblue'),
];
