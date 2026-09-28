// Server side of the chess app: the registry glue (blocks + widget) around
// the pure rules engine in ../engine.mjs (kept out of this directory on
// purpose, like apps/tictactoe's client file is — see engine.mjs's own
// header). The server is the sole authority: every legality check, the AI's
// reply, checkmate/stalemate detection and the win/loss bookkeeping happen
// here; the widget only renders a row and posts {from,to}.
import { START_FEN, parseFen, makeMove, legalMoves, pickAiMove, indexToSq } from '../engine.mjs';

const BOT_EMAIL = 'ai@bot.test';
// ref fields are stored (and read back in JSON) as TEXT — see runtime/fields.mjs
// ("ref: { sql: 'TEXT', ... }") — while a session user's id is a real number;
// every comparison against row.white/row.black must go through this.
const sameUser = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined && Number(a) === Number(b);

function bumpStats(store, row, result) {
  const bump = (userId, field) => {
    if (!userId) return;
    const u = store.get('User', userId);
    if (u) store.update('User', userId, { [field]: (u[field] || 0) + 1 });
  };
  if (result === 'draw') { bump(row.white, 'draws'); bump(row.black, 'draws'); }
  else if (result === 'white') { bump(row.white, 'wins'); bump(row.black, 'losses'); }
  else if (result === 'black') { bump(row.black, 'wins'); bump(row.white, 'losses'); }
}

