// Server side of the 2048 reference-style widget app: the rules engine (pure
// functions, exported by name so checks.mjs can use them as an oracle — see
// docs/FORMAT.md "Deterministic randomness") plus the two blocks and the one
// widget that use them. The board is a flat 16-cell array of ints (0 = empty),
// stored as a comma-separated "text" field; row/col index = r*4+c.
export const SIZE = 4;

// --- deterministic PRNG: seeded by the row's own id, advanced by a persisted
// "draws" counter so a stateless request can pick up the same sequence a
// check replays independently (same seed, same draw count in, same value out).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// One "draw" is one float; a call site says how many draws it needs and
// starting where, so the same (seed, draws-so-far) always yields the same run.
export function drawAt(seed, draw) {
  return mulberry32((Number(seed) * 2654435761 + Number(draw)) >>> 0)();
}

export function parseBoard(text) { return String(text).split(',').map(Number); }
export function formatBoard(arr) { return arr.join(','); }
export function emptyCells(board) { return board.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0); }

// Places one new tile (90% a 2, 10% a 4) on a random empty cell; consumes two
// draws (position, then value) starting at `draw`. A full board is a no-op
// (0 draws consumed) so callers can tell whether a tile actually spawned.
export function spawnTile(board, seed, draw) {
  const empties = emptyCells(board);
  if (!empties.length) return { board, draw, spawned: false };
  const idx = empties[Math.floor(drawAt(seed, draw) * empties.length)];
  const value = drawAt(seed, draw + 1) < 0.9 ? 2 : 4;
  const next = board.slice();
  next[idx] = value;
  return { board: next, draw: draw + 2, spawned: true };
}

// Slides+merges one row toward its start (index 0); each tile merges at most
// once per move (standard 2048 rule — a freshly-merged tile never re-merges
// in the same pass).
function slideRowLeft(row) {
  const nums = row.filter((v) => v !== 0);
  const merged = [];
  let scoreGain = 0;
  for (let i = 0; i < nums.length; i++) {
    if (i < nums.length - 1 && nums[i] === nums[i + 1]) { merged.push(nums[i] * 2); scoreGain += nums[i] * 2; i++; }
    else merged.push(nums[i]);
  }
  while (merged.length < row.length) merged.push(0);
  return { row: merged, scoreGain };
}
function toGrid(board) { const g = []; for (let r = 0; r < SIZE; r++) g.push(board.slice(r * SIZE, (r + 1) * SIZE)); return g; }
function toBoard(grid) { return grid.flat(); }
// Rotate the grid 90° clockwise; direction D becomes "slide left" after
// rotating D→left that many quarter-turns, then rotated back.
function rotateCW(g) {
  const n = g.length;
  const res = Array.from({ length: n }, () => Array(n).fill(0));
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) res[c][n - 1 - r] = g[r][c];
  return res;
}
const QUARTER_TURNS = { left: 0, up: 3, right: 2, down: 1 };

export function applyDirection(board, direction) {
  const turns = QUARTER_TURNS[direction];
  let g = toGrid(board);
  for (let i = 0; i < turns; i++) g = rotateCW(g);
  let scoreGain = 0;
  g = g.map((row) => { const r = slideRowLeft(row); scoreGain += r.scoreGain; return r.row; });
  for (let i = 0; i < (4 - turns) % 4; i++) g = rotateCW(g);
  return { board: toBoard(g), scoreGain };
}
export function boardsEqual(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }
export function canMove(board) {
  return ['up', 'down', 'left', 'right'].some((d) => !boardsEqual(applyDirection(board, d).board, board));
}
export function hasWon(board) { return board.some((v) => v >= 2048); }

const DIRECTIONS = ['up', 'down', 'left', 'right'];

export default {
  blocks: {
    // A global action's own step, not a "created" event (db.create/db.createRow
    // steps never fire Entity.created — only the standard form-create route
    // does): insert a blank row, then use its own freshly-minted id as the PRNG
    // seed to place its first two tiles, all inside one block so the row is
    // never visible half-initialized.
    'game2048.newGame': {
      summary: 'create a fresh Game row with two random initial tiles (2 or 4), seeded by its own id',
      effects: ['db.write'], requires: [],
      run: ({ store }) => {
        const id = store.insert('Game', { board: formatBoard(new Array(SIZE * SIZE).fill(0)), score: 0, status: 'playing', won: 0, draws: 0 });
        let board = new Array(SIZE * SIZE).fill(0);
        let draw = 0;
        ({ board, draw } = spawnTile(board, id, draw));
        ({ board, draw } = spawnTile(board, id, draw));
        store.update('Game', id, { board: formatBoard(board), draws: draw });
        return { id };
      },
    },
    'game2048.move': {
      summary: 'slide/merge the board toward "direction" (up/down/left/right); refuses if the game is over, the direction is invalid, or nothing would move; otherwise merges, scores, spawns one tile and updates status/won',
      effects: ['db.write'], requires: ['direction'],
      run: ({ store, entity, id, step, resolve }) => {
        const row = store.get(entity, id);
        if (row.status !== 'playing') throw new Error('The game is already over');
        const direction = String(resolve({ v: step.direction }).v);
        if (!DIRECTIONS.includes(direction)) throw new Error(`direction must be one of: ${DIRECTIONS.join(', ')}`);
        const board = parseBoard(row.board);
        const { board: moved, scoreGain } = applyDirection(board, direction);
        if (boardsEqual(moved, board)) throw new Error('No tiles can move that way');
        const { board: spawned, draw } = spawnTile(moved, id, row.draws);
        const won = row.won || hasWon(spawned) ? 1 : 0;
        const status = canMove(spawned) ? 'playing' : 'over';
        store.update(entity, id, { board: formatBoard(spawned), score: row.score + scoreGain, draws: draw, won, status });
        return {};
      },
    },
    // Recomputes status/won from whatever board is currently stored: shared by
    // the move block's own bookkeeping (inlined above) and by a direct edit of
    // the board (Game.updated event) — e.g. a check engineering a deadlock/near-
    // win position the same way the reference tictactoe app leaves the board
    // field on the generic edit form for exactly this purpose.
    'game2048.sync': {
      summary: 'recompute status (over, if no direction moves anything) and won (if a 2048 tile is present) from the current board',
      effects: ['db.write'], requires: [],
      run: ({ store, entity, id }) => {
        const row = store.get(entity, id);
        const board = parseBoard(row.board);
        const won = row.won || hasWon(board) ? 1 : 0;
        const status = canMove(board) ? 'playing' : 'over';
        store.update(entity, id, { won, status });
        return {};
      },
    },
  },
  widgets: {
    game2048: {
      summary: 'the 4x4 tile board; arrow-key or on-screen direction buttons post a move and re-render from the JSON answer',
      client: './game2048.client.mjs',
    },
  },
};
