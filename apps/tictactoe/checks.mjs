// Reference app "tictactoe" (see app.json's "task": "reference" — not a
// WebGen-Bench task). Plays a game over HTTP JSON end to end: the widget's
// own protocol with the server, exercised directly instead of through a
// browser, since a plugin block's rules and the JSON-answers path are what
// this app is proving, not the HTML scaffold (that is every other app's job).
import { openBrowser } from '../../verify/browser.mjs';
import { navCheck, colorCheck } from '../../verify/lib.mjs';

const jsonGet = async (base, path) => {
  const r = await fetch(base + path, { headers: { accept: 'application/json' } });
  return { status: r.status, body: await r.json() };
};
const jsonPost = async (base, path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString() });
  return { status: r.status, body: await r.json() };
};

export const checks = [
  { task: 'A new game answers JSON: empty board, X to move, playing',
    run: async ({ base, must }) => {
      const game = await jsonGet(base, '/Game/1');
      must(game.status === 200, `detail JSON returned ${game.status}`);
      must(game.body.board === '_________' && game.body.turn === 'x' && game.body.status === 'playing',
        `unexpected new game: ${JSON.stringify(game.body)}`);
      return 'board empty, turn x, status playing';
    } },
  { task: 'A cell outside 0-8 is refused (400) and nothing is written',
    run: async ({ base, must }) => {
      const bad = await jsonPost(base, '/Game/1/action/move', { cell: 9 });
      must(bad.status === 400 && bad.body.ok === false, `an out-of-range cell was accepted: ${bad.status} ${JSON.stringify(bad.body)}`);
      const game = await jsonGet(base, '/Game/1');
      must(game.body.board === '_________', 'the board changed despite the refusal');
      return '400, errors[0] present, board untouched';
    } },
  { task: 'A move is applied and answered as JSON; the same cell again is refused (400)',
    run: async ({ base, must }) => {
      const first = await jsonPost(base, '/Game/1/action/move', { cell: 4 });
      must(first.status === 200 && first.body.ok && first.body.row.board[4] === 'x' && first.body.row.turn === 'o',
        `first move failed: ${JSON.stringify(first.body)}`);
      const again = await jsonPost(base, '/Game/1/action/move', { cell: 4 });
      must(again.status === 400 && again.body.ok === false && /taken/.test(again.body.errors[0]),
        `an occupied cell was accepted: ${again.status} ${JSON.stringify(again.body)}`);
      return 'first move applied (board[4]=x, turn=o), repeat on the same cell 400 "already taken"';
    } },
  { task: 'A full game is playable to a win over JSON, turns alternate, and a finished game refuses further moves',
    run: async ({ base, must }) => {
      const created = await jsonPost(base, '/Game', {});
      must(created.status === 200 && created.body.ok, `create returned ${created.status}: ${JSON.stringify(created.body)}`);
      const id = created.body.id;
      const plays = [0, 3, 1, 4, 2]; // X: 0,1,2 (top row) — O: 3,4, never blocking
      let last;
      for (const cell of plays) last = await jsonPost(base, `/Game/${id}/action/move`, { cell });
      must(last.status === 200 && last.body.row.status === 'x_won', `expected x_won, got ${JSON.stringify(last.body)}`);
      const after = await jsonPost(base, `/Game/${id}/action/move`, { cell: 5 });
      must(after.status === 400 && /already over/.test(after.body.errors[0]), `a finished game accepted a move: ${JSON.stringify(after.body)}`);
      return 'X wins the top row; a further move on the finished game is 400 "already over"';
    } },
  { task: 'Resigning and playing again are real /states transitions',
    run: async ({ base, follow, must }) => {
      const created = await jsonPost(base, '/Game', {});
      const id = created.body.id;
      const resigned = await follow(`/Game/${id}/go/resignX`, {});
      must(resigned.status === 200, `resignX did not land on a page: ${resigned.status}`);
      const g1 = await jsonGet(base, `/Game/${id}`);
      must(g1.body.status === 'o_won', `resignX did not hand the win to o: ${JSON.stringify(g1.body)}`);
      const again = await follow(`/Game/${id}/go/reset`, {});
      must(again.status === 200, `reset did not land on a page: ${again.status}`);
      const g2 = await jsonGet(base, `/Game/${id}`);
      must(g2.body.status === 'playing' && g2.body.board === '_________', `reset did not restore the board: ${JSON.stringify(g2.body)}`);
      return 'resignX -> o_won, reset -> playing with a fresh board';
    } },
  { task: '/widget/ttt.mjs and /widget/_api.mjs are served as JavaScript, and the detail page embeds the widget markup',
    run: async ({ base, get, must }) => {
      const w = await fetch(`${base}/widget/ttt.mjs`);
      must(w.status === 200, `/widget/ttt.mjs returned ${w.status}`);
      must(/javascript/.test(w.headers.get('content-type') || ''), `wrong content-type: ${w.headers.get('content-type')}`);
      must(/mountWidgets\('ttt'/.test(await w.text()), 'the served file is not the declared client module');
      const helper = await fetch(`${base}/widget/_api.mjs`);
      must(helper.status === 200 && /export function mountWidgets/.test(await helper.text()), 'the shared /widget/_api.mjs helper is not served');
      must((await fetch(`${base}/widget/ghost.mjs`)).status === 404, 'an undeclared widget name is not 404');
      const detail = await get('/Game/1');
      must(/data-widget="ttt"/.test(detail.html) && /data-row='/.test(detail.html) && /src="\/widget\/ttt\.mjs"/.test(detail.html),
        'the detail page does not embed the widget markup');
      return 'both files served as JavaScript, an unknown widget 404s, the detail page embeds the widget div and script tag';
    } },
  { task: 'In a real browser the widget mounts, a click plays the move, and the game ends in a win on screen',
    run: async ({ base, post, must }) => {
      const made = await fetch(`${base}/Game`, { method: 'POST', headers: { accept: 'application/json' } }).then((r) => r.json());
      const b = await openBrowser(`${base}/Game/${made.id}`);
      try {
        await b.until(`document.querySelectorAll('.widget [data-cell]').length === 9`);
        for (const cell of [0, 3, 1, 4, 2]) {
          await b.eval(`document.querySelector('[data-cell="${cell}"]').click()`);
          await b.until(`document.querySelector('[data-cell="${cell}"]').disabled`);
        }
        await b.until(`document.querySelector('.widget').innerText.includes('X wins')`);
        must(await b.eval(`[...document.querySelectorAll('[data-cell]')].every((c) => c.disabled)`), 'cells stay clickable after the win');
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const row = await fetch(`${base}/Game/${made.id}`, { headers: { accept: 'application/json' } }).then((r) => r.json());
      must(row.status === 'x_won' && row.board === 'xxxoo____', `the server did not record the clicked game: ${JSON.stringify(row)}`);
      return 'five clicks in headless Chrome → "X wins" on screen, board locked, server row x_won';
    } },
  navCheck(1),
  colorCheck('white', 'teal'),
];
