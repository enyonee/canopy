// webgen-bench/000061 — recycling game: Player/GameSession/Drop rows, a
// drag-into-bins widget (recyclebin), and the recycle.drop grading block in
// plugins/recycling.mjs — the server, not the widget, decides right/wrong,
// refuses re-dropping an item, and awards the badge.
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';

const jsonGet = async (base, path) => { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return { status: r.status, body: await r.json() }; };
const jsonPost = async (base, path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
  return { status: r.status, body: await r.json() };
};

export const checks = [
  { task: 'Test the functionality of starting a new game',
    run: async ({ base, must }) => {
      const created = await jsonPost(base, '/Player', { name: 'Robin' });
      must(created.status === 200 && created.body.ok, `creating a player returned ${created.status}: ${JSON.stringify(created.body)}`);
      const playerId = created.body.id;
      const started = await jsonPost(base, `/Player/${playerId}/action/playNow`, {});
      must(started.status === 200 && started.body.ok && started.body.created, `starting a game returned ${started.status}: ${JSON.stringify(started.body)}`);
      const gameId = started.body.created;
      const session = await jsonGet(base, `/GameSession/${gameId}`);
      must(session.body.status === 'playing' && session.body.total === 0, `a new game should start fresh: ${JSON.stringify(session.body)}`);
      const page = await fetch(`${base}/GameSession/${gameId}`);
      const html = await page.text();
      must(/data-widget="recyclebin"/.test(html), 'the game page does not embed the sorting widget');
      // Drive one real drag in a real browser: an item dragged onto a bin
      // must change the server-side score, not just the on-screen tray.
      const items = (await jsonGet(base, '/WasteItem')).body.rows;
      const first = items[0];
      const b = await openBrowser(`${base}/GameSession/${gameId}`);
      try {
        await b.until(`document.querySelector('[data-intro]')`);
        must(await b.eval(`document.querySelector('[data-intro]').textContent.includes('Drag each waste item')`), 'the introductory screen has no instructions on how to play');
        await b.eval(`document.querySelector('[data-start-sorting]').click()`);
        await b.until(`document.querySelectorAll('[data-item]').length === ${items.length}`);
        const itemBox = await b.eval(`(() => { const r = document.querySelector('[data-item="${first.id}"]').getBoundingClientRect(); return r.left + ',' + r.top; })()`);
        const [ix, iy] = itemBox.split(',').map(Number);
        const binBox = await b.eval(`(() => { const r = document.querySelector('[data-bin="${first.correctBin}"]').getBoundingClientRect(); return (r.left + r.width / 2) + ',' + (r.top + r.height / 2); })()`);
        const [bx, by] = binBox.split(',').map(Number);
        await b.eval(`document.querySelector('[data-item="${first.id}"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: ${ix + 5}, clientY: ${iy + 5} }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${bx}, clientY: ${by} }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${bx}, clientY: ${by} }))`);
        await b.until(`document.querySelector('[data-score] b').textContent === '10'`);
        must(!b.errors.length, `page errors while dragging: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const after = await jsonGet(base, `/GameSession/${gameId}`);
      must(after.body.total === 1 && after.body.correct === 1 && after.body.score === 10, `the dragged drop was not recorded server-side: ${JSON.stringify(after.body)}`);
      return `player Robin started game #${gameId}; dragging "${first.name}" onto its bin in a real browser scored it server-side (1/1, 10pts)`;
    } },
  { task: 'Check the leaderboard feature to ensure it displays scores correctly',
    run: async ({ base, rows, must }) => {
      const bins = (await jsonGet(base, '/Bin')).body.rows;
      const items = (await jsonGet(base, '/WasteItem')).body.rows;
      const byName = (n) => items.find((i) => i.name === n);
      async function playSession(name, correctCount) {
        const player = (await jsonPost(base, '/Player', { name })).body.id;
        const session = (await jsonPost(base, `/Player/${player}/action/playNow`, {})).body.created;
        let i = 0;
        for (const item of items) {
          const bin = i < correctCount ? item.correctBin : bins.find((b) => b.id !== Number(item.correctBin)).id;
          await jsonPost(base, `/GameSession/${session}/action/drop`, { item: item.id, bin });
          i++;
        }
        return session;
      }
      await playSession('Alex (high score)', 8);
      await playSession('Sam (low score)', 2);
      const board = await fetch(`${base}/list/leaderboard`);
      const html = await board.text();
      must(board.status === 200, `leaderboard returned ${board.status}`);
      const list = rows(html);
      must(list.length >= 2, `expected at least 2 finished games on the leaderboard, got ${list.length}`);
      const scores = list.map((r) => Number(/<td>(\d+)<\/td>/.exec(r.replace(/<td>[A-Za-z][^<]*<\/td>/, ''))?.[1] ?? -1));
      const sorted = [...scores].every((s, i) => i === 0 || scores[i - 1] >= s);
      must(sorted, `leaderboard scores are not in descending order: ${scores}`);
      must(/Alex \(high score\)/.test(html) && /Sam \(low score\)/.test(html), 'the leaderboard is missing an expected player');
      return `leaderboard shows ${list.length} finished games, scores in descending order`;
    } },
  { task: 'Assess the cartoon-style visual design for appropriateness',
    run: async ({ base, get, must }) => {
      const created = (await jsonPost(base, '/Player', { name: 'Casey' })).body.id;
      const session = (await jsonPost(base, `/Player/${created}/action/playNow`, {})).body.created;
      const page = await get(`/GameSession/${session}`);
      must(/seashell/.test(page.html) && /crimson/.test(page.html), 'the page does not carry the required cartoon colour theme');
      const widget = await fetch(`${base}/widget/recyclebin.mjs`);
      const src = await widget.text();
      const emojiCount = (src.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
      must(emojiCount >= 6, `expected a colourful, child-friendly emoji set for items and bins, found ${emojiCount} emoji glyphs`);
      must(/border-radius/.test(src), 'the widget has no rounded, child-friendly styling');
      return 'the game consistently uses the seashell/crimson theme plus a rounded, emoji-illustrated widget';
    } },
  { task: 'Test the feedback system for incorrect sorting',
    run: async ({ base, must }) => {
      const player = (await jsonPost(base, '/Player', { name: 'Jordan' })).body.id;
      const session = (await jsonPost(base, `/Player/${player}/action/playNow`, {})).body.created;
      const items = (await jsonGet(base, '/WasteItem')).body.rows;
      const bins = (await jsonGet(base, '/Bin')).body.rows;
      const item = items[0];
      const wrongBin = bins.find((b) => b.id !== Number(item.correctBin));
      const wrong = await jsonPost(base, `/GameSession/${session}/action/drop`, { item: item.id, bin: wrongBin.id });
      must(wrong.status === 200 && wrong.body.ok, `an incorrect drop should still be accepted (just marked wrong): ${JSON.stringify(wrong.body)}`);
      const rightBin = bins.find((b) => b.id === Number(item.correctBin));
      must(new RegExp(`Not quite.*${rightBin.name} bin`).test(wrong.body.flash), `expected a gentle correction naming the right bin, got "${wrong.body.flash}"`);
      must(!/wrong!|fail|stupid|bad job/i.test(wrong.body.flash), 'the correction message is discouraging, not gentle');
      must(wrong.body.row.correct === 0 && wrong.body.row.total === 1, `the miss should count toward total but not correct: ${JSON.stringify(wrong.body.row)}`);
      const repeat = await jsonPost(base, `/GameSession/${session}/action/drop`, { item: item.id, bin: rightBin.id });
      must(repeat.status === 400 && /already sorted/.test(repeat.body.errors[0]), `re-dropping the same item should be refused: ${JSON.stringify(repeat.body)}`);
      return `a wrong drop is accepted with a gentle correction naming the right bin ("${rightBin.name}"); re-dropping the same item is refused`;
    } },
  { task: 'Verify the awarding of rewards and recognition within the game',
    run: async ({ base, must }) => {
      const player = (await jsonPost(base, '/Player', { name: 'Taylor' })).body.id;
      const session = (await jsonPost(base, `/Player/${player}/action/playNow`, {})).body.created;
      const items = (await jsonGet(base, '/WasteItem')).body.rows;
      let last;
      for (const item of items) last = await jsonPost(base, `/GameSession/${session}/action/drop`, { item: item.id, bin: item.correctBin });
      must(last.body.row.status === 'finished', `the game should finish once every item is sorted: ${JSON.stringify(last.body.row)}`);
      must(last.body.row.correct >= 5, `expected at least 5 correct sorts to qualify for a badge: ${last.body.row.correct}`);
      must(last.body.row.badge === 'Recycling Star', `no badge was awarded for a fully correct game: ${JSON.stringify(last.body.row)}`);
      // The reward screen is client-rendered by the widget from the row the
      // server already finished — a plain fetch of the page would only see
      // the empty mount point, so this needs a real browser.
      const b = await openBrowser(`${base}/GameSession/${session}`);
      try {
        await b.until(`document.querySelector('[data-finished]')`);
        must(await b.eval(`document.querySelector('[data-badge]').textContent.includes('Recycling Star')`), 'the reward screen does not show the earned badge');
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return `sorting all ${items.length} items correctly finishes the game and awards the "Recycling Star" badge, shown on a reward screen`;
    } },
  colorCheck('seashell', 'crimson'),
];
