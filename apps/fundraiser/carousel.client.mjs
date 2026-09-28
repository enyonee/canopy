// Browser side of the offers carousel, served at /widget/carousel.mjs. A page
// widget (no row): it fetches the current Offer rows itself and rotates the
// visible slide on a timer, purely presentational — nothing here writes
// storage. The check for this widget asserts, in a real browser, that the
// visible slide's content actually changes between two points in time.
import { api, mountWidgets } from '/widget/_api.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INTERVAL_MS = 1800;

export default function mount(el, { api: a }) {
  let offers = [];
  let idx = 0;
  let timer = null;

  function render() {
    if (!offers.length) { el.innerHTML = '<p>No offers right now — check back soon.</p>'; return; }
    const o = offers[idx];
    el.innerHTML = `
      <div class="carousel" data-slide-index="${idx}" style="border:1px solid #d8b98a;padding:12px 16px;border-radius:8px;max-width:520px">
        <h3 data-slide-title style="margin:0 0 4px">${esc(o.title)}</h3>
        <p data-slide-discount style="font-weight:bold;margin:0 0 6px">${esc(o.discount)}</p>
        <p data-slide-desc style="margin:0">${esc(o.description)}</p>
        <div class="dots" style="margin-top:8px">${offers.map((_, i) =>
          `<span data-dot="${i}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:${i === idx ? '#cd853f' : '#ddd'}"></span>`).join('')}</div>
      </div>`;
  }

  function advance() {
    if (!offers.length) return;
    idx = (idx + 1) % offers.length;
    render();
  }

  async function load() {
    const res = await a.get('/Offer');
    offers = res.rows || [];
    render();
    if (offers.length > 1 && !timer) timer = setInterval(advance, INTERVAL_MS);
  }

  load();
}
mountWidgets('carousel', mount);
