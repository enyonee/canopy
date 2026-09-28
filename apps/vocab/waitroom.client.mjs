// Browser side of the waiting-room widget, served at /widget/waitroom.mjs.
// Two independent, unrelated pieces on one page: an avatar picker (a real
// write through the core Profile edit route — nothing here fakes
// persistence) and a tiny deterministic game with no score worth a server
// referee, so it stays entirely client-side (see NOTES.md).
import { api, mountWidgets } from '/widget/_api.mjs';

const AVATARS = ['fox', 'owl', 'cat', 'star', 'robot', 'ninja'];
const EMOJI = { fox: '\u{1F98A}', owl: '\u{1F989}', cat: '\u{1F431}', star: '\u{2B50}', robot: '\u{1F916}', ninja: '\u{1F977}' };

export default function mount(el, { api: a }) {
  const state = { profile: null, clicks: 0 };

  function renderGame() {
    return state.clicks < 5
      ? `<p data-progress>Clicks: ${state.clicks}/5</p><button type="button" data-click>Click me!</button>`
      : `<p data-progress>Clicks: 5/5</p><p data-done>You win! Game over.</p>`;
  }

  function render() {
    el.innerHTML = `
      <div data-avatars>
        <p>Choose your avatar:</p>
        ${AVATARS.map((a2) => `<button type="button" data-avatar="${a2}" style="font-size:22px;padding:6px 10px;border:2px solid ${a2 === state.profile.avatar ? '#8b0000' : '#ccc'}">${EMOJI[a2]}</button>`).join(' ')}
        <p data-current>Current avatar: <b>${state.profile.avatar}</b></p>
      </div>
      <hr>
      <div data-game>${renderGame()}</div>`;
    for (const btn of el.querySelectorAll('[data-avatar]')) {
      btn.addEventListener('click', async () => {
        const avatar = btn.dataset.avatar;
        const res = await a.post(`/Profile/${state.profile.id}`, { avatar });
        if (res.ok) { state.profile.avatar = avatar; render(); }
      });
    }
    wireGame();
  }
  function wireGame() {
    const click = el.querySelector('[data-click]');
    if (click) click.addEventListener('click', () => { state.clicks++; el.querySelector('[data-game]').innerHTML = renderGame(); wireGame(); });
  }

  async function load() {
    const rows = (await a.get('/Profile')).rows;
    state.profile = rows[0];
    render();
  }
  load();
}
mountWidgets('waitroom', mount);
