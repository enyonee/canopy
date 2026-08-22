#!/usr/bin/env node
// Acceptance run for WebGen-Bench task 000080, one check per ui_instruct case.
// This is my own HTTP translation of their browser tests — not their harness.
const BASE = process.env.BASE || 'http://127.0.0.1:8901';
const results = [];
const check = async (n, task, fn) => {
  try { const note = await fn(); results.push([n, true, task, note || '']); }
  catch (e) { results.push([n, false, task, e.message]); }
};
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, html: await r.text() }; };
const post = async (p, body) =>
  fetch(BASE + p, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString() });
const rowOf = (html, title) => {
  const m = [...html.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/g)].find(([, , c]) => c.includes(title));
  return m ? { cls: m[1], cells: m[2] } : null;
};
const idOf = (html, title) => {
  const m = [...html.matchAll(/action="\/Task\/(\d+)\/(?:delete|action)[^"]*"/g)];
  const rows = [...html.matchAll(/<tr class="[^"]*">([\s\S]*?)<\/tr>/g)];
  const i = rows.findIndex(([, c]) => c.includes(title));
  if (i === -1) throw new Error(`row "${title}" not found`);
  const id = /\/Task\/(\d+)\//.exec(rows[i][1]);
  if (!id) throw new Error(`no id in row "${title}"`);
  return id[1];
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

await check(1, 'Create a new task via the Add Task form', async () => {
  await post('/Task', { title: 'Buy milk', notes: 'from the corner shop' });
  const { html } = await get('/Task');
  must(rowOf(html, 'Buy milk'), 'new task is not in the list');
  must(html.includes('from the corner shop'), 'notes not shown');
  return 'row present with title and notes';
});

await check(2, 'Edit an existing task and save', async () => {
  let { html } = await get('/Task');
  const id = idOf(html, 'Buy milk');
  await post(`/Task/${id}`, { title: 'Buy oat milk', notes: 'from the corner shop', done: 'false' });
  ({ html } = await get('/Task'));
  must(rowOf(html, 'Buy oat milk'), 'edited title not in the list');
  must(!rowOf(html, 'Buy milk"'), 'old title still present');
  return 'title updated in place';
});

await check(3, 'Mark a task as completed', async () => {
  let { html } = await get('/Task');
  const id = idOf(html, 'Buy oat milk');
  await post(`/Task/${id}/action/toggle`, {});
  ({ html } = await get('/Task'));
  const row = rowOf(html, 'Buy oat milk');
  must(row.cls.includes('done'), 'row is not marked done (no strikethrough class)');
  must(row.cells.includes('Completed'), 'row does not read Completed');
  return 'strikethrough class + Completed cell';
});

await check(4, 'Delete a task', async () => {
  await post('/Task', { title: 'Throwaway' });
  let { html } = await get('/Task');
  const id = idOf(html, 'Throwaway');
  await post(`/Task/${id}/delete`, {});
  ({ html } = await get('/Task'));
  must(!rowOf(html, 'Throwaway'), 'deleted task still visible');
  return 'row gone from the list';
});

await check(5, 'Search a task by title or keywords', async () => {
  await post('/Task', { title: 'Call the dentist', notes: 'annual checkup' });
  const a = await get('/Task?q=dentist');
  must(rowOf(a.html, 'Call the dentist'), 'search by title found nothing');
  must(!rowOf(a.html, 'Buy oat milk'), 'search returned unrelated rows');
  const b = await get('/Task?q=checkup');
  must(rowOf(b.html, 'Call the dentist'), 'search by notes keyword found nothing');
  return 'matches by title and by notes, excludes the rest';
});

await check(6, 'Filter completed / uncompleted tasks', async () => {
  const done = await get('/Task?done=true');
  must(rowOf(done.html, 'Buy oat milk'), 'completed filter hides a completed task');
  must(!rowOf(done.html, 'Call the dentist'), 'completed filter shows an active task');
  const active = await get('/Task?done=false');
  must(rowOf(active.html, 'Call the dentist'), 'active filter hides an active task');
  must(!rowOf(active.html, 'Buy oat milk'), 'active filter shows a completed task');
  const all = await get('/Task');
  must(rowOf(all.html, 'Buy oat milk') && rowOf(all.html, 'Call the dentist'), 'filter changed the underlying data');
  return 'both directions, unfiltered state intact';
});

await check(7, 'Navigate via the menu links', async () => {
  const { html } = await get('/Task');
  const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)[1];
  const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  must(hrefs.length >= 3, `expected several menu items, got ${hrefs.length}`);
  for (const h of hrefs) {
    const r = await fetch(BASE + h, { redirect: 'manual' });
    must(r.status === 200, `menu item ${h} returned ${r.status}`);
  }
  return `${hrefs.length} menu items, all 200: ${hrefs.join(' ')}`;
});

await check(8, 'Lavender background and indigo components', async () => {
  const { html } = await get('/Task');
  must(/body\s*\{[^}]*background:\s*lavender/.test(html), 'body background is not lavender');
  must(/header\s*\{[^}]*background:\s*indigo/.test(html), 'header is not indigo');
  must(/button[^{]*\{[^}]*background:\s*indigo/.test(html), 'buttons are not indigo');
  return 'body lavender; header, buttons, table headers indigo';
});

const passed = results.filter((r) => r[1]).length;
for (const [n, ok, task, note] of results) console.log(`${ok ? '✓' : '✗'} ${n}. ${task}\n    ${note}`);
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
