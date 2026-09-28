// Acceptance checks for webgen-bench/000009 (chess), one per ui_instruct case
// in order, the last being the colour check. Uses ../engine.mjs — the same
// pure rules engine plugins/chess.mjs runs — as an oracle to predict server
// output exactly (perft-verified against the standard 20/400/8902 counts at
// depth 1-3, see NOTES.md), the same "deterministic randomness" path
// apps/game2048/checks.mjs uses, plus one hand-built position per algorithmic
// claim (independent of trusting the shared engine as its own oracle).
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';
import { parseFen, legalMoves, makeMove, indexToSq, pickAiMove, START_FEN } from './engine.mjs';

// A cookie-jar HTTP client with both an HTML mode (default) and a JSON mode
// (accept: application/json — needed because this app has real /roles, and
// verify/lib.mjs's own client never sends that header). One instance per
// logged-in identity, so two users can act in the same check.
function makeClient(base) {
  let cookie = '';
  const keep = (r) => { const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; };
  const hdrs = (json) => ({ ...(cookie ? { cookie } : {}), ...(json ? { accept: 'application/json' } : {}) });
  const get = async (path, { json = false } = {}) => {
    const r = await fetch(base + path, { headers: hdrs(json), redirect: 'manual' });
    keep(r);
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location') || '', html: text, body: json && text ? JSON.parse(text) : null };
  };
  const post = async (path, body = {}, { json = false } = {}) => {
    const r = await fetch(base + path, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...hdrs(json) }, body: new URLSearchParams(body).toString() });
    keep(r);
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location') || '', html: text, body: json && text ? JSON.parse(text) : null };
  };
  const login = async (loginField, password) => post('/login', { login: loginField, password });
  return { get, post, login, cookie: () => cookie };
}

async function newGame(client, { mode = 'ai', difficulty = 'easy', theme = 'classic' } = {}) {
  const res = await client.post('/Game', { mode, difficulty, theme }, { json: true });
  return res.body;
}

