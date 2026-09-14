// WebGen-Bench 000040 — consulting business site with an e-commerce component.
import { colorCheck } from '../../verify/lib.mjs';

const field = (html, name) => (new RegExp(`<th>${name}</th><td>([\\s\\S]*?)</td>`).exec(html) || [, null])[1];

export const checks = [
  { task: 'The navigation bar reaches Home, Services, Workshops, Online Classes, Podcasts, Blogs and Contact',
    run: async ({ get, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      const seen = [];
      for (const title of ['Home', 'Services', 'Workshops', 'Online Classes', 'Podcasts', 'Blogs', 'Contact']) {
        const m = new RegExp(`<a href="([^"]+)">${title}</a>`).exec(nav);
        must(m, `the menu has no "${title}"`);
        const page = await get(m[1]);
        must(page.status === 200 && new RegExp(`<h2>[^<]*</h2>`).test(page.html), `${title} (${m[1]}) returned ${page.status}`);
        seen.push(`${title}→${m[1]}`);
      }
      must(/<h2>Leadership and business training/.test(home.html), 'the homepage has no heading');
      return seen.join(', ');
    } },
  { task: 'A service is added to the cart, checked out with payment details and confirmed',
    run: async ({ get, post, follow, rows, rowWith, idOf, must, flashOf }) => {
      const services = await get('/Service');
      must(rows(services.html).length === 4, 'the services are not listed');
      const coaching = idOf(services.html, 'Executive coaching'), assessment = idOf(services.html, 'Leadership 360 assessment');
      let cart = await follow(`/Service/${coaching}/action/addToCart`, {});
      must(/Added to your cart/.test(flashOf(cart.html)) && /Executive coaching/.test(rowWith((await get(`/Order/${idOf(cart.html, 'Cart')}`)).html, 'Executive coaching') || ''), `flash: ${flashOf(cart.html)}`);
      cart = await follow(`/Service/${assessment}/action/addToCart`, {});
      const row = rowWith(cart.html, 'Cart');
      must(row && /<td>2<\/td>/.test(row) && /630\.00/.test(row), `cart row: ${row}`);
      const orderId = idOf(cart.html, 'Cart');
      const detail = await get(`/Order/${orderId}`);
      must(/Executive coaching/.test(detail.html) && /Leadership 360 assessment/.test(detail.html) && field(detail.html, 'Total') === '630.00', 'the checkout page does not list the services');
      const bad = await post(`/Order/${orderId}/go/checkout`, { address: '12 Harbour street', paymentMethod: 'card', cardNumber: '1234' });
      must(bad.status === 400 && /Card number must have 16 digits/.test(bad.html), 'an invalid card was accepted');
      const paid = await follow(`/Order/${orderId}/go/checkout`, { address: '12 Harbour street', paymentMethod: 'card', cardNumber: '4242424242424242' });
      must(new RegExp(`Thank you, Jordan Blake — order #${orderId} paid, total 630\\.00`).test(flashOf(paid.html)), `flash: ${flashOf(paid.html)}`);
      must(/status">Paid/.test(paid.html) && field(paid.html, 'Address') === '12 Harbour street', 'the order is not paid with its address');
      must(rows((await get('/list/cart')).html).length === 0, 'the paid order is still in the cart');
      must(/630\.00/.test(rowWith((await get('/list/my-orders')).html, 'card') || ''), 'the paid order is not in My orders');
      const outbox = await get('/outbox');
      must(rows(outbox.html).some((x) => /<td>mail<\/td>/.test(x) && /jordan@example\.test/.test(x) && new RegExp(`Order #${orderId} confirmed`).test(x)), 'no confirmation letter was sent');
      return '2 services, total 630.00; bad card refused; paid with confirmation, letter in the outbox';
    } },
  { task: 'The Blogs page has readable posts relevant to leadership and business training',
    run: async ({ get, rows, rowWith, idOf, must }) => {
      const blogs = await get('/Post');
      must(blogs.status === 200 && /<h2>Blogs<\/h2>/.test(blogs.html), 'the Blogs page did not open');
      const shown = rows(blogs.html);
      must(shown.length === 3, `expected 3 posts, got ${shown.length}`);
      for (const r of shown) {
        must(/leader|training|delegat/i.test(r), `a post is off topic: ${r.slice(0, 120)}`);
        must(/\d{4}-\d{2}-\d{2}/.test(r), 'a post has no date');
      }
      must(/2026-09-05/.test(shown[0]), 'posts are not newest first');
      const post = await get(`/Post/${idOf(blogs.html, 'Five habits of leaders who keep their teams')}`);
      must(field(post.html, 'Author') === 'Hanna Berg' && field(post.html, 'Published At') === '2026-09-05', 'author or date missing');
      const body = field(post.html, 'Body') || '';
      must(body.length > 300 && /leadership training/.test(body), 'the post body is too short or off topic');
      must(rows((await get('/Post?q=delegate')).html).length === 1, 'searching the posts does not narrow');
      return '3 dated posts on leadership, newest first, full body on the post page, search works';
    } },
  { task: 'The workshop schedule shows dates, topics and speakers, and registration works from the page',
    run: async ({ get, post, follow, rows, rowWith, idOf, must, flashOf }) => {
      const list = await get('/Workshop');
      const shown = rows(list.html);
      must(shown.length === 4, `expected 4 workshops, got ${shown.length}`);
      must(/2026-10-08/.test(shown[0]) && /2026-11-19/.test(shown[3]), 'the schedule is not in date order');
      const change = rowWith(list.html, 'Leading through change');
      must(change && /2026-10-08/.test(change) && /Change management/.test(change) && /Dr\. Amara Osei/.test(change) && /Berlin/.test(change), `schedule row: ${change}`);
      const id = idOf(list.html, 'Leading through change');
      must(new RegExp(`action="/Workshop/${id}/action/register"`).test(change), 'no register button on the schedule row');
      const page = await follow(`/Workshop/${id}/action/register`, {});
      must(/You are registered — registration #\d+/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      must(/<h2>Leading through change<\/h2>/.test(page.html) && field(page.html, 'Date') === '2026-10-08', 'the confirmation did not land on the workshop');
      must(field(page.html, 'Seats Left') === '19' && field(page.html, 'Registered') === '1' && /Jordan Blake/.test(page.html), 'the registration is not reflected');
      const full = idOf(list.html, 'Strategy for first-time managers');
      const refused = await post(`/Workshop/${full}/action/register`, {});
      must(refused.status === 400 && /This workshop is full/.test(refused.html), 'a full workshop accepted a registration');
      return 'dates, topics, speakers, venues; registered → 19 seats left; full workshop refuses';
    } },
  colorCheck('lightcyan', 'cadetblue'),
];