export default {
  blocks: {
    'chess.setupGame': {
      summary: 'after a Game is created: in AI mode, assign the shared bot user as black and start play immediately; in human mode, leave black empty and status "waiting" for someone to join',
      effects: ['db.write'], requires: [],
      run: ({ store, entity, id }) => {
        const row = store.get(entity, id);
        if (row.mode !== 'ai') return {};
        let bot = store.list('User', { where: { email: BOT_EMAIL } })[0];
        if (!bot) { const botId = store.insert('User', { email: BOT_EMAIL, password: 'not-a-real-login-1', name: 'Computer', role: 'player' }); bot = store.get('User', botId); }
        store.update(entity, id, { black: bot.id, status: 'playing' });
        return {};
      },
    },
    'chess.join': {
      summary: 'the current user joins an open human-mode game as black',
      effects: ['db.write'], requires: [],
      run: ({ store, entity, id, user }) => {
        const row = store.get(entity, id);
        if (row.mode !== 'human') throw new Error('This game is not open for a second human player');
        if (row.black) throw new Error('This game already has a second player');
        if (!user || sameUser(user.id, row.white)) throw new Error('You cannot join your own game');
        store.update(entity, id, { black: user.id });
        return {};
      },
    },
    'chess.resign': {
      // "Only a player of this game" is now the row-level `own: ["white",
      // "black"]` grant on /roles (round 5's multi-field own) — the route
      // never reaches this block for anyone else, so the block only has to
      // decide *which* side that player was.
      summary: 'the current user resigns; the other side is awarded the win',
      effects: ['db.write'], requires: [],
      run: ({ store, entity, id, user }) => {
        const row = store.get(entity, id);
        const result = sameUser(user.id, row.white) ? 'black' : 'white';
        store.update(entity, id, { status: 'finished', result, endReason: 'resignation' });
        bumpStats(store, row, result);
        return {};
      },
    },
    'chess.move': {
      // Parameter named "fromSq", not "from": the generic step checker
      // (runtime/check/steps.mjs) treats any step's "from" as an ENTITY name
      // (the way db.each/random.pick use it) and would reject a source-square
      // string there — see docs/FORMAT.md's step table.
      summary: 'apply a legal move ("fromSq","to", optional "promotion" — default queen) for whichever colour is to move; refuses illegal moves, a move out of turn, or a game that is not in progress; in AI mode the bot replies immediately in the same request',
      effects: ['db.write'], requires: ['fromSq', 'to'],
      run: ({ store, entity, id, step, resolve, user }) => {
        const row = store.get(entity, id);
        if (row.status !== 'playing') throw new Error('This game is not in progress');
        const from = String(resolve({ v: step.fromSq }).v);
        const to = String(resolve({ v: step.to }).v);
        const promotionRaw = step.promotion !== undefined ? resolve({ v: step.promotion }).v : null;
        const promotion = promotionRaw || 'q';
        const before = parseFen(row.fen);
        const mover = before.turn === 'w' ? row.white : row.black;
        if (!user || !sameUser(user.id, mover)) throw new Error('It is not your turn');
        let outcome;
        try { outcome = makeMove(row.fen, { from, to, promotion }); }
        catch { throw new Error('Illegal move'); }
        let ply = store.list('Move', { where: { game: id } }).length + 1;
        store.insert('Move', { game: id, ply, by: user.id, from, to, notation: outcome.notation, fenAfter: outcome.fen });
        let fen = outcome.fen;
        let final = null;
        if (outcome.isCheckmate) final = { result: before.turn === 'w' ? 'white' : 'black', endReason: 'checkmate' };
        else if (outcome.isStalemate) final = { result: 'draw', endReason: 'stalemate' };
        else if (row.mode === 'ai') {
          const aiTurnColor = parseFen(fen).turn;
          const aiMove = pickAiMove(fen, row.difficulty, row.id, ply + 1);
          if (aiMove) {
            const aiFrom = indexToSq(aiMove.from), aiTo = indexToSq(aiMove.to);
            const aiOutcome = makeMove(fen, { from: aiFrom, to: aiTo, promotion: aiMove.promotion });
            ply += 1;
            store.insert('Move', { game: id, ply, by: row.black, from: aiFrom, to: aiTo, notation: aiOutcome.notation, fenAfter: aiOutcome.fen });
            fen = aiOutcome.fen;
            if (aiOutcome.isCheckmate) final = { result: aiTurnColor === 'w' ? 'white' : 'black', endReason: 'checkmate' };
            else if (aiOutcome.isStalemate) final = { result: 'draw', endReason: 'stalemate' };
          }
        }
        if (final) { store.update(entity, id, { fen, status: 'finished', result: final.result, endReason: final.endReason }); bumpStats(store, row, final.result); }
        else store.update(entity, id, { fen });
        return {};
      },
    },
    'chess.undo': {
      // Same row-level `own` grant as chess.resign covers "only a player of
      // this game" here too.
      summary: 'reverse the last move — and, in AI mode, the bot\'s reply with it — restoring the board (and status) to how it was beforehand',
      effects: ['db.write'], requires: [],
      run: ({ store, entity, id }) => {
        const row = store.get(entity, id);
        const moves = store.list('Move', { where: { game: id }, sort: { field: 'id', dir: 'desc' } });
        if (!moves.length) throw new Error('No moves to undo');
        const popCount = row.mode === 'ai' && sameUser(moves[0].by, row.black) && moves.length >= 2 ? 2 : 1;
        for (let i = 0; i < popCount; i++) store.remove('Move', moves[i].id);
        const remaining = moves.slice(popCount);
        const fen = remaining.length ? remaining[0].fenAfter : START_FEN;
        store.update(entity, id, { fen, status: 'playing', result: 'none', endReason: 'none' });
        return {};
      },
    },
  },
  widgets: {
    // No declared props: like apps/tictactoe's "ttt" widget, everything the
    // client needs (fen, mode, difficulty, theme, status...) travels in the
    // row JSON the server already attaches as data-row — a prop here would
    // only ever be the literal string in app.json (widgetBlock() does not
    // resolve "@row.x"; see runtime/render.mjs), so a per-row value must
    // come from data-row, never from a declared prop.
    chess: {
      summary: 'an 8x8 clickable board; click a piece then a destination square to post a move (auto-queen promotion); also renders theme/difficulty controls',
      client: './chess.client.mjs',
    },
  },
};
