// Pure chess rules engine: FEN in, FEN out. No storage, no HTTP, no registry
// contract — kept out of plugins/ on purpose (like apps/tictactoe's
// ttt.client.mjs is kept out of plugins/ for the opposite reason): this file
// has nothing to do with the registry, it is just imported by
// plugins/chess.mjs (server blocks) and by checks.mjs (the oracle for
// assertions), so it stays a plain, ordinary module either side can import.
//
// Full legal-move generation including check, pins, castling (both sides,
// through-check and blocking-piece rules), en passant, and promotion.
// Checkmate/stalemate are exactly "no legal moves, in check or not".

const FILES = 'abcdefgh';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const sqToIndex = (sq) => {
  const file = FILES.indexOf(sq[0]);
  const rank = Number(sq[1]) - 1;
  return rank * 8 + file;
};
export const indexToSq = (idx) => `${FILES[idx % 8]}${Math.floor(idx / 8) + 1}`;
const fileOf = (idx) => idx % 8;
const rankOf = (idx) => Math.floor(idx / 8);
const inBounds = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

export function parseFen(fen) {
  const [placement, turn, castling, ep, halfmove, fullmove] = String(fen).trim().split(/\s+/);
  const board = new Array(64).fill(null);
  const rows = placement.split('/');
  for (let i = 0; i < 8; i++) {
    const rank = 7 - i; // row 0 of the FEN is rank 8
    let file = 0;
    for (const ch of rows[i]) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      board[rank * 8 + file] = { type: ch.toLowerCase(), color: ch === ch.toLowerCase() ? 'b' : 'w' };
      file++;
    }
  }
  return {
    board, turn: turn || 'w',
    castling: { K: (castling || '').includes('K'), Q: (castling || '').includes('Q'), k: (castling || '').includes('k'), q: (castling || '').includes('q') },
    ep: ep && ep !== '-' ? ep : null,
    halfmove: Number(halfmove || 0), fullmove: Number(fullmove || 1),
  };
}

export function toFen(state) {
  const rows = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '', empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = state.board[rank * 8 + file];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p.color === 'w' ? p.type.toUpperCase() : p.type;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const c = `${state.castling.K ? 'K' : ''}${state.castling.Q ? 'Q' : ''}${state.castling.k ? 'k' : ''}${state.castling.q ? 'q' : ''}` || '-';
  return `${rows.join('/')} ${state.turn} ${c} ${state.ep || '-'} ${state.halfmove} ${state.fullmove}`;
}

const KNIGHT_OFFS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_OFFS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function slide(board, idx, dirs, color) {
  const out = [];
  const f0 = fileOf(idx), r0 = rankOf(idx);
  for (const [df, dr] of dirs) {
    let f = f0 + df, r = r0 + dr;
    while (inBounds(f, r)) {
      const t = r * 8 + f;
      const occ = board[t];
      if (!occ) { out.push({ to: t, capture: false }); f += df; r += dr; continue; }
      if (occ.color !== color) out.push({ to: t, capture: true });
      break;
    }
  }
  return out;
}

// Squares `color` attacks right now — used both for "is the king in check"
// and for "would the king pass through/land on an attacked square" (castling).
function attacksSquare(state, targetIdx, byColor) {
  const { board } = state;
  const tf = fileOf(targetIdx), tr = rankOf(targetIdx);
  // Pawns: the attacker sits one rank behind (from its own advancing direction).
  const pawnDir = byColor === 'w' ? -1 : 1;
  for (const df of [-1, 1]) {
    const f = tf + df, r = tr + pawnDir;
    if (inBounds(f, r)) { const p = board[r * 8 + f]; if (p && p.color === byColor && p.type === 'p') return true; }
  }
  for (const [df, dr] of KNIGHT_OFFS) { const f = tf + df, r = tr + dr; if (inBounds(f, r)) { const p = board[r * 8 + f]; if (p && p.color === byColor && p.type === 'n') return true; } }
  for (const [df, dr] of KING_OFFS) { const f = tf + df, r = tr + dr; if (inBounds(f, r)) { const p = board[r * 8 + f]; if (p && p.color === byColor && p.type === 'k') return true; } }
  for (const [df, dr] of BISHOP_DIRS) {
    let f = tf + df, r = tr + dr;
    while (inBounds(f, r)) { const p = board[r * 8 + f]; if (p) { if (p.color === byColor && (p.type === 'b' || p.type === 'q')) return true; break; } f += df; r += dr; }
  }
  for (const [df, dr] of ROOK_DIRS) {
    let f = tf + df, r = tr + dr;
    while (inBounds(f, r)) { const p = board[r * 8 + f]; if (p) { if (p.color === byColor && (p.type === 'r' || p.type === 'q')) return true; break; } f += df; r += dr; }
  }
  return false;
}

