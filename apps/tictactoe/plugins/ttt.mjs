// Server side of the tic-tac-toe reference app: the block that owns the game
// rules (this is the "classical code" the format's boundary rule allows —
// the graph stays closed, this file is trusted, check/plugins.mjs and the
// registry contract are all the checker knows about it) and the widget
// registration. Its "client" is resolved against the app directory, exactly
// like a plugin path — the browser file it names (apps/tictactoe/ttt.client.mjs)
// is kept out of plugins/ on purpose: that directory is blindly imported as
// server-side plugin code by the registry-contract test, and a browser file
// does not belong there (see docs/FORMAT.md's «Widgets»).
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

function winner(board) {
  for (const [a, b, c] of LINES) if (board[a] !== '_' && board[a] === board[b] && board[b] === board[c]) return board[a];
  return null;
}

export default {
  blocks: {
    'ttt.move': {
      summary: 'apply a move at "cell" (0-8) to the current Game: refuses if the game is over, the cell is out of range, or it is already taken; otherwise flips the turn or resolves the winner/draw',
      effects: ['db.write'], requires: ['cell'],
      run: ({ store, entity, id, step, resolve }) => {
        const row = store.get(entity, id);
        if (row.status !== 'playing') throw new Error('The game is already over');
        const cell = Number(resolve({ v: step.cell }).v);
        if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('cell must be 0-8');
        const board = row.board.split('');
        if (board[cell] !== '_') throw new Error('That cell is already taken');
        board[cell] = row.turn;
        const win = winner(board.join(''));
        const full = !board.includes('_');
        const status = win ? `${row.turn}_won` : full ? 'draw' : 'playing';
        store.update(entity, id, { board: board.join(''), turn: status === 'playing' ? (row.turn === 'x' ? 'o' : 'x') : row.turn, status });
        return {};
      },
    },
  },
  widgets: {
    ttt: {
      summary: 'a tic-tac-toe board; clicking an empty cell posts a move and re-renders from the JSON answer',
      client: './ttt.client.mjs',
    },
  },
};
