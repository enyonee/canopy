// Headless browser for widget acceptance. Use the host's Chrome, not a download.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const CHROMES = ['google-chrome', 'chromium', 'chromium-browser'];
const findChrome = () => process.env.AG_CHROME
  || (process.env.PATH || '').split(path.delimiter).flatMap((dir) => CHROMES.map((bin) => path.join(dir, bin)))
    .find((bin) => fs.existsSync(bin));

export async function openBrowser(url, { cookie = '' } = {}) {
  const executablePath = findChrome();
  if (!executablePath) throw new Error('no Chrome found (set AG_CHROME)');
  const browser = await puppeteer.launch({ executablePath, headless: true, timeout: 15_000, defaultViewport: null });
  try {
    const [page] = await browser.pages();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Match the old helper's JavaScript console errors, not Chrome's network logs.
    page.on('console', (e) => { if (e.type() === 'error' && e.args().length) errors.push(e.text()); });
    if (cookie) {
      const separator = cookie.indexOf('=');
      await browser.defaultBrowserContext().setCookie({ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url });
    }
    const evaluate = (expression) => page.evaluate(expression);
    const until = async (expression, timeout = 5000) => {
      const handle = await page.waitForFunction(`(() => { try { return !!(${expression}); } catch { return false; } })()`,
        { timeout, polling: 100 });
      await handle.dispose();
      return true;
    };
    const goto = async (to) => { await page.goto(to, { waitUntil: 'load' }); await wait(300); };
    await goto(url);
    return { eval: evaluate, until, goto, close: () => browser.close(), errors };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
