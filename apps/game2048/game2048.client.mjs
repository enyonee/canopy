// Browser side of the 2048 widget, served at /widget/game2048.mjs. Renders the
// board from the row JSON the server already sent (data-row) and re-renders
// from each move's JSON answer; posts intents only, same contract as
// apps/tictactoe/ttt.client.mjs. Arrow keys and on-screen buttons both work so
// a real-browser check can drive it either way.
import { api, mountWidgets } from '/widget/_api.mjs';

const KEY_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const DIRS = ['up', 'down', 'left', 'right'];

export default function mount(el, { row }) {
  const state = { row };

  function render() {
    const r = state.row;
    const cells = r.board.split(',').map(Number);
    const tiles = cells.map((v, i) => `<div class="tile" data-cell="${i}" data-value="${v}"
      style="width:56px;height:56px;display:flex;align-items:center;justify-content:center;
      font-weight:bold;font-size:${v >= 1000 ? '16px' : '20px'};background:${v ? '#eee4da' : '#cdc1b4'};
      border-radius:4px;">${v || ''}</div>`).join('');
    const banner = r.status === 'over' ? '<p>Game over.</p>' : r.won ? '<p>You reached 2048! Keep going or start a new game.</p>' : '';
    const dirButtons = DIRS.map((d) => `<button type="button" data-dir="${d}" ${r.status === 'over' ? 'disabled' : ''}>${d}</button>`).join(' ');
    el.innerHTML = `<p>Score: <span data-score>${r.score}</span></p>
      <div style="display:grid;grid-template-columns:repeat(4,56px);gap:4px;" data-board>${tiles}</div>
      <p>${dirButtons}</p>${banner}
      <p class="error" data-error></p>`;
    for (const btn of el.querySelectorAll('button[data-dir]')) btn.addEventListener('click', () => move(btn.dataset.dir));
  }

  async function move(direction) {
    const res = await api.post(`/Game/${state.row.id}/action/move`, { direction });
    if (res.ok) { state.row = res.row; render(); }
    else { const e = el.querySelector('[data-error]'); if (e) e.textContent = res.errors?.[0] || 'Illegal move'; }
  }

  render();
  document.addEventListener('keydown', (ev) => {
    const d = KEY_DIR[ev.key];
    if (d && state.row.status === 'playing') { ev.preventDefault(); move(d); }
  });
}
mountWidgets('game2048', mount);
