// Screenshots of the same screens, for comparing one version of the front end with another (and one app with
// another). Seeds a little data through /api, then shoots each screen as the viewer named.
//
//   node webgen/e2e/shots.mjs --app shop --base http://127.0.0.1:5194 --out webgen/screenshots/v2/before
//   node webgen/e2e/shots.mjs --app crm  --base http://127.0.0.1:5195 --out webgen/screenshots/v2/after
//
// Needs a freshly seeded app behind --base (vite preview or dev, with CANOPY_API pointing at the runtime).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg('base', 'http://127.0.0.1:5194');
const APP = arg('app', 'shop');
const OUT = path.resolve(arg('out', path.join(import.meta.dirname, '..', 'screenshots', 'v2')));
const CHROME = arg('chrome', process.env.AG_CHROME || '/usr/bin/google-chrome');
fs.mkdirSync(OUT, { recursive: true });

// A tiny client of /api with its own cookie, like one person's browser.
function person() {
  let cookie = '';
  const req = async (method, p, body) => {
    const res = await fetch(BASE + p, { method, headers: { accept: 'application/json', 'content-type': 'application/json', origin: BASE, cookie },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  return { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), cookie: () => cookie };
}

const PLANS = {
  async shop() {
    const ann = person();
    await ann.post('/api/register', { email: 'ann@shop.test', password: 'secret1', name: 'Ann Lee' });
    const one = (await ann.post('/api/Product/1/action/addToCart')).id;
    await ann.post('/api/Product/3/action/addToCart');
    const cart = (await ann.get('/api/list/cart')).rows[0].id;
    void one;
    await ann.post(`/api/Order/${cart}/go/place`, { address: '1 Main st', paymentMethod: 'paypal' });
    await ann.post(`/api/Order/${cart}/go/pay`);
    const bob = person();
    await bob.post('/api/register', { email: 'bob@shop.test', password: 'secret2', name: 'Bob Stone' });
    await bob.post('/api/Product/2/action/addToCart');
    const bobCart = (await bob.get('/api/list/cart')).rows[0].id;
    await bob.post(`/api/Order/${bobCart}/go/place`, { address: '2 Side st', paymentMethod: 'card' });
    const admin = person();
    await admin.post('/api/login', { login: 'admin@shop.test', password: 'admin123' });
    await admin.post(`/api/Order/${cart}/go/ship`);
    return [
      { name: 'catalogue', path: '/Product', who: null },
      { name: 'product', path: '/Product/1', who: null },
      { name: 'order', path: `/Order/${cart}`, who: admin },
      { name: 'dashboard', path: '/dashboard/sales', who: admin },
      { name: 'catalogue-mobile', path: '/Product', who: null, phone: true },
      { name: 'catalogue-dark', path: '/Product', who: null, dark: true },
      { name: 'dashboard-dark', path: '/dashboard/sales', who: admin, dark: true },
    ];
  },
  async crm() {
    const admin = person();
    await admin.post('/api/login', { login: 'admin@crm.test', password: 'admin123' });
    const north = (await admin.post('/api/Company', { name: 'Northwind', industry: 'retail' })).id;
    const acme = (await admin.post('/api/Company', { name: 'Acme Software', industry: 'software' })).id;
    const contact = (await admin.post('/api/Contact', { name: 'Dana Fox', email: 'dana@northwind.test', company: north })).id;
    const leads = [['Website redesign', 12000, north, 2, 'referral'], ['Annual support', 4800, acme, 3, 'web'], ['Data migration', 9500, north, 2, 'event'], ['Mobile app', 22000, acme, 3, 'cold']];
    const ids = [];
    for (const [title, value, company, owner, source] of leads) ids.push((await admin.post('/api/Lead', { title, value, company, owner, source, contact })).id);
    await admin.post(`/api/Lead/${ids[0]}/go/contact`);
    await admin.post(`/api/Lead/${ids[0]}/go/qualify`);
    await admin.post(`/api/Lead/${ids[3]}/go/lose`, { closedAt: new Date().toISOString().slice(0, 10) });
    return [
      { name: 'crm-leads', path: '/Lead', who: admin },
      { name: 'crm-dashboard', path: '/dashboard/pipeline', who: admin },
    ];
  },
};

const plan = await PLANS[APP]();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'webgen-shots-')),
  args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage'] });
for (const s of plan) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(s.phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }]);
  if (s.who) await ctx.setCookie({ name: s.who.cookie().split('=')[0], value: s.who.cookie().split('=')[1], url: BASE });
  await page.goto(BASE + s.path, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 8000 }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`), fullPage: true });
  process.stdout.write(`${path.join(OUT, `${s.name}.png`)}\n`);
  await ctx.close();
}
const profile = browser.process()?.spawnargs.find((a) => a.startsWith('--user-data-dir='))?.slice(16);
await browser.close();
if (profile) fs.rmSync(profile, { recursive: true, force: true });
