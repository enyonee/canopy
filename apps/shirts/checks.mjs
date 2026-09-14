// WebGen-Bench 000037 — custom shirt design, preview, order and payment.
import { colorCheck } from '../../verify/lib.mjs';

let designId = null, slim = null, linen = null, silk = null;
const field = (html, name) => (new RegExp(`<th>${name}</th><td>([\\s\\S]*?)</td>`).exec(html) || [, null])[1];
const option = (html, select, text) => (new RegExp(`<select id="f_${select}" name="${select}">[\\s\\S]*?<option value="(\\d+)"[^>]*>${text}</option>`).exec(html) || [, null])[1];

export const checks = [
  { task: 'The main menu leads to the customization page where model, fabric and measurements are asked',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      const link = /<a href="([^"]+)">Customize a shirt<\/a>/.exec(nav);
      must(link, 'the menu has no "Customize a shirt" entry');
      const page = await get(link[1]);
      must(page.status === 200 && /href="\/Design\/new"/.test(page.html), 'the customization section does not offer a new design');
      const form = await get('/Design/new');
      must(form.status === 200 && /<h2>Design your shirt<\/h2>/.test(form.html), 'the design form did not open');
      must(/<select id="f_model" name="model">/.test(form.html) && /<select id="f_fabric" name="fabric">/.test(form.html), 'model and fabric are not offered as choices');
      for (const m of ['chest', 'waist', 'sleeve']) must(new RegExp(`<input type="number" id="f_${m}" name="${m}"`).test(form.html), `measurement ${m} is not asked`);
      must(!/name="cardNumber"/.test(form.html) && !/name="status"/.test(form.html), 'payment or status fields leak into the design form');
      slim = option(form.html, 'model', 'Slim fit'); linen = option(form.html, 'fabric', 'Linen'); silk = option(form.html, 'fabric', 'Silk');
      must(slim && linen && silk, 'seeded models and fabrics are not offered');
      return 'menu → Customize a shirt → form with model, fabric, chest, waist, sleeve';
    } },
  { task: 'A complete set of options is accepted and the form submits',
    run: async ({ post, get, must, flashOf }) => {
      const r = await post('/Design', { customer: 'Ann Lee', model: slim, fabric: linen, chest: 100, waist: 90, sleeve: 64 });
      must(r.status === 303, `submitting a valid design returned ${r.status}: ${r.html.slice(0, 300)}`);
      const m = /^\/Design\/(\d+)/.exec(r.location);
      must(m, `did not land on the design page: ${r.location}`);
      designId = m[1];
      const page = await get(r.location);
      must(/Design generated/.test(flashOf(page.html)), `no confirmation: ${flashOf(page.html)}`);
      must(!/class="error"/.test(page.html), 'errors are shown for valid input');
      must(field(page.html, 'Chest') === '100' && field(page.html, 'Waist') === '90' && field(page.html, 'Sleeve') === '64', 'measurements were not stored');
      return `design #${designId} saved without errors`;
    } },
  { task: 'A design preview is generated from the chosen model, fabric and measurements, with its price',
    run: async ({ get, must }) => {
      const page = await get(`/Design/${designId}`);
      must(field(page.html, 'Preview') === 'Slim fit shirt in linen, chest 100 cm, waist 90 cm, sleeve 64 cm', `preview is: ${field(page.html, 'Preview')}`);
      must(field(page.html, 'Price') === '75.00', `price should be 60 + 15, got ${field(page.html, 'Price')}`);
      must(/status">Draft/.test(page.html), 'a fresh design is not a draft');
      return 'preview text names model, fabric and all three measurements; price 75.00';
    } },
  { task: 'Changing the fabric regenerates the preview and the price',
    run: async ({ follow, must, flashOf }) => {
      const page = await follow(`/Design/${designId}`, { customer: 'Ann Lee', model: slim, fabric: silk, chest: 100, waist: 90, sleeve: 64 });
      must(/Design regenerated/.test(flashOf(page.html)), `no confirmation: ${flashOf(page.html)}`);
      must(field(page.html, 'Preview') === 'Slim fit shirt in silk, chest 100 cm, waist 90 cm, sleeve 64 cm', `preview did not follow the fabric: ${field(page.html, 'Preview')}`);
      must(field(page.html, 'Price') === '100.00', `price should follow the silk surcharge, got ${field(page.html, 'Price')}`);
      return 'linen → silk: preview and price (100.00) updated';
    } },
  { task: 'Confirming the design leads to the checkout page with the shirt details and the price',
    run: async ({ follow, post, must, flashOf }) => {
      const page = await follow(`/Design/${designId}/go/confirm`, {});
      must(/Design confirmed/.test(flashOf(page.html)), `no confirmation: ${flashOf(page.html)}`);
      must(/status">Confirmed/.test(page.html), 'status did not move to confirmed');
      must(/Slim fit shirt in silk/.test(page.html) && field(page.html, 'Price') === '100.00', 'the checkout page does not show the shirt and its price');
      must(new RegExp(`action="/Design/${designId}/go/pay"`).test(page.html), 'no payment form on the checkout page');
      for (const f of ['address', 'cardName', 'cardNumber']) must(new RegExp(`name="${f}"`).test(page.html), `checkout does not ask for ${f}`);
      must(!/go\/confirm"/.test(page.html), 'confirm is still offered');
      must((await post(`/Design/${designId}/go/confirm`, {})).status === 409, 'confirming twice was accepted');
      return 'confirmed → checkout page with preview, price 100.00 and the payment form';
    } },
  { task: 'Shipping and card details are accepted, the order is placed and confirmed',
    run: async ({ post, follow, get, rowWith, must, flashOf }) => {
      const noAddress = await post(`/Design/${designId}/go/pay`, { cardName: 'Ann Lee', cardNumber: '4242424242424242' });
      must(noAddress.status === 400 && /address is required/.test(noAddress.html), 'a missing address was accepted');
      const badCard = await post(`/Design/${designId}/go/pay`, { address: '5 Elm st, Bath', cardName: 'Ann Lee', cardNumber: '1234' });
      must(badCard.status === 400 && /Card number must have 16 digits/.test(badCard.html), 'an invalid card number was accepted');
      const page = await follow(`/Design/${designId}/go/pay`, { address: '5 Elm st, Bath', cardName: 'Ann Lee', cardNumber: '4242424242424242' });
      must(new RegExp(`Order #${designId} confirmed — 100\\.00 charged to the card of Ann Lee, shipping to 5 Elm st, Bath`).test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/status">Paid/.test(page.html) && field(page.html, 'Address') === '5 Elm st, Bath', 'the order is not paid with its address');
      must(!/4242424242424242/.test(page.html), 'the card number is printed on the page');
      const orders = await get('/list/orders');
      const row = rowWith(orders.html, 'Ann Lee');
      must(row && /100\.00/.test(row) && /status">Paid/.test(row), 'the paid order is not in the orders list');
      must(rowWith(orders.html, 'Nora Vale') && !rowWith(orders.html, 'Tom Reed'), 'the orders list does not filter to paid designs');
      return 'missing address and bad card refused; paid with confirmation; listed under Orders';
    } },
  { task: 'Invalid measurements are refused with a message that says what to correct',
    run: async ({ post, must }) => {
      const small = await post('/Design', { customer: 'Bo', model: slim, fabric: linen, chest: 5, waist: 90, sleeve: 64 });
      must(small.status === 400 && /Chest must be between 70 and 160 cm/.test(small.html), 'chest 5 cm was accepted');
      const missing = await post('/Design', { customer: 'Bo', model: slim, fabric: linen, waist: 90, sleeve: 64 });
      must(missing.status === 400 && /chest is required/.test(missing.html), 'a missing chest was accepted');
      const text = await post('/Design', { customer: 'Bo', model: slim, fabric: linen, chest: 'wide', waist: 90, sleeve: 64 });
      must(text.status === 400 && /chest must be a number/.test(text.html), 'a non-numeric chest was accepted');
      const two = await post('/Design', { customer: 'Bo', model: slim, fabric: linen, chest: 100, waist: 10, sleeve: 99 });
      must(two.status === 400 && /Waist must be between 60 and 150 cm/.test(two.html) && /Sleeve must be between 50 and 80 cm/.test(two.html), 'both wrong measurements should be reported');
      must(/value="100"/.test(two.html), 'the form does not keep the valid values for correction');
      return 'out of range, missing and non-numeric measurements refused; several messages at once; form keeps input';
    } },
  colorCheck('floralwhite', 'darkgoldenrod'),
];