function kingSquare(board, color) {
  for (let i = 0; i < 64; i++) if (board[i]?.type === 'k' && board[i].color === color) return i;
  return -1;
}
export function isInCheck(state, color = state.turn) {
  const ks = kingSquare(state.board, color);
  return ks >= 0 && attacksSquare(state, ks, color === 'w' ? 'b' : 'w');
}

// Pseudo-legal moves for the side to move: obeys piece movement and blocking,
// but does not yet exclude moves that leave the mover's own king in check
// (pseudoMoves + a legality filter below = legalMoves).
function pseudoMoves(state) {
  const { board, turn, ep, castling } = state;
  const moves = [];
  const push = (from, to, extra = {}) => moves.push({ from, to, ...extra });
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.color !== turn) continue;
    const f = fileOf(i), r = rankOf(i);
    if (p.type === 'n') for (const [df, dr] of KNIGHT_OFFS) { const nf = f + df, nr = r + dr; if (inBounds(nf, nr)) { const t = nr * 8 + nf; if (!board[t] || board[t].color !== turn) push(i, t, board[t] ? { capture: true } : {}); } }
    else if (p.type === 'k') {
      for (const [df, dr] of KING_OFFS) { const nf = f + df, nr = r + dr; if (inBounds(nf, nr)) { const t = nr * 8 + nf; if (!board[t] || board[t].color !== turn) push(i, t, board[t] ? { capture: true } : {}); } }
      // Castling: rights, empty between, king not currently/through/landing in check.
      const home = turn === 'w' ? 0 : 56;
      if (i === home + 4) {
        const oppo = turn === 'w' ? 'b' : 'w';
        const kRight = turn === 'w' ? castling.K : castling.k;
        const qRight = turn === 'w' ? castling.Q : castling.q;
        if (kRight && !board[home + 5] && !board[home + 6] && board[home + 7]?.type === 'r'
          && !attacksSquare(state, home + 4, oppo) && !attacksSquare(state, home + 5, oppo) && !attacksSquare(state, home + 6, oppo))
          push(i, home + 6, { castle: 'k' });
        if (qRight && !board[home + 3] && !board[home + 2] && !board[home + 1] && board[home]?.type === 'r'
          && !attacksSquare(state, home + 4, oppo) && !attacksSquare(state, home + 3, oppo) && !attacksSquare(state, home + 2, oppo))
          push(i, home + 2, { castle: 'q' });
      }
    } else if (p.type === 'b') for (const s of slide(board, i, BISHOP_DIRS, turn)) push(i, s.to, s.capture ? { capture: true } : {});
    else if (p.type === 'r') for (const s of slide(board, i, ROOK_DIRS, turn)) push(i, s.to, s.capture ? { capture: true } : {});
    else if (p.type === 'q') for (const s of slide(board, i, [...BISHOP_DIRS, ...ROOK_DIRS], turn)) push(i, s.to, s.capture ? { capture: true } : {});
    else if (p.type === 'p') {
      const dir = turn === 'w' ? 1 : -1;
      const startRank = turn === 'w' ? 1 : 6;
      const lastRank = turn === 'w' ? 7 : 0;
      const oneR = r + dir;
      if (inBounds(f, oneR) && !board[oneR * 8 + f]) {
        const t = oneR * 8 + f;
        if (oneR === lastRank) for (const promo of ['q', 'r', 'b', 'n']) push(i, t, { promotion: promo });
        else push(i, t);
        const twoR = r + 2 * dir;
        if (r === startRank && !board[twoR * 8 + f]) push(i, twoR * 8 + f, { double: true });
      }
      for (const df of [-1, 1]) {
        const nf = f + df, nr = r + dir;
        if (!inBounds(nf, nr)) continue;
        const t = nr * 8 + nf;
        if (board[t] && board[t].color !== turn) {
          if (nr === lastRank) for (const promo of ['q', 'r', 'b', 'n']) push(i, t, { capture: true, promotion: promo });
          else push(i, t, { capture: true });
        } else if (ep && t === sqToIndex(ep)) push(i, t, { capture: true, enPassant: true });
      }
    }
  }
  return moves;
}

