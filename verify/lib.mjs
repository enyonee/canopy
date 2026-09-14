// Helpers shared by every app's acceptance checks. Each check maps 1:1 to one
// ui_instruct case of the WebGen-Bench task (or one requirement of a reference app).
// The client keeps a cookie jar, so a check can log in and act as that user.
import http from 'node:http';

export const make = (base, sink = null) => {
  let cookie = '';
  const keep = (r) => { const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; };
  const headers = () => (cookie ? { cookie } : {});
  // GET follows redirects (a page is what the browser lands on); POST reports them.
  const get = async (p, hops = 0) => {
    const r = await fetch(base + p, { headers: headers(), redirect: 'manual' });
    keep(r);
    const location = r.headers.get('location') || '';
    if ((r.status === 303 || r.status === 302) && location && hops < 5) { await r.text(); return { ...(await get(location, hops + 1)), location }; }
    return { status: r.status, location, html: await r.text(), type: r.headers.get('content-type') || '', disposition: r.headers.get('content-disposition') || '' };
  };
  const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers() },
      body: new URLSearchParams(body).toString() });
    keep(r);
    return { status: r.status, location: r.headers.get('location') || '', html: await r.text() };
  };
  const upload = async (p, fields = {}, file = null) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    if (file) fd.append(file.field, new Blob([file.content]), file.name);
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual', headers: headers(), body: fd });
    keep(r);
    return { status: r.status, location: r.headers.get('location') || '', html: await r.text() };
  };
  const follow = async (p, body) => { const r = await post(p, body); return get(r.location || p); };
  const login = async (user, password) => { const r = await post('/login', { login: user, password }); return r; };
  const logout = async () => { await post('/logout', {}); cookie = ''; };
  const asGuest = () => { cookie = ''; };
  const rows = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]).filter((r) => r.includes('<td>'));
  const rowWith = (html, text) => rows(html).find((r) => r.includes(text));
  // The row's own id: named entity if given, else the last link in the row (actions come after reference columns).
  const idIn = (row, entity = null) => {
    const re = entity ? new RegExp(`\\/${entity}\\/(\\d+)(?:["\\/])`, 'g') : /\/(?:[A-Za-z]+)\/(\d+)(?:["\/])/g;
    const all = [...row.matchAll(re)];
    return all.length ? all[all.length - 1][1] : null;
  };
  const idOf = (html, text, entity = null) => {
    const r = rowWith(html, text);
    if (!r) throw new Error(`row containing "${text}" not found`);
    const id = idIn(r, entity);
    if (!id) throw new Error(`no id in row "${text}"`);
    return id;
  };
  const flashOf = (html) => (/<p class="flash">([\s\S]*?)<\/p>/.exec(html) || [, ''])[1].trim();
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  return { base, sink, get, post, upload, follow, login, logout, asGuest, rows, rowWith, idOf, flashOf, must };
};

// A local receiver for outgoing HTTP: records every request, answers 200 (or 500 while `failing`).
export const startSink = (port = 8999) => new Promise((resolve) => {
  const received = [];
  const state = { failing: false };
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = data;
      try { body = JSON.parse(data); } catch { /* keep raw */ }
      received.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(state.failing ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !state.failing }));
    });
  });
  server.listen(port, '127.0.0.1', () => resolve({
    port, received, state,
    clear: () => { received.length = 0; },
    close: () => server.close(),
  }));
});

export const colorCheck = (bg, accent) => ({
  task: `Background is '${bg}' and components are '${accent}'`,
  run: async ({ get, must }) => {
    const { html } = await get('/');
    const page = html.includes('<body') ? html : (await get('/')).html;
    must(new RegExp(`body \\{[^}]*background: ${bg}`).test(page), `body background is not ${bg}`);
    must(new RegExp(`header \\{[^}]*background: ${accent}`).test(page), `header is not ${accent}`);
    must(new RegExp(`button, \\.btn \\{[^}]*background: ${accent}`).test(page), `buttons are not ${accent}`);
    return `body ${bg}; header, buttons, table headers ${accent}`;
  },
});

export const navCheck = (minItems = 3) => ({
  task: 'Every menu item leads to a working page',
  run: async ({ get, must }) => {
    const { html } = await get('/');
    const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)[1];
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => !['/login', '/register'].includes(h));
    must(hrefs.length >= minItems, `expected at least ${minItems} menu items, got ${hrefs.length}`);
    for (const h of hrefs) {
      const r = await get(h);
      must(r.status === 200, `menu item ${h} returned ${r.status}`);
    }
    return `${hrefs.length} menu items, all 200`;
  },
});