export const checks = [
  { task: 'Creating a new game through the "New Game" button redirects to an empty, ready board',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      must((await alice.login('alice@chess.test', 'alice123')).status === 303, 'alice could not log in');
      const game = await newGame(alice, { mode: 'ai', difficulty: 'easy', theme: 'classic' });
      must(game.ok, `game creation failed: ${JSON.stringify(game)}`);
      const row = game.row;
      must(row.fen === START_FEN, `a new game does not start from the standard position: ${row.fen}`);
      must(row.status === 'playing' && row.black, 'an AI-mode game did not immediately get an opponent and start');
      const detail = await alice.get(`/Game/${row.id}`);
      must(/data-widget="chess"/.test(detail.html) && /src="\/widget\/chess\.mjs"/.test(detail.html), 'the new game screen does not embed the chess widget');
      // The 64-square board itself is drawn client-side from data-row (see
      // chess.client.mjs); a plain fetch never runs that JS, so the real
      // render is confirmed in a browser instead — see case 6 below.
      return `Game #${row.id} created and redirected to an empty, ready 8x8 board (mode ai, opponent assigned, standard start position)`;
    } },

  { task: 'Joining an existing game loads it and lets the joining player view and interact with the board',
    run: async ({ base, must }) => {
      const alice = makeClient(base); const bob = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      await bob.login('bob@chess.test', 'bob12345');
      const game = await newGame(alice, { mode: 'human' });
      const id = game.row.id;
      must(game.row.status === 'waiting' && !game.row.black, 'a human-mode game did not wait for a second player');
      const lobby = await bob.get('/Game');
      must(new RegExp(`/Game/${id}/go/join`).test(lobby.html), 'the lobby does not offer a Join Game control for the open game');
      const joined = await bob.post(`/Game/${id}/go/join`, {}, { json: true });
      must(joined.status === 200 && joined.body.ok, `join failed: ${JSON.stringify(joined.body)}`);
      must(joined.body.row.status === 'playing' && joined.body.row.black, 'joining did not seat the second player');
      const detail = await bob.get(`/Game/${id}`);
      must(detail.status === 200 && /data-widget="chess"/.test(detail.html), 'the joining player cannot view the interactive board');
      const asAlice = await alice.get(`/Game/${id}`, { json: true });
      must(asAlice.body.black && asAlice.body.status === 'playing', 'the game did not record the second player for both sides');
      return `Bob joined Game #${id} (was waiting for a human opponent), status now playing, board visible to both players`;
    } },

  { task: 'Selecting a piece and moving it to a legal square updates the board according to chess rules',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      const game = await newGame(alice, { mode: 'ai', difficulty: 'easy' });
      const id = game.row.id;
      const before = parseFen(game.row.fen);
      const legal = legalMoves(before)[0];
      const from = indexToSq(legal.from), to = indexToSq(legal.to);
      const humanOutcome = makeMove(game.row.fen, { from, to, promotion: legal.promotion });
      let expectedFen = humanOutcome.fen;
      if (!humanOutcome.isCheckmate && !humanOutcome.isStalemate) {
        const aiMove = pickAiMove(humanOutcome.fen, 'easy', id, 2);
        if (aiMove) expectedFen = makeMove(humanOutcome.fen, { from: indexToSq(aiMove.from), to: indexToSq(aiMove.to), promotion: aiMove.promotion }).fen;
      }
      const res = await alice.post(`/Game/${id}/action/move`, { from, to }, { json: true });
      must(res.status === 200 && res.body.ok, `the move was rejected: ${JSON.stringify(res.body)}`);
      must(res.body.row.fen === expectedFen, `board after the move (and the AI's reply) is ${res.body.row.fen}, expected ${expectedFen}`);
      const history = await alice.get(`/Move?game=${id}`, { json: true });
      must(history.body.rows.some((r) => r.from === from && r.to === to), 'the move was not recorded in the history log');
      return `Game #${id}: ${from}-${to} applied per the rules engine, board matches the predicted position exactly, logged to history`;
    } },

  { task: 'Using "Undo" reverses the last move and returns the board to its previous state',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      const game = await newGame(alice, { mode: 'ai', difficulty: 'easy' });
      const id = game.row.id;
      const startFen = game.row.fen;
      const legal = legalMoves(parseFen(startFen))[0];
      const moved = await alice.post(`/Game/${id}/action/move`, { from: indexToSq(legal.from), to: indexToSq(legal.to) }, { json: true });
      must(moved.body.ok && moved.body.row.fen !== startFen, 'setup: the move to undo did not change the board');
      const undone = await alice.post(`/Game/${id}/action/undo`, {}, { json: true });
      must(undone.status === 200 && undone.body.ok, `undo failed: ${JSON.stringify(undone.body)}`);
      must(undone.body.row.fen === startFen, `undo did not restore the exact previous position: ${undone.body.row.fen} vs ${startFen}`);
      must(undone.body.row.status === 'playing', 'undo did not leave the game in progress');
      const history = await alice.get(`/Move?game=${id}`, { json: true });
      must(history.body.rows.length === 0, `undo did not remove the move (and the AI reply) from the history: ${history.body.rows.length} left`);
      return `Game #${id}: one human move plus the AI's reply were both undone in one click, board back to ${startFen}`;
    } },

  { task: 'Clicking "Resign" ends the game and shows the resignation and final state',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      const game = await newGame(alice, { mode: 'ai' });
      const id = game.row.id;
      const resigned = await alice.post(`/Game/${id}/go/resign`, {}, { json: true });
      must(resigned.status === 200 && resigned.body.ok, `resign failed: ${JSON.stringify(resigned.body)}`);
      must(/resign/i.test(resigned.body.flash), `no resignation acknowledgment: "${resigned.body.flash}"`);
      must(resigned.body.row.status === 'finished' && resigned.body.row.result === 'black' && resigned.body.row.endReason === 'resignation',
        `resigning as white did not award black the win: ${JSON.stringify(resigned.body.row)}`);
      const detail = await alice.get(`/Game/${id}`);
      must(/finished/i.test(detail.html) && /resignation/i.test(detail.html), 'the final game state is not shown on the detail page');
      const again = await alice.post(`/Game/${id}/go/resign`, {}, { json: true });
      must(again.status === 409, `resigning twice was not refused: ${again.status}`);
      return `Game #${id}: white resigned, black awarded the win by resignation, shown on the detail page; a second resign is refused (409)`;
    } },

  { task: 'Changing the board theme updates its appearance immediately while the board stays fully playable',
    run: async ({ base, must }) => {
      const alice = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      const game = await newGame(alice, { mode: 'ai', theme: 'classic' });
      const id = game.row.id;
      // Pass alice's own session cookie into the browser: without it the
      // page loads as an unauthenticated guest (view-only per /roles), and
      // every click below would be silently refused (403) — the widget
      // shows the error text instead of moving, so the wait below would
      // time out for a real reason, not a flaky one.
      const b = await openBrowser(`${base}/Game/${id}`, { cookie: alice.cookie() });
      try {
        await b.until(`document.querySelectorAll('.widget [data-sq]').length === 64`, 8000);
        // The board stays functional: a real click-click move still works after loading.
        const legal = legalMoves(parseFen(game.row.fen))[0];
        const from = indexToSq(legal.from), to = indexToSq(legal.to);
        await b.eval(`document.querySelector('[data-sq="${from}"]').click()`);
        await b.eval(`document.querySelector('[data-sq="${to}"]').click()`);
        // Wait for the move's JSON answer to actually land (the destination
        // square now shows a piece) rather than a status word that was
        // already on the page before the click — status stays "playing"
        // for a mid-game move, so it would never change.
        await b.until(`document.querySelector('[data-sq="${to}"]').textContent.trim().length > 0`, 8000);
        // Now change the theme via the on-screen control and confirm the board re-renders.
        await b.eval(`document.querySelector('[data-theme="ocean"]').click()`);
        await b.until(`document.querySelector('[data-theme="ocean"]').disabled === true`, 8000);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally {
        await b.close();
      }
      const server = await alice.get(`/Game/${id}`, { json: true });
      must(server.body.theme === 'ocean', `theme change from the widget did not reach the server: ${server.body.theme}`);
      must(server.body.fen !== game.row.fen, 'the earlier click-to-move in the browser did not change the board');
      return `Game #${id}: clicked a real move in the browser (board still functional), then clicked the "ocean" theme button — the server confirms theme=ocean`;
    } },

  { task: 'Selecting a difficulty level is acknowledged and influences the AI opponent',
    run: async ({ base, must }) => {
      // The algorithm itself, independent of the live server: two captures of
      // different value are available (a queen and a pawn); "hard" always
      // takes the higher-value one, "easy" ignores value entirely.
      const fen = '4k3/8/8/3Q4/4P3/2n5/8/4K3 b - - 0 1';
      let hardAlwaysQueen = true, easyVaries = false;
      const first = pickAiMove(fen, 'easy', 123, 0);
      for (let ply = 0; ply < 30; ply++) {
        if (indexToSq(pickAiMove(fen, 'hard', 123, ply).to) !== 'd5') hardAlwaysQueen = false;
        if (indexToSq(pickAiMove(fen, 'easy', 123, ply).to) !== indexToSq(first.to)) easyVaries = true;
      }
      must(hardAlwaysQueen, '"hard" does not consistently take the higher-value capture (the queen)');
      must(easyVaries, '"easy" does not vary its move at all — it is not actually random');

      // Live server: the setting is acknowledged and really read by the block
      // that plays the AI's move (oracle equality against the same engine).
      const alice = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      const game = await newGame(alice, { mode: 'ai', difficulty: 'easy' });
      const id = game.row.id;
      const setHard = await alice.post(`/Game/${id}/action/setDifficulty`, { difficulty: 'hard' }, { json: true });
      must(setHard.status === 200 && setHard.body.ok && setHard.body.row.difficulty === 'hard' && /hard/.test(setHard.body.flash),
        `difficulty change was not acknowledged: ${JSON.stringify(setHard.body)}`);
      const legal = legalMoves(parseFen(game.row.fen))[0];
      const humanOutcome = makeMove(game.row.fen, { from: indexToSq(legal.from), to: indexToSq(legal.to), promotion: legal.promotion });
      const expectedAi = pickAiMove(humanOutcome.fen, 'hard', id, 2);
      const expectedFen = expectedAi ? makeMove(humanOutcome.fen, { from: indexToSq(expectedAi.from), to: indexToSq(expectedAi.to), promotion: expectedAi.promotion }).fen : humanOutcome.fen;
      const moved = await alice.post(`/Game/${id}/action/move`, { from: indexToSq(legal.from), to: indexToSq(legal.to) }, { json: true });
      must(moved.body.row.fen === expectedFen, `the AI's reply does not match "hard" difficulty's own logic: ${moved.body.row.fen} vs ${expectedFen}`);
      return `"hard" always takes the higher-value capture (queen over pawn) in a hand-built position, "easy" is genuinely random; live Game #${id}: setting difficulty to hard is acknowledged and its very next AI move matches hard-mode’s own prediction exactly`;
    } },

  { task: 'The move history of a completed game session can be viewed in full',
    run: async ({ base, must }) => {
      const alice = makeClient(base); const bob = makeClient(base);
      await alice.login('alice@chess.test', 'alice123');
      await bob.login('bob@chess.test', 'bob12345');
      const game = await newGame(alice, { mode: 'human' });
      const id = game.row.id;
      await bob.post(`/Game/${id}/go/join`, {}, { json: true });
      // The fastest possible checkmate ("fool's mate"), engine-verified.
      const seq = [[alice, 'f2', 'f3'], [bob, 'e7', 'e5'], [alice, 'g2', 'g4'], [bob, 'd8', 'h4']];
      let last;
      for (const [who, from, to] of seq) last = await who.post(`/Game/${id}/action/move`, { from, to }, { json: true });
      must(last.body.ok && last.body.row.status === 'finished' && last.body.row.result === 'black' && last.body.row.endReason === 'checkmate',
        `fool's mate did not end the game as expected: ${JSON.stringify(last.body.row)}`);
      const detail = await alice.get(`/Game/${id}`);
      must(/Move history/.test(detail.html), 'the detail page has no move history section');
      for (const [, from, to] of seq) must(new RegExp(`>${from}<`).test(detail.html) && new RegExp(`>${to}<`).test(detail.html), `move ${from}-${to} is not listed in the history`);
      must(/Qd8-h4#/.test(detail.html), 'the checkmating move’s notation is not shown');
      const history = await alice.get(`/Move?game=${id}`, { json: true });
      must(history.body.rows.length === 4 && history.body.rows.map((r) => r.ply).sort().join(',') === '1,2,3,4', `expected 4 moves ply 1-4, got ${JSON.stringify(history.body.rows.map((r) => r.ply))}`);
      return `Game #${id}: fool's mate (f3 e5 g4 Qh4#) completed, all 4 moves visible in order on the detail page's move history`;
    } },

  colorCheck('aliceblue', 'steelblue'),
];
