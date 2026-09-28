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
      // Round 5's pages[].sections embeds a real, browsable TeamMember
      // catalogue (a saved list) on the static About Us page itself — closing
      // the "no way to render dynamic entity rows inside a static page" Miss
      // this app used to record; the team is now data, not only prose.
      must(/Dr\. Amina Farouk/.test(html) && /Dr\. Ben Ostrander/.test(html) && /Carla Nunes/.test(html), 'no team section');
      must(/<table>[\s\S]*Dr\. Amina Farouk[\s\S]*<\/table>/.test(html), 'the team is not rendered as a real, structured table');
      must(/clinic director/.test(html), 'a team member\'s role is not shown alongside their name');
      return 'About Us shows history, mission and a real, data-driven team directory, reached from the homepage';
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
      // Round 5's pages[].sections ({ "form": "Entity" }) closes this case's
      // own Weakened Case ("the Contact Us page includes a form" used to need
      // one extra hop to a separate /ContactMessage/new): the static Contact
      // Us page now embeds the real create form directly, office details and
      // form on the same page, literally.
      const contact = await get('/page/contact');
      must(contact.status === 200 && /Riverside Family Clinic/.test(contact.html) && /office@riversideclinic\.test/.test(contact.html), 'contact details are missing');
      must(/Fill in your name, email, phone and message/.test(contact.html), 'no instructions for filling the form');
      for (const f of ['name', 'email', 'phone', 'message']) must(new RegExp(`name="${f}"`).test(contact.html), `contact form is missing field ${f}`);
      must(/action="\/ContactMessage"/.test(contact.html), 'the embedded form does not post to the real ContactMessage create route');
      return 'Contact Us shows office details and a real, embedded form (name, email, phone, message) on the very same page';
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
