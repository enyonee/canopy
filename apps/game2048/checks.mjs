// Acceptance checks for webgen-bench/000013 (2048), one per ui_instruct case in
// order, the last being the colour check. Random tile placement is seeded by
// each Game row's own id (see plugins/game2048.mjs) so these checks can import
// the same pure engine and predict server output exactly instead of merely
// asserting invariants — the "deterministic randomness" path docs/FORMAT.md
// recommends. Each directional check additionally asserts one hand-computed
// slide+merge example (domain knowledge, not just re-trusting the shared
// function as its own oracle), the same spirit as tictactoe's hardcoded
// winning line.
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';
import { parseBoard, formatBoard, applyDirection, spawnTile, boardsEqual, canMove, hasWon } from './plugins/game2048.mjs';

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

async function freshGame(base) {
  const created = await jsonPost(base, '/action/newGame', {});
  const id = created.body.created;
  const row = (await jsonGet(base, `/Game/${id}`)).body;
  return row;
}

// Predicts what the server's game2048.move block will do to `row`, given the
// same pure functions the block itself runs (imported above, not reimplemented).
function predict(row, direction) {
  const board = parseBoard(row.board);
  const { board: moved, scoreGain } = applyDirection(board, direction);
  if (boardsEqual(moved, board)) return null; // illegal from here: the block would refuse
  const { board: spawned, draw } = spawnTile(moved, row.id, row.draws);
  const won = row.won || hasWon(spawned) ? true : false;
  const status = canMove(spawned) ? 'playing' : 'over';
  return { board: formatBoard(spawned), score: row.score + scoreGain, draws: draw, won, status };
}

// Applies `direction` for real over HTTP and asserts the row matches the
// prediction exactly (board, score and status) — proves the wiring: the
// widget's action really reaches the block, the block really persists, and
// the JSON it hands back really reflects the new row.
async function moveAndVerify(base, row, direction, must) {
  const exp = predict(row, direction);
  if (!exp) throw new Error(`test setup error: "${direction}" is not legal from board ${row.board}`);
  const res = await jsonPost(base, `/Game/${row.id}/action/move`, { direction });
  must(res.status === 200 && res.body.ok, `move ${direction} failed: ${JSON.stringify(res.body)}`);
  const got = res.body.row;
  must(got.board === exp.board, `board after ${direction} was ${got.board}, expected ${exp.board}`);
  must(got.score === exp.score, `score after ${direction} was ${got.score}, expected ${exp.score}`);
  must(got.status === exp.status, `status after ${direction} was ${got.status}, expected ${exp.status}`);
  return got;
}

// Makes sure `direction` is legal on `row`; if it is not (rare — needs a
// genuinely unlucky random placement), primes the board with one legal move
// in a different direction first, so the case under test never spuriously
// hits "no tiles can move that way".
async function ensureLegal(base, row, direction, must) {
  if (predict(row, direction)) return row;
  for (const d of ['left', 'right', 'up', 'down']) {
    if (d === direction) continue;
    if (predict(row, d)) return moveAndVerify(base, row, d, must);
  }
  throw new Error(`test setup error: no direction at all is legal on board ${row.board}`);
}

// A hand-computed example, independent of trusting applyDirection as its own
// oracle: column/row [_,2,2,4] slides/merges to [4,4,_,_] with score +4 — the
// textbook "two equal tiles collide and merge" case, checked against literal
// expected numbers (0-2-2-4 encodes the SAME numbers whichever axis reads it).
function assertMergeAlgorithm(direction, must) {
  const board = new Array(16).fill(0);
  const put = (r, c, v) => { board[r * 4 + c] = v; };
  if (direction === 'up') { put(1, 0, 2); put(2, 0, 2); put(3, 0, 4); }
  if (direction === 'down') { put(0, 0, 4); put(1, 0, 2); put(2, 0, 2); }
  if (direction === 'left') { put(0, 1, 2); put(0, 2, 2); put(0, 3, 4); }
  if (direction === 'right') { put(0, 0, 4); put(0, 1, 2); put(0, 2, 2); }
  const { board: out, scoreGain } = applyDirection(board, direction);
  must(scoreGain === 4, `${direction}: expected a merge worth +4, got scoreGain ${scoreGain}`);
  const nonZero = out.filter((v) => v !== 0).sort();
  must(nonZero.length === 2 && nonZero[0] === 4 && nonZero[1] === 4,
    `${direction}: expected exactly two 4-tiles after the merge, got [${out.join(',')}]`);
}

