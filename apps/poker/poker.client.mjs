// Browser side of the poker table widget, served at /widget/poker.mjs.
// Presentation and input only: fetches the room's seats and current hand
// (neither travels in data-row, which is only the Room's own fields — see
// docs/FORMAT.md's widget contract) and posts an action name. The server is
// the sole authority on whose turn it is and what is legal; a click here is
// just a request, shown as an error if refused.
//
// Hole cards are shown openly for every seat, not only the viewer's own —
// see NOTES.md "Misses": the format has no per-field/per-viewer redaction,
// so pretending a card is hidden while it is still sitting in the same JSON
// response anyone can fetch would be exactly the kind of fake privacy the
// brief warns against.
import { api, mountWidgets } from '/widget/_api.mjs';

function cardEl(c) {
  if (!c) return '';
  const red = c[1] === 'h' || c[1] === 'd';
  return `<span style="display:inline-block;min-width:28px;padding:2px 4px;margin:2px;border:1px solid #999;
    border-radius:4px;background:#fff;color:${red ? '#c00' : '#000'};font-weight:bold;">${c[0]}${{ s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]]}</span>`;
}

export default function mount(el, { row }) {
  async function load() {
    const seats = (await api.get(`/Seat?room=${row.id}`)).rows.sort((a, b) => a.position - b.position);
    const hand = row.currentHand ? await api.get(`/Hand/${row.currentHand}`) : null;
    render(seats, hand && hand.stage ? hand : null);
  }

  function render(seats, hand) {
    const community = hand && hand.community ? hand.community.split(',') : [];
    const seatRows = seats.map((s) => {
      const cards = s.holeCards ? s.holeCards.split(',').map(cardEl).join('') : '';
      const turn = hand && !s.folded && seats[hand.toActPos]?.id === s.id;
      return `<div data-seat="${s.position}" style="padding:4px 8px;margin:2px 0;border-radius:6px;${turn ? 'outline:2px solid midnightblue;' : ''}">
        <b>${s.label}</b>${s.isBot ? ' (bot)' : ''} — ${s.chips} chips${s.folded ? ' <i>(folded)</i>' : ''}
        ${s.committed ? ` <span data-committed>bet ${s.committed}</span>` : ''} ${cards}</div>`;
    }).join('');
    const banner = !hand
      ? '<p>No hand in progress.</p>'
      : `<p data-stage>Stage: ${hand.stage}${hand.stage === 'done' ? ` — ${hand.winnerLabel} wins with ${hand.winningHandName}` : ''}</p>
         <p data-pot>Pot: ${hand.pot}</p><p>Community: ${community.map(cardEl).join('') || '(none yet)'}</p>`;
    const canAct = hand && hand.stage !== 'done';
    const buttons = ['fold', 'check', 'call', 'bet'].map((a) =>
      `<button type="button" data-action="${a}" ${canAct ? '' : 'disabled'}>${a}</button>`).join(' ');
    el.innerHTML = `<div data-seats>${seatRows}</div>${banner}<p data-error class="error"></p><p>${buttons}</p>`;
    for (const btn of el.querySelectorAll('[data-action]')) btn.addEventListener('click', () => act(btn.dataset.action));
  }

  async function act(action) {
    const res = await api.post(`/Room/${row.id}/action/act`, { action });
    if (!res.ok) { const e = el.querySelector('[data-error]'); if (e) e.textContent = res.errors?.[0] || 'Action refused'; return; }
    await load();
  }

  load();
}
mountWidgets('poker', mount);
