// Browser side of the tic-tac-toe reference widget, served at /widget/ttt.mjs.
// Deliberately outside apps/tictactoe/plugins/ (see ./plugins/ttt.mjs) so
// nothing under Node ever imports this file: it runs only in a real browser,
// against the real DOM and a real page origin.
import { api, mountWidgets } from '/widget/_api.mjs';

const MARK = { x: 'X', o: 'O', _: '' };
const OUTCOME = { playing: '', x_won: 'X wins', o_won: 'O wins', draw: 'Draw' };

function render(el, row) {
  const cells = row.board.split('').map((c, i) => {
    const open = c === '_' && row.status === 'playing';
    return `<button type="button" data-cell="${i}" ${open ? '' : 'disabled'} style="width:48px;height:48px;font-size:22px;line-height:1;">${MARK[c]}</button>`;
  }).join('');
  el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(3,48px);gap:4px;">${cells}</div>
    <p>${row.status === 'playing' ? `Turn: ${row.turn.toUpperCase()}` : OUTCOME[row.status]}</p>`;
  for (const btn of el.querySelectorAll('button[data-cell]')) {
    btn.addEventListener('click', async () => {
      const res = await api.post(`/Game/${row.id}/action/move`, { cell: btn.dataset.cell });
      if (res.ok) render(el, res.row);
      else el.querySelector('p').textContent = res.errors?.[0] || 'Illegal move';
    });
  }
}

export default function mount(el, { row }) {
  render(el, row);
}
mountWidgets('ttt', mount);