async function directionCheck(direction, base, must) {
  assertMergeAlgorithm(direction, must);
  let row = await freshGame(base);
  must(row.status === 'playing' && row.score === 0, `fresh game is not playing/score 0: ${JSON.stringify(row)}`);
  row = await ensureLegal(base, row, direction, must);
  const before = parseBoard(row.board);
  const after = await moveAndVerify(base, row, direction, must);
  const beforeCount = before.filter((v) => v !== 0).length;
  const afterCount = parseBoard(after.board).filter((v) => v !== 0).length;
  must(afterCount >= 1, 'the board went empty after a move');
  return `hand-computed ${direction} merge (2+2→4, score +4); a live move ${direction} matches the predicted board/score/status exactly (${beforeCount} tiles → ${afterCount})`;
}

// Round-4 rule for widget apps: a JSON-protocol check alone is not enough —
// at least one check must drive the real widget in a real browser and then
// confirm the server actually changed (see apps/tictactoe check 7). Folded
// into the "up" case (rather than a 9th array entry) so checks.mjs still
// carries exactly one entry per ui_instruct case.
async function browserMoveUp(base, must) {
  const row = await freshGame(base);
  const target = predict(row, 'up') ? row : await ensureLegal(base, row, 'up', must);
  const expected = predict(target, 'up');
  const b = await openBrowser(`${base}/Game/${target.id}`);
  try {
    await b.until(`document.querySelectorAll('.widget [data-dir]').length === 4`);
    await b.eval(`document.querySelector('[data-dir="up"]').click()`);
    await b.until(`document.querySelector('[data-score]').textContent === '${expected.score}'`);
    must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
  } finally { await b.close(); }
  const server = (await jsonGet(base, `/Game/${target.id}`)).body;
  must(server.board === expected.board && server.score === expected.score,
    `the click did not reach the server as expected: ${JSON.stringify(server)} vs ${JSON.stringify(expected)}`);
  return `in a real browser, clicking the "up" direction button on Game #${target.id} moved the score to ${server.score} and the server's own row matches (board ${server.board})`;
}

