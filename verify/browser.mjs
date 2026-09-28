// A real browser for checks that must see a widget run: headless Chrome driven
// over the DevTools protocol, no dependencies. HTTP checks prove the server;
// this proves the client module actually mounts, reacts to clicks and talks to
// the graph. Skipped (the check throws a clear error) when no Chrome is found.
//
//   const b = await openBrowser(`${base}/Game/1`);
//   await b.eval(`document.querySelector('[data-cell="4"]').click()`);
//   await b.until(`document.querySelector('.widget').innerText.includes('Turn: O')`);
//   b.errors  // uncaught exceptions and console.error lines from the page
//   await b.close();
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROMES = ['google-chrome', 'chromium', 'chromium-browser'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const findChrome = () => process.env.AG_CHROME
  || CHROMES.find((c) => (process.env.PATH || '').split(':').some((d) => fs.existsSync(path.join(d, c))));

export async function openBrowser(url, { cookie = '' } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('no Chrome found (set AG_CHROME)');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-chrome-'));
  const chrome = spawn(bin, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const port = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${log.slice(-300)}`)), 15000);
    chrome.stderr.on('data', (d) => {
      log += d;
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(log);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let n = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  if (cookie) {
    const [name, value] = cookie.split('=');
    await send('Network.setCookie', { name, value, url });
  }
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`in page: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const until = async (expression, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(`(() => { try { return !!(${expression}); } catch { return false; } })()`)) return true;
      await wait(100);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  };
  const goto = async (to) => { await send('Page.navigate', { url: to }); await until(`document.readyState === 'complete'`); await wait(300); };
  await goto(url);
  // The profile is removed only after Chrome and its helpers have exited: while
  // they run they keep writing there, and an rmSync racing them fails with ENOTEMPTY.
  const exited = new Promise((r) => chrome.once('exit', r));
  const close = async () => {
    ws.close();
    process.kill(-chrome.pid, 'SIGKILL'); // the whole group: renderers outlive a killed parent
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { eval: evaluate, until, goto, close, errors };
}
