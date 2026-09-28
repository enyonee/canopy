// Browser side of the recycling game, served at /widget/recyclebin.mjs.
// Dragging is our own mousedown/mousemove/mouseup handling (a floating
// "ghost" emoji follows the pointer, dropped on whichever bin's bounding box
// contains the mouseup point) — the widget never decides correct/incorrect
// itself, it only posts {item, bin} to the current GameSession's "drop"
// action and re-renders from whatever row the server answers with.
import { api, mountWidgets } from '/widget/_api.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BIN_EMOJI = { plastic: '♻️', paper: '📰', glass: '🍾', organic: '🍌' };
const ITEM_EMOJI = {
  'plastic bottle': '🧴', 'yogurt cup': '🥤', newspaper: '📰', 'cardboard box': '📦',
  'glass jar': '🫙', 'broken glass bottle': '🍾', 'banana peel': '🍌', 'apple core': '🍎',
};
const binEmoji = (name) => { const k = name.toLowerCase(); for (const key in BIN_EMOJI) if (k.includes(key)) return BIN_EMOJI[key]; return '🗑️'; };
const itemEmoji = (name) => ITEM_EMOJI[name.toLowerCase()] || '🚮';

export default function mount(el, { row, api: a }) {
  const state = { row, items: [], bins: [], message: '', introDismissed: false };
  const doneIds = () => { try { return JSON.parse(state.row.dropped || '[]'); } catch { return []; } };

  function render() {
    if (!state.introDismissed && state.row.status === 'playing') {
      el.innerHTML = `<div data-intro style="text-align:center;padding:20px;border:3px solid crimson;border-radius:14px;background:white;max-width:380px">
        <h3>How to play</h3>
        <p>Drag each waste item into the bin it belongs in: plastic, paper, glass, or organic. Get it right for points — get it wrong and we'll gently show you the correct bin.</p>
        <p>Sort every item to finish the game. Sort at least 5 correctly to win a badge!</p>
        <button type="button" data-start-sorting>Start Sorting!</button>
      </div>`;
      el.querySelector('[data-start-sorting]').addEventListener('click', () => { state.introDismissed = true; render(); });
      return;
    }
    if (state.row.status === 'finished') {
      el.innerHTML = `<div data-finished style="text-align:center;padding:20px;border:3px dashed crimson;border-radius:14px;background:white;max-width:360px">
        <h3>🎉 Game Over! 🎉</h3>
        <p>Final score: <b data-final-score>${state.row.score}</b> (${state.row.correct}/${state.row.total} correct)</p>
        ${state.row.badge ? `<p data-badge style="font-size:20px">🏅 ${esc(state.row.badge)}</p>` : '<p data-badge-empty>Sort 5 or more correctly next time to earn a badge!</p>'}
        <button type="button" data-play-again>Play Again</button>
      </div>`;
      el.querySelector('[data-play-again]').addEventListener('click', async () => {
        const res = await a.post(`/GameSession/${state.row.id}/go/newGame`, {});
        if (res.ok) { state.row = res.row; render(); }
      });
      return;
    }
    const done = doneIds();
    el.innerHTML = `
      <p data-score>Score: <b>${state.row.score}</b> &middot; Sorted: ${state.row.total} &middot; Correct: ${state.row.correct}</p>
      <p data-message style="min-height:1.4em;font-weight:600;color:#8b0000">${esc(state.message)}</p>
      <div style="display:flex;gap:28px;flex-wrap:wrap">
        <div data-tray style="display:flex;gap:10px;flex-wrap:wrap;max-width:340px">
          ${state.items.filter((it) => !done.includes(it.id)).map((it) => `
            <div data-item="${it.id}" style="cursor:grab;user-select:none;text-align:center;border:2px solid #999;border-radius:10px;padding:8px;background:white;width:76px">
              <div style="font-size:30px">${itemEmoji(it.name)}</div><div style="font-size:11px">${esc(it.name)}</div>
            </div>`).join('')}
        </div>
        <div data-bins style="display:flex;gap:14px">
          ${state.bins.map((b) => `
            <div data-bin="${b.id}" style="width:104px;height:104px;border:3px dashed crimson;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:white">
              <div style="font-size:32px">${binEmoji(b.name)}</div><div style="font-size:12px">${esc(b.name)}</div>
            </div>`).join('')}
        </div>
      </div>`;
    wire();
  }

  function wire() {
    for (const item of el.querySelectorAll('[data-item]')) {
      item.addEventListener('mousedown', (downEv) => startDrag(downEv, Number(item.dataset.item)));
    }
  }

  function startDrag(downEv, itemId) {
    downEv.preventDefault();
    const ghost = document.createElement('div');
    ghost.dataset.ghost = '1';
    ghost.style.cssText = 'position:fixed;pointer-events:none;font-size:30px;z-index:9999;transform:translate(-50%,-50%)';
    ghost.textContent = itemEmoji(state.items.find((i) => i.id === itemId)?.name || '');
    document.body.appendChild(ghost);
    const move = (ev) => { ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`; };
    move(downEv);
    const onMove = (ev) => move(ev);
    const onUp = async (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      ghost.remove();
      const bins = [...el.querySelectorAll('[data-bin]')];
      const hit = bins.find((b) => {
        const r = b.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      });
      if (!hit) return; // dropped outside any bin: no-op, item stays on the tray
      const res = await a.post(`/GameSession/${state.row.id}/action/drop`, { item: itemId, bin: hit.dataset.bin });
      state.message = res.flash || res.errors?.[0] || '';
      if (res.ok) state.row = res.row;
      render();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  async function load() {
    const [items, bins] = await Promise.all([a.get('/WasteItem'), a.get('/Bin')]);
    state.items = items.rows;
    state.bins = bins.rows;
    render();
  }
  load();
}
mountWidgets('recyclebin', mount);