export const checks = [
  { task: 'Starting a new game initializes an empty-ish board with two tiles and score 0',
    run: async ({ base, must }) => {
      const row = await freshGame(base);
      const board = parseBoard(row.board);
      const nonZero = board.filter((v) => v !== 0);
      must(board.length === 16, `board is not 16 cells: ${row.board}`);
      must(nonZero.length === 2, `expected exactly 2 tiles on a fresh board, got ${nonZero.length} (${row.board})`);
      must(nonZero.every((v) => v === 2 || v === 4), `a fresh tile is not 2 or 4: ${row.board}`);
      must(row.score === 0, `score is not 0 on a fresh game: ${row.score}`);
      must(row.status === 'playing', `status is not playing on a fresh game: ${row.status}`);
      return `new Game #${row.id}: board has exactly two 2/4 tiles, score 0, status playing`;
    } },
  { task: 'Moving tiles up slides and merges toward the top, updating the board and score, and a new tile appears',
    run: async ({ base, must }) => {
      const httpResult = await directionCheck('up', base, must);
      const browserResult = await browserMoveUp(base, must);
      return `${httpResult}; ${browserResult}`;
    } },
  { task: 'Moving tiles down slides and merges toward the bottom, updating the board and score, and a new tile appears',
    run: async ({ base, must }) => directionCheck('down', base, must) },
  { task: 'Moving tiles left slides and merges toward the left, updating the board and score, and a new tile appears',
    run: async ({ base, must }) => directionCheck('left', base, must) },
  { task: 'Moving tiles right slides and merges toward the right, updating the board and score, and a new tile appears',
    run: async ({ base, must }) => directionCheck('right', base, must) },
  { task: 'When no move is possible the game ends and the page offers a way to revive',
    run: async ({ base, get, must }) => {
      const row = await freshGame(base);
      // A full checkerboard of 2s and 4s: every pair of orthogonal neighbours
      // differs, so no slide and no merge is possible in any direction —
      // canMove() must agree locally before we even touch the server.
      const deadlock = '2,4,2,4,4,2,4,2,2,4,2,4,4,2,4,2';
      must(canMove(parseBoard(deadlock)) === false, 'test setup error: the "deadlock" board is not actually stuck');
      const edited = await jsonPost(base, `/Game/${row.id}`, { board: deadlock, score: '100', won: 'false', draws: String(row.draws) });
      must(edited.status === 200 && edited.body.ok, `could not set up the deadlock board: ${JSON.stringify(edited.body)}`);
      const after = await jsonGet(base, `/Game/${row.id}`);
      must(after.body.status === 'over', `status did not become "over" on a stuck board: ${JSON.stringify(after.body)}`);
      const detail = await get(`/Game/${row.id}`);
      must(/go\/revive/.test(detail.html) && /Revive/.test(detail.html), 'the detail page does not offer a Revive option once the game is over');
      const blocked = await jsonPost(base, `/Game/${row.id}/action/move`, { direction: 'up' });
      must(blocked.status === 400, `a move was accepted on a finished game: ${JSON.stringify(blocked.body)}`);
      return `Game #${row.id} stuck (no legal move in any direction) → status over, a Revive button is offered, further moves refused (400)`;
    } },
  { task: 'Reviving after game over resumes play with the board unchanged, and a real move works normally again afterwards',
    run: async ({ base, must }) => {
      const row = await freshGame(base);
      const deadlock = '2,4,2,4,4,2,4,2,2,4,2,4,4,2,4,2'; // full checkerboard: no slide, no merge, anywhere
      must(canMove(parseBoard(deadlock)) === false, 'test setup error: the "deadlock" board is not actually stuck');
      await jsonPost(base, `/Game/${row.id}`, { board: deadlock, score: '50', won: 'false', draws: String(row.draws) });
      const over = await jsonGet(base, `/Game/${row.id}`);
      must(over.body.status === 'over', `test setup error: board is not actually stuck: ${JSON.stringify(over.body)}`);
      const revived = await jsonPost(base, `/Game/${row.id}/go/revive`, {});
      must(revived.status === 200 && revived.body.ok && /[Rr]evive/.test(revived.body.flash), `revive did not succeed: ${JSON.stringify(revived.body)}`);
      must(revived.body.row.status === 'playing', `status after revive is not playing: ${revived.body.row.status}`);
      must(revived.body.row.board === deadlock, `revive changed the board: ${revived.body.row.board} vs ${deadlock}`);
      // The board is a genuine deadlock, so no move is legal immediately after
      // reviving it (see NOTES.md "Weakened cases") — demonstrate instead that
      // a fresh, non-stuck game keeps moving normally once revived from a
      // manual "give up", proving revive itself is a real, reusable transition.
      const fresh = await freshGame(base);
      await jsonPost(base, `/Game/${fresh.id}/go/giveUp`, {});
      const revived2 = await jsonPost(base, `/Game/${fresh.id}/go/revive`, {});
      must(revived2.body.row.status === 'playing', `second revive did not return to playing: ${JSON.stringify(revived2.body)}`);
      const moved = await moveAndVerify(base, revived2.body.row, ['up', 'down', 'left', 'right'].find((d) => predict(revived2.body.row, d)), must);
      must(moved.status === 'playing' || moved.status === 'over', 'move after revive produced no status at all');
      return `Game #${row.id} revived from a true deadlock: status playing, board bit-for-bit unchanged, flash "${revived.body.flash}"; Game #${fresh.id} revived from give-up and a normal move still works`;
    } },
  colorCheck('linen', 'maroon'),
];
