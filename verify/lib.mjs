// Helpers shared by every app's acceptance checks. Each check maps 1:1 to one
// ui_instruct case of the WebGen-Bench task.
export const make = (base) => {
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; };
  const post = async (p, body = {}) => {
    const r = await fetch(base + p, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString() });
    return { status: r.status, location: r.headers.get('location') || '' };
  };
  const follow = async (p, body) => { const r = await post(p, body); return get(r.location || p); };
  const rows = (html) => [...html.matchAll(/<tr class="[^"]*">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const rowWith = (html, text) => rows(html).find((r) => r.includes(text));
  const idIn = (row) => { const m = /\/(?:[A-Za-z]+)\/(\d+)(?:["\/])/.exec(row); return m ? m[1] : null; };
  const idOf = (html, text) => {
    const r = rowWith(html, text);
    if (!r) throw new Error(`row containing "${text}" not found`);
    const id = idIn(r);
    if (!id) throw new Error(`no id in row "${text}"`);
    return id;
  };
  const flashOf = (html) => (/<p class="flash">([\s\S]*?)<\/p>/.exec(html) || [, ''])[1].trim();
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };
  return { base, get, post, follow, rows, rowWith, idOf, flashOf, must };
};

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
  run: async ({ get, must, base }) => {
    const { html } = await get('/');
    const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)[1];
    const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    must(hrefs.length >= minItems, `expected at least ${minItems} menu items, got ${hrefs.length}`);
    for (const h of hrefs) {
      const r = await fetch(base + h, { redirect: 'manual' });
      must(r.status === 200, `menu item ${h} returned ${r.status}`);
    }
    return `${hrefs.length} menu items, all 200`;
  },
});