function applyPseudo(state, mv) {
  const board = state.board.slice();
  const piece = board[mv.from];
  const castling = { ...state.castling };
  let ep = null;
  if (mv.enPassant) board[mv.to + (piece.color === 'w' ? -8 : 8)] = null;
  board[mv.to] = mv.promotion ? { type: mv.promotion, color: piece.color } : piece;
  board[mv.from] = null;
  if (mv.castle) {
    const home = piece.color === 'w' ? 0 : 56;
    if (mv.castle === 'k') { board[home + 5] = board[home + 7]; board[home + 7] = null; }
    else { board[home + 3] = board[home]; board[home] = null; }
  }
  if (piece.type === 'k') { if (piece.color === 'w') { castling.K = false; castling.Q = false; } else { castling.k = false; castling.q = false; } }
  if (piece.type === 'r') {
    if (mv.from === 0) castling.Q = false; if (mv.from === 7) castling.K = false;
    if (mv.from === 56) castling.q = false; if (mv.from === 63) castling.k = false;
  }
  if (mv.to === 0) castling.Q = false; if (mv.to === 7) castling.K = false;
  if (mv.to === 56) castling.q = false; if (mv.to === 63) castling.k = false;
  if (piece.type === 'p' && mv.double) ep = indexToSq((mv.from + mv.to) / 2);
  const turn = piece.color === 'w' ? 'b' : 'w';
  const halfmove = piece.type === 'p' || mv.capture ? 0 : state.halfmove + 1;
  const fullmove = piece.color === 'b' ? state.fullmove + 1 : state.fullmove;
  return { board, turn, castling, ep, halfmove, fullmove };
}

export function legalMoves(state) {
  const s = typeof state === 'string' ? parseFen(state) : state;
  return pseudoMoves(s).filter((mv) => !isInCheck(applyPseudo(s, mv), s.turn));
}

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function notationFor(state, mv, after) {
  const piece = state.board[mv.from];
  const letter = piece.type === 'p' ? '' : piece.type.toUpperCase();
  let s = mv.castle === 'k' ? 'O-O' : mv.castle === 'q' ? 'O-O-O'
    : `${letter}${indexToSq(mv.from)}${mv.capture ? 'x' : '-'}${indexToSq(mv.to)}${mv.promotion ? `=${mv.promotion.toUpperCase()}` : ''}`;
  if (isInCheck(after, after.turn)) s += legalMoves(after).length ? '+' : '#';
  return s;
}

// Finds the (from,to,promotion) among legal moves, applies it, and reports
// the resulting FEN plus enough about the outcome for a block/check to act on.
export function makeMove(fen, { from, to, promotion }) {
  const state = parseFen(fen);
  const fromIdx = typeof from === 'string' ? sqToIndex(from) : from;
  const toIdx = typeof to === 'string' ? sqToIndex(to) : to;
  const candidates = legalMoves(state).filter((m) => m.from === fromIdx && m.to === toIdx && (!m.promotion || m.promotion === (promotion || 'q')));
  const mv = candidates[0];
  if (!mv) throw new Error(`illegal move ${indexToSq(fromIdx)}-${indexToSq(toIdx)}`);
  const after = applyPseudo(state, mv);
  const notation = notationFor(state, mv, after);
  const inCheck = isInCheck(after, after.turn);
  const movesLeft = legalMoves(after).length;
  return {
    fen: toFen(after), notation, capture: !!mv.capture,
    isCheck: inCheck, isCheckmate: inCheck && movesLeft === 0, isStalemate: !inCheck && movesLeft === 0,
  };
}

export function pieceValueOf(fen, sq) {
  const state = parseFen(fen);
  const p = state.board[typeof sq === 'string' ? sqToIndex(sq) : sq];
  return p ? PIECE_VALUE[p.type] : 0;
}

// A tiny seeded PRNG (see apps/game2048/plugins/game2048.mjs for the same
// pattern) so an AI reply is reproducible from (gameId, plyIndex) alone —
// checks.mjs can import this and predict the exact move the "easy" AI plays.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function pickAiMove(fen, difficulty, seed, ply) {
  const moves = legalMoves(fen);
  if (!moves.length) return null;
  const rnd = mulberry32((Number(seed) * 2654435761 + Number(ply)) >>> 0)();
  if (difficulty === 'hard') {
    const withValue = moves.map((m) => ({ m, v: m.capture ? Math.max(pieceValueOf(fen, m.to), 1) : 0 }));
    const best = Math.max(...withValue.map((x) => x.v));
    if (best > 0) { const top = withValue.filter((x) => x.v === best).map((x) => x.m); return top[Math.floor(rnd * top.length)]; }
  }
  return moves[Math.floor(rnd * moves.length)];
}
