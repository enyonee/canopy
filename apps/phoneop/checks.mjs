// WebGen-Bench 000020 — phone operator brochure site: chat, plans, account, nav, colours.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'The online customer support chat tool can be reached from the homepage and confirms an agent will follow up',
    run: async ({ get, follow, must, flashOf }) => {
      const home = await get('/page/home');
      must(/href="\/SupportRequest"/.test(home.html), 'no link to customer support from the homepage');
      const chat = await get('/SupportRequest');
      must(chat.status === 200 && /Start a chat/.test(chat.html), 'the support page does not offer to start a chat');
      const r = await follow('/SupportRequest', { topic: 'billing', message: 'My last bill looks higher than usual, can someone check it?' });
      must(r.status === 200, `starting a chat returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/agent will assist you shortly/.test(flashOf(r.html)), `no confirmation: ${flashOf(r.html)}`);
      return 'chat message sent from the homepage link; confirmation that an agent will assist shortly';
    } },
  { task: 'Clicking a service plan navigates to a dedicated page with comprehensive details: features, benefits and pricing',
    run: async ({ get, idOf, must }) => {
      const list = await get('/ServicePlan');
      must(list.status === 200 && /Family 40GB/.test(list.html), 'service plans are not listed');
      const id = idOf(list.html, 'Family 40GB');
      const { html, status } = await get(`/ServicePlan/${id}`);
      must(status === 200, `plan detail returned ${status}`);
      must(/65\.00/.test(html), 'pricing is not shown');
      must(/40 GB shared/.test(html) && /Unlimited/.test(html), 'data/minutes/SMS allowances are not shown');
      must(/Shared across up to 4 lines/.test(html), 'plan features/benefits are not shown');
      return 'Family 40GB detail shows pricing, allowances and features';
    } },
  { task: 'Users can navigate to account management, update their personal information, and get a success message',
    run: async ({ get, follow, must, flashOf }) => {
      const home = await get('/page/home');
      must(/href="\/Profile\/1"/.test(home.html), 'no link to My Account from the homepage');
      const before = await get('/Profile/1');
      must(before.status === 200 && /Jamie Lee/.test(before.html), 'the account page does not show the current profile');
      must(/href="\/Profile\/1\/edit"/.test(before.html), 'no way to edit the account from its page');
      const r = await follow('/Profile/1', { name: 'Jamie R. Lee', email: 'jamie.lee@example.test', phone: '+1 555 0177', address: '99 New address, Rivertown' });
      must(r.status === 200, `updating the account returned ${r.status}: ${r.html.slice(0, 200)}`);
      must(/updated successfully/.test(flashOf(r.html)), `no success message: ${flashOf(r.html)}`);
      must(/Jamie R\. Lee/.test(r.html) && /jamie\.lee@example\.test/.test(r.html) && /99 New address/.test(r.html), 'the updated information is not shown');
      return 'account updated (name, email, phone, address), success message shown';
    } },
  { task: 'The navigation menu on every page includes direct links to Service Plans and Customer Support',
    run: async ({ get, must }) => {
      for (const path of ['/page/home', '/ServicePlan', '/SupportRequest']) {
        const { html, status } = await get(path);
        must(status === 200, `${path} returned ${status}`);
        must(/href="\/ServicePlan"[^>]*>Service Plans/.test(html), `${path} nav is missing Service Plans`);
        must(/href="\/SupportRequest"[^>]*>Customer Support/.test(html), `${path} nav is missing Customer Support`);
      }
      return 'Service Plans and Customer Support links present on every page checked';
    } },
  colorCheck('lightgoldenrodyellow', 'olivedrab'),
];
