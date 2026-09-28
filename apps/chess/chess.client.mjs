// Browser side of the chess widget, served at /widget/chess.mjs. Presentation
// and input only, per docs/FORMAT.md's widget contract: it parses just enough
// of the FEN placement field to draw the board (no legality at all — the
// server, via plugins/chess.mjs + ../engine.mjs, is the sole authority) and
// posts {from,to} intents, re-rendering from each JSON answer. This file is
// served standalone (the server hands back its literal text at that route),
// so it cannot import ../engine.mjs the way plugins/chess.mjs does — an
// import path only resolves for a real file on disk, not over the wire.
import { api, mountWidgets } from '/widget/_api.mjs';

const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const FILES = 'abcdefgh';

function placementToBoard(fen) {
  const placement = fen.split(' ')[0];
  const board = {};
  let rank = 8;
  for (const row of placement.split('/')) {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += Number(ch); continue; }
      const color = ch === ch.toLowerCase() ? 'b' : 'w';
      board[`${FILES[file]}${rank}`] = { type: ch.toLowerCase(), color };
      file++;
    }
    rank--;
  }
  return board;
}

const THEMES = { classic: ['#f0d9b5', '#b58863'], ocean: ['#dbe9f4', '#4f81a3'], forest: ['#e8edd9', '#5a7247'] };

export default function mount(el, { row }) {
  const state = { row, selected: null, error: '' };

  function render() {
    const r = state.row;
    const board = placementToBoard(r.fen);
    const [light, dark] = THEMES[r.theme] || THEMES.classic;
    const turn = r.fen.split(' ')[1] === 'w' ? 'White' : 'Black';
    const squares = [];
    for (let rank = 8; rank >= 1; rank--) {
      for (let f = 0; f < 8; f++) {
        const sq = `${FILES[f]}${rank}`;
        const piece = board[sq];
        const bg = (f + rank) % 2 === 0 ? dark : light;
        const glyph = piece ? GLYPH[piece.type] : '';
        const selected = state.selected === sq;
        squares.push(`<button type="button" data-sq="${sq}" style="width:44px;height:44px;font-size:26px;line-height:1;
          background:${selected ? '#f6f669' : bg};color:${piece?.color === 'w' ? '#fff' : '#000'};
          -webkit-text-stroke:${piece?.color === 'w' ? '0.5px #000' : '0'};border:0;padding:0;">${glyph}</button>`);
      }
    }
    const banner = r.status === 'finished'
      ? `<p>Game over (${r.endReason}). ${r.result === 'draw' ? 'Draw.' : `${r.result === 'white' ? 'White' : 'Black'} wins.`}</p>`
      : r.status === 'waiting' ? '<p>Waiting for a second player to join.</p>' : `<p>${turn} to move.</p>`;
    const diffButtons = ['easy', 'hard'].map((d) => `<button type="button" data-difficulty="${d}" ${r.difficulty === d ? 'disabled' : ''}>${d}</button>`).join(' ');
    const themeButtons = Object.keys(THEMES).map((t) => `<button type="button" data-theme="${t}" ${r.theme === t ? 'disabled' : ''}>${t}</button>`).join(' ');
    el.innerHTML = `<div data-board style="display:grid;grid-template-columns:repeat(8,44px);width:352px;">${squares.join('')}</div>
      ${banner}<p class="error" data-error>${state.error}</p>
      ${r.mode === 'ai' ? `<p>Difficulty: ${diffButtons}</p>` : ''}
      <p>Theme: ${themeButtons}</p>`;
    for (const btn of el.querySelectorAll('[data-sq]')) btn.addEventListener('click', () => onSquare(btn.dataset.sq));
    for (const btn of el.querySelectorAll('[data-difficulty]')) btn.addEventListener('click', () => setOption('setDifficulty', 'difficulty', btn.dataset.difficulty));
    for (const btn of el.querySelectorAll('[data-theme]')) btn.addEventListener('click', () => setOption('setTheme', 'theme', btn.dataset.theme));
  }

  async function onSquare(sq) {
    if (state.row.status !== 'playing') return;
    if (!state.selected) { state.selected = sq; render(); return; }
    const from = state.selected;
    state.selected = null;
    if (from === sq) { render(); return; }
    const res = await api.post(`/Game/${state.row.id}/action/move`, { from, to: sq });
    if (res.ok) { state.row = res.row; state.error = ''; } else { state.error = res.errors?.[0] || 'Illegal move'; }
    render();
  }

  async function setOption(action, field, value) {
    const res = await api.post(`/Game/${state.row.id}/action/${action}`, { [field]: value });
    if (res.ok) state.row = res.row;
    render();
  }

  render();
}
mountWidgets('chess', mount);
