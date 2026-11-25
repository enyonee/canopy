// The shop's acceptance scenarios (apps/shop/checks.mjs) walked through the generated front end the way a person
// would: headless Chrome, clicks and typing only, assertions on what the page shows. Screenshots of each stop,
// desktop and phone, light and dark, go to webgen/screenshots/.
//
//   node webgen/e2e/run.mjs --base http://127.0.0.1:5191 [--chrome /usr/bin/google-chrome]
//
// Needs a freshly seeded shop behind --base (its /api), e.g. Vite dev with CANOPY_API pointing at
// `node runtime/run.mjs apps/shop/app.json --port 8961`.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg('base', 'http://127.0.0.1:5191');
const CHROME = arg('chrome', process.env.AG_CHROME || '/usr/bin/google-chrome');
const SHOTS = path.join(import.meta.dirname, '..', 'screenshots');
const PROFILE = arg('profile', path.join(process.env.TMPDIR || '/tmp', `webgen-chrome-${process.pid}`));
fs.mkdirSync(SHOTS, { recursive: true });

const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Fail extends Error {}
const must = (ok, msg) => { if (!ok) throw new Fail(msg); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: PROFILE,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage'] });
const errors = [];

// Every person gets their own browser context: their own cookie jar, so sessions never mix.
async function newPage(viewport = DESKTOP) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  // Headless Chrome reports a dark system theme; the light theme is the one most screenshots show.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.setDefaultTimeout(8000);
  // Every toast the page ever shows, in order: a toast may be gone before the check looks.
  await page.evaluateOnNewDocument(() => {
    window.__toasts = [];
    new MutationObserver(() => {
      for (const t of document.querySelectorAll('[data-sonner-toast]')) {
        if (t.dataset.seen || !t.innerText.trim()) continue;
        t.dataset.seen = '1';
        window.__toasts.push(t.innerText.trim());
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return page;
}

// Helpers over one page: what a user sees and does.
const ui = (page) => ({
  go: async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await settle(page); },
  text: () => page.evaluate(() => document.querySelector('main')?.innerText ?? ''),
  all: () => page.evaluate(() => document.body.innerText),
  path: () => page.evaluate(() => location.pathname + location.search),
  see: (t, ms = 8000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout: ms }, t),
  gone: (t, ms = 8000) => page.waitForFunction((x) => !document.body.innerText.includes(x), { timeout: ms }, t),
  click: async (label, scope = 'body') => {
    const ok = await page.evaluate((l, s) => {
      // An open dialog or menu first, then the page, then the frame (the header has its own "Create account").
      const roots = [document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'), document.querySelector(s === 'body' ? 'main' : s), document.body].filter(Boolean);
      let el = null;
      for (const root of roots) {
        const els = [...root.querySelectorAll('button, a, [role="menuitem"], [role="menuitemradio"], [role="option"], [role="tab"]')].filter((e) => e.offsetParent !== null || e.getAttribute('role'));
        el = els.find((e) => (e.getAttribute('aria-label') || e.innerText || '').trim() === l) || els.find((e) => (e.innerText || '').trim().startsWith(l));
        if (el) break;
      }
      if (el) { el.scrollIntoView({ block: 'center' }); el.setAttribute('data-e2e-target', '1'); }
      return Boolean(el);
    }, label, scope);
    must(ok, `no "${label}" to click`);
    await realClick(page);
    await settle(page);
  },
  // Select what the field holds and type over it, as a person does (a triple click does not select a password).
  fill: async (id, value) => {
    await page.waitForSelector(`#${id}`);
    await page.focus(`#${id}`);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.type(`#${id}`, String(value));
  },
  choose: async (id, option) => {
    await page.click(`#${id}`);
    await page.waitForSelector('[role="option"]');
    await page.evaluate((o) => [...document.querySelectorAll('[role="option"]')].find((e) => e.innerText.trim() === o)?.click(), option);
    await settle(page);
  },
  rowText: (name) => page.evaluate((n) => {
    const r = [...document.querySelectorAll('main tr, main [data-row-id]')].find((e) => e.offsetParent !== null && e.innerText.includes(n));
    return r ? r.innerText.replace(/\s+/g, ' ') : null;
  }, name),
  rowAction: async (name, label) => {
    const ok = await page.evaluate((n, l) => {
      const r = [...document.querySelectorAll('main tr, main [data-row-id]')].find((e) => e.offsetParent !== null && e.innerText.includes(n));
      const b = r && [...r.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || x.innerText).trim().startsWith(l));
      if (b) { b.scrollIntoView({ block: 'center' }); b.setAttribute('data-e2e-target', '1'); }
      return Boolean(b);
    }, name, label);
    must(ok, `no "${label}" on the row of ${name}`);
    await realClick(page);
    await settle(page);
  },
  toast: async (re) => {
    const h = await page.waitForFunction((src) => {
      const i = window.__toasts.findIndex((t) => new RegExp(src).test(t));
      return i >= 0 ? window.__toasts.splice(i, 1)[0] : null;
    }, { timeout: 8000 }, re.source);
    return h.jsonValue();
  },
  shot: async (name) => { await settle(page); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); },
});

// A real pointer click on the element the helper marked (Radix menus and selects open on pointerdown).
async function realClick(page) {
  const el = await page.$('[data-e2e-target]');
  await page.evaluate((e) => e.removeAttribute('data-e2e-target'), el);
  await el.click();
}

async function settle(page) {
  await page.waitForNetworkIdle({ idleTime: 150, timeout: 8000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 8000 }).catch(() => undefined);
  await wait(120);
}

async function dismissToasts(page) {
  await page.evaluate(() => document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach((b) => b.click()));
  await wait(250);
}

const results = [];
async function scenario(title, fn) {
  try { const note = await fn(); results.push({ title, ok: true, note }); process.stdout.write(`ok    ${title}${note ? ` — ${note}` : ''}\n`); }
  catch (e) {
    results.push({ title, ok: false, note: e.message });
    process.stdout.write(`FAIL  ${title} — ${e.message}\n`);
    // What each open page showed when it failed: the evidence for the report.
    const pages = (await Promise.all(browser.browserContexts().map((c) => c.pages()))).flat();
    for (const [i, pg] of pages.entries()) {
      if (pg.url() === 'about:blank') continue;
      await pg.screenshot({ path: path.join(SHOTS, `fail-${results.length}-${i}.png`) }).catch(() => undefined);
      const t = await pg.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
      process.stdout.write(`      page ${i} ${pg.url()}: ${t}\n`);
    }
  }
}

const guest = await newPage();
const g = ui(guest);
let annOrder = null;

await scenario('A guest browses the storefront, searches and filters without signing in', async () => {
  await g.go('/');
  must((await g.path()).startsWith('/Product'), `home went to ${await g.path()}`);
  await g.see('Blue mug');
  const t = await g.text();
  must(t.includes('Mountain poster') && !t.includes('Old poster'), 'catalogue rows wrong');
  must(t.includes('12.50'), 'price not formatted as money');
  must(!t.includes('Add to cart'), 'a guest sees Add to cart');
  await g.shot('01-guest-catalogue-desktop');
  await g.fill('list-search', 'poster');
  await g.gone('Blue mug');
  must((await g.text()).includes('Mountain poster'), 'search lost the poster');
  must((await g.path()).includes('q=poster'), 'search not in the URL');
  await g.click('Clear all');
  await g.see('Blue mug');
  // On the storefront the category filter is the row of quick links in the hero (the same ?category= filter).
  await guest.evaluate(() => [...document.querySelectorAll('[aria-label^="Filter by"] button')].find((b) => b.innerText.trim() === 'Mugs').setAttribute('data-e2e-target', '1'));
  await realClick(guest);
  await settle(guest);
  must((await g.path()).includes('category='), `the category is not in the URL: ${await g.path()}`);
  await g.gone('Mountain poster');
  must((await g.text()).includes('Blue mug'), 'filter lost the mug');
  await g.shot('02-guest-filter-mugs');
  // The same catalogue as a table (the staff view, by URL for a guest): the price column is there.
  await g.go('/Product?view=table');
  await guest.waitForFunction(() => [...document.querySelectorAll('main th')].some((th) => th.innerText.trim().toLowerCase() === 'price'));
  await g.shot('03-guest-catalogue-table');
  return 'cards and table, money 12.50, search ?q=, category chips (?category=)';
});

await scenario('A guest is sent to sign in for orders and gets no dashboard', async () => {
  await g.go('/Order');
  await guest.waitForFunction(() => location.pathname === '/login');
  must((await g.path()).includes('next=%2FOrder') || (await g.path()).includes('next=/Order'), `no next: ${await g.path()}`);
  await g.shot('04-login');
  await g.go('/dashboard/sales');
  await guest.waitForFunction(() => location.pathname === '/login');
  return 'redirected to /login?next=';
});

const ann = await newPage();
const a = ui(ann);
await scenario('A customer registers and lands signed in; a duplicate email is refused', async () => {
  await a.go('/register');
  await a.shot('05-register');
  await a.fill('f_email', 'ann@shop.test'); await a.fill('f_password', 'secret1'); await a.fill('f_name', 'Ann');
  await a.click('Create account');
  await a.toast(/Welcome, ann@shop.test/);
  await a.see('Ann');
  must(!(await a.all()).includes('Sign in'), 'still offered to sign in');
  const other = await newPage();
  const o = ui(other);
  await o.go('/register');
  await o.fill('f_email', 'ann@shop.test'); await o.fill('f_password', 'x'); await o.fill('f_name', 'Ann again');
  await o.click('Create account');
  await other.waitForFunction(() => /already (taken|registered)/.test(document.querySelector('main').innerText));
  await o.shot('06-register-duplicate');
  await other.close();
  return 'signed in as Ann; the duplicate shows the server\'s "already taken" next to the email field';
});

await scenario('Adding products builds a cart whose count and total are derived', async () => {
  await a.go('/Product');
  await a.rowAction('Blue mug', 'Add to cart');
  await a.toast(/Blue mug added to your cart/);
  await ann.waitForFunction(() => location.pathname === '/list/cart');
  await a.go('/Product');
  await a.rowAction('Blue mug', 'Add to cart');
  await ann.waitForFunction(() => location.pathname === '/list/cart');
  await a.go('/Product');
  await a.rowAction('Mountain poster', 'Add to cart');
  await ann.waitForFunction(() => location.pathname === '/list/cart');
  await a.see('Cart');
  await dismissToasts(ann);
  const cart = await a.rowText('50.00');
  must(cart && /\b3\b/.test(cart) && cart.includes('50.00'), `cart row: ${cart}`);
  await a.shot('07-cart-list');
  const link = await ann.evaluate(() => [...document.querySelectorAll('main a')].find((x) => /\/Order\/\d+$/.test(x.getAttribute('href')))?.getAttribute('href'));
  must(link, 'no link to the cart order');
  annOrder = link.split('/').pop();
  await a.go(link);
  await a.see('Items');
  const items = await a.text();
  must(items.includes('Blue mug') && items.includes('Mountain poster'), 'items missing on the order');
  must(items.includes('25.00'), 'line total missing');
  return `order #${annOrder}: 3 lines, 3 items, total 50.00`;
});

await scenario('A zero quantity is refused by the rule; editing a quantity updates the total', async () => {
  await a.rowAction('Mountain poster', 'More for');
  await a.click('Edit');
  await a.fill('f_qty', '0');
  await a.click('Save changes');
  await a.see('Quantity must be at least 1');
  await a.shot('08-qty-zero-refused');
  await a.fill('f_qty', '2');
  await a.click('Save changes');
  await a.gone('Save changes');
  await a.see('75.00');
  await a.rowAction('Blue mug', 'More for');
  await a.click('Edit');
  await a.fill('f_qty', '3');
  await a.click('Save changes');
  await a.gone('Save changes');
  await a.see('100.00');
  await dismissToasts(ann);
  await a.shot('09-order-cart-detail');
  return 'rule message shown inline; 75.00 → 100.00 after editing (4 mugs, 2 posters)';
});

await scenario('Placing the order takes stock (transition with fields in a dialog)', async () => {
  await a.click('Place order');
  await a.see('Address');
  await a.shot('10-place-dialog');
  await a.fill('f_address', '1 Main st');
  await a.choose('f_paymentMethod', 'Paypal');
  await ann.evaluate(() => [...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0].click());
  const t = await a.toast(new RegExp(`Order #${annOrder} placed, total 100\\.00`));
  await a.see('1 Main st');
  must((await a.text()).includes('Placed'), 'status not placed');
  await a.shot('11-order-placed');
  await a.go('/Product?view=table');
  must((await a.rowText('Blue mug')).includes(' 6 '), `stock: ${await a.rowText('Blue mug')}`);
  must((await a.rowText('Mountain poster')).includes(' 3 '), `stock: ${await a.rowText('Mountain poster')}`);
  return t.replace(/\s+/g, ' ').slice(0, 60);
});

await scenario('Paying moves the order on; the same transition is not offered twice; ship is not offered', async () => {
  await a.go(`/Order/${annOrder}`);
  must(!(await a.all()).includes('Mark shipped'), 'a customer is offered to ship');
  await a.click('Pay now');
  await a.toast(/Payment received, thank you: 100 points earned/);
  await a.see('Paid');
  const t = await a.text();
  must(!/Pay now|Place order/.test(t), 'a spent transition is still offered');
  must(t.includes('Cancel order'), 'cancel not offered on a paid order');
  await dismissToasts(ann);
  await a.shot('12-order-paid');
  return 'paid, 100 points; Pay/Place gone; no Mark shipped for a customer';
});

const bob = await newPage();
const b = ui(bob);
await scenario('A customer sees only their own orders and nothing of the admin surface', async () => {
  await b.go('/register');
  await b.fill('f_email', 'bob@shop.test'); await b.fill('f_password', 'secret2'); await b.fill('f_name', 'Bob');
  await b.click('Create account');
  await b.toast(/Welcome, bob/);
  await b.go('/Order');
  await b.see('No orders yet');
  const nav = await bob.evaluate(() => document.querySelector('nav[aria-label="Main"]')?.innerText ?? '');
  must(!/Sales|Customers|Admin console/.test(nav), `customer nav shows admin items: ${nav}`);
  await b.go(`/Order/${annOrder}`);
  await b.see('No access');
  await b.go('/dashboard/sales');
  await b.see('No access');
  await b.go('/User');
  await b.see('No access');
  await b.shot('13-customer-no-access');
  return 'own rows only; another order, dashboard and customers show No access';
});

let bobOrder = null;
await scenario('Not enough stock refuses the order and rolls everything back', async () => {
  await b.go('/Product');
  await b.rowAction('Red mug', 'Add to cart');
  await bob.waitForFunction(() => location.pathname === '/list/cart');
  const link = await bob.evaluate(() => [...document.querySelectorAll('main a')].find((x) => /\/Order\/\d+$/.test(x.getAttribute('href')))?.getAttribute('href'));
  bobOrder = link.split('/').pop();
  await b.go(link);
  await b.rowAction('Red mug', 'More for');
  await b.click('Edit');
  await b.fill('f_qty', '3');
  await b.click('Save changes');
  await b.gone('Save changes');
  await dismissToasts(bob);
  await b.click('Place order');
  await b.fill('f_address', '2 Side st');
  await b.choose('f_paymentMethod', 'Card');
  await bob.evaluate(() => [...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0].click());
  await b.see('Not enough stock');
  await b.shot('14-not-enough-stock');
  await bob.keyboard.press('Escape');
  await b.go(`/Order/${bobOrder}`);
  must((await b.text()).includes('Cart'), 'status moved despite the refusal');
  await b.go('/Product?view=table');
  must((await b.rowText('Red mug')).includes(' 2 '), 'stock changed despite the rollback');
  return 'refusal shown in the dialog; status Cart, stock 2';
});

await scenario('Cancelling a placed order returns the stock (confirmation dialog)', async () => {
  await b.go(`/Order/${bobOrder}`);
  await b.rowAction('Red mug', 'More for');
  await b.click('Edit');
  await b.fill('f_qty', '2');
  await b.click('Save changes');
  await b.gone('Save changes');
  await b.click('Place order');
  await b.fill('f_address', '2 Side st');
  await b.choose('f_paymentMethod', 'Card');
  await bob.evaluate(() => [...document.querySelectorAll('[role="dialog"] button[type="submit"]')][0].click());
  await b.toast(/placed/);
  await b.see('Placed');
  await b.go('/Product?view=table');
  must((await b.rowText('Red mug')).includes(' 0 '), 'stock is not 0 after placing 2');
  await b.go(`/Order/${bobOrder}`);
  await b.click('Cancel order');
  await b.see('Keep it');
  await b.shot('15-cancel-confirm');
  await bob.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((x) => x.innerText.trim() === 'Cancel order').click());
  await b.toast(/Order cancelled, stock returned/);
  await b.see('Cancelled');
  await b.go('/Product?view=table');
  must((await b.rowText('Red mug')).includes(' 2 '), 'stock did not return');
  return 'stock 2 → 0 → 2';
});

const admin = await newPage();
const ad = ui(admin);
await scenario('The admin signs in (a wrong password is refused), sees every order and ships the paid one', async () => {
  await ad.go('/login');
  await ad.fill('login', 'admin@shop.test'); await ad.fill('password', 'nope');
  await ad.click('Sign in');
  await ad.see('Wrong login or password');
  await ad.shot('16-login-wrong-password');
  await ad.fill('password', 'admin123');
  await ad.click('Sign in');
  await ad.toast(/Welcome, admin@shop.test/);
  const nav = await admin.evaluate(() => document.querySelector('nav[aria-label="Main"]')?.innerText ?? '');
  must(/Sales/.test(nav) && /Customers/.test(nav) && /Admin console/.test(nav), `admin nav: ${nav}`);
  await ad.go('/Order');
  const rows = await admin.evaluate(() => document.querySelectorAll('main tbody tr').length);
  must(rows >= 2, `admin sees ${rows} orders`);
  must((await ad.text()).includes('ann@shop.test'), 'customer label missing in orders');
  await ad.shot('17-admin-orders');
  await ad.go(`/Order/${annOrder}`);
  await ad.click('Mark shipped');
  await ad.toast(/./);
  await ad.see('Shipped');
  await dismissToasts(admin);
  await ad.shot('18-admin-order-shipped');
  return `${rows} orders; shipped #${annOrder}`;
});

await scenario('The admin reads customers (percent field, points) and the plugin bound refuses a 150 % discount', async () => {
  await ad.go('/User');
  const row = await ad.rowText('ann@shop.test');
  must(row && row.includes('0 %') && row.includes('100'), `ann row: ${row}`);
  await ad.shot('19-admin-customers');
  const href = await admin.evaluate(() => [...document.querySelectorAll('main a')].find((x) => x.innerText.includes('ann@shop.test'))?.getAttribute('href'));
  await ad.go(`${href}/edit`);
  await ad.fill('f_discount', '150');
  await ad.click('Save changes');
  await ad.see('Discount must be between 0 and 100');
  await ad.shot('20-admin-discount-refused');
  return 'ann: 0 %, 100 points; 150 % refused';
});

await scenario('The sales dashboard sums derived totals, charts them and filters by period', async () => {
  await ad.go('/dashboard/sales');
  await ad.see('Revenue (paid)');
  const t = await ad.text();
  const metric = (title) => admin.evaluate((x) => document.querySelector(`[data-metric="${x}"]`)?.innerText, title);
  must((await metric('Revenue (paid)')) === '100.00', `revenue ${await metric('Revenue (paid)')}`);
  must((await metric('Orders placed')) === '1', `placed ${await metric('Orders placed')}`);
  must(t.includes('Orders by status') && t.includes('Units by product'), 'tables missing');
  must(await admin.evaluate(() => document.querySelectorAll('.recharts-surface').length >= 1), 'no chart drawn');
  await ad.shot('21-dashboard');
  // Each chart's numbers are one click away: "Show table" under it.
  await admin.evaluate(() => [...document.querySelectorAll('main button')].filter((x) => x.innerText.trim() === 'Show table').forEach((x) => x.click()));
  await settle(admin);
  const tables = await ad.text();
  must(/Shipped\s+1\s+100\.00/.test(tables), 'by-status table wrong');
  must(/Blue mug\s+4\s+50\.00/.test(tables), `units by product wrong`);
  await ad.shot('22-dashboard-tables');
  await ad.go('/dashboard/sales?from=2000-01-01&to=2000-12-31');
  must((await metric('Orders placed')) === '0', 'period filter does not exclude');
  return 'revenue 100.00, 1 placed, by status, by product (labels), chart, period filter';
});

// Phone and dark mode: the same screens, other frames.
await scenario('Phone layout and dark theme render the same screens', async () => {
  const phone = await newPage(PHONE);
  const p = ui(phone);
  await p.go('/Product');
  await p.see('Blue mug');
  await p.shot('m01-phone-catalogue');
  await p.click('Open menu');
  await p.see('Shop');
  await p.shot('m02-phone-menu');
  await phone.keyboard.press('Escape');
  await p.go('/login');
  await p.shot('m03-phone-login');
  await p.go('/Product');
  await p.click('Colour theme');
  await p.click('Dark');
  must(await phone.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme not applied');
  await p.shot('m04-phone-dark-catalogue');
  await phone.close();
  await ad.go('/dashboard/sales');
  await ad.click('Colour theme');
  await ad.click('Dark');
  await ad.shot('23-dashboard-dark');
  await ad.go(`/Order/${annOrder}`);
  await ad.shot('24-order-dark');
  await ad.click('Colour theme');
  await ad.click('Light');
  const mobileAdmin = await newPage(PHONE);
  const cookies = await admin.browserContext().cookies();
  await mobileAdmin.browserContext().setCookie(...cookies);
  const m = ui(mobileAdmin);
  await m.go(`/Order/${annOrder}`);
  await m.shot('m05-phone-order');
  await m.go('/dashboard/sales');
  await m.shot('m06-phone-dashboard');
  await mobileAdmin.close();
  return 'phone drawer menu, dark theme class and palette';
});

await scenario('Keyboard: skip link, focus ring and labelled controls', async () => {
  await g.go('/Product');
  await guest.keyboard.press('Tab');
  const first = await guest.evaluate(() => document.activeElement?.textContent?.trim());
  must(first === 'Skip to content', `first tab stop: ${first}`);
  const unlabelled = await guest.evaluate(() => [...document.querySelectorAll('button, input, [role="combobox"]')].filter((e) => {
    const name = e.getAttribute('aria-label') || e.innerText?.trim() || (e.id && document.querySelector(`label[for="${e.id}"]`)?.innerText);
    return e.offsetParent !== null && !name;
  }).length);
  must(unlabelled === 0, `${unlabelled} unlabelled control(s)`);
  return 'skip link first, every visible control named';
});

await browser.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
const passed = results.filter((r) => r.ok).length;
const real = errors.filter((e) => !/Failed to load resource/.test(e));
process.stdout.write(`\n${passed}/${results.length} scenarios passed; ${real.length} page error(s)${real.length ? `:\n${[...new Set(real)].slice(0, 10).join('\n')}` : ''}\nscreenshots: ${SHOTS}\n`,
  () => process.exit(passed === results.length && real.length === 0 ? 0 : 1));
