// Browser side of the diagram-maker widget, served at /widget/diagramcanvas.mjs.
// An SVG drag-and-drop canvas. Dragging is our own mousedown/mousemove/mouseup
// handling (not the browser's native HTML5 DataTransfer drag-and-drop API —
// see NOTES.md), which is what lets a palette shape be dragged onto the canvas
// and an existing node be dragged to a new spot. Every mutation goes straight
// through the core CRUD JSON routes of Node/Edge (POST /Node, POST /Node/:id,
// POST /Node/:id/delete, …) — the widget never writes storage itself.
import { api, mountWidgets } from '/widget/_api.mjs';

const W = 800, H = 520;
const PALETTES = {
  flowchart: [['rectangle', 'Process'], ['diamond', 'Decision'], ['ellipse', 'Terminal']],
  orgchart: [['rectangle', 'Role box']],
  mindmap: [['ellipse', 'Idea bubble']],
};
const FILLS = ['white', 'honeydew', 'lavender', 'lightyellow', 'mistyrose', 'lightblue'];
const STROKES = ['slategray', 'seagreen', 'goldenrod', 'crimson', 'slateblue', 'navy'];
const DRAG_THRESHOLD = 6; // px of total movement below which a mousedown+mouseup counts as a click, not a drag

function shapeEl(n) {
  if (n.shape === 'rectangle') return `<rect data-node="${n.id}" x="${n.x - 42}" y="${n.y - 22}" width="84" height="44" rx="8" fill="${n.fill}" stroke="${n.stroke}" stroke-width="2"></rect>`;
  if (n.shape === 'diamond') return `<polygon data-node="${n.id}" points="${n.x},${n.y - 30} ${n.x + 54},${n.y} ${n.x},${n.y + 30} ${n.x - 54},${n.y}" fill="${n.fill}" stroke="${n.stroke}" stroke-width="2"></polygon>`;
  return `<ellipse data-node="${n.id}" cx="${n.x}" cy="${n.y}" rx="48" ry="26" fill="${n.fill}" stroke="${n.stroke}" stroke-width="2"></ellipse>`;
}

function svgOf(state) {
  const edges = state.edges.map((e) => {
    const a = state.nodes.find((n) => n.id === e.fromNode), b = state.nodes.find((n) => n.id === e.toNode);
    if (!a || !b) return '';
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#555" stroke-width="2" marker-end="url(#arrow)"></line>${e.label ? `<text x="${mx}" y="${my - 6}" text-anchor="middle" font-size="12">${esc(e.label)}</text>` : ''}`;
  }).join('');
  const nodes = state.nodes.map((n) => `<g data-node-group="${n.id}" ${state.selected === n.id ? 'data-selected="1"' : ''} style="cursor:grab">
    ${shapeEl(n)}<text data-label x="${n.x}" y="${n.y + 5}" text-anchor="middle" font-size="13" pointer-events="none">${esc(n.label)}</text>
  </g>`).join('');
  return `<svg data-canvas viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="border:1px solid #ccc;background:white;touch-action:none">
    <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#555"></path></marker></defs>
    ${edges}${nodes}
  </svg>`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function editorHtml(node) {
  if (!node) return '<p data-editor-empty>Click a shape to edit it, or drag one from the palette onto the canvas.</p>';
  const opt = (list, cur) => list.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v}</option>`)
    .join('') + (list.includes(cur) ? '' : `<option value="${cur}" selected>${cur}</option>`);
  return `<div data-editor>
    <label>Label <input data-field="label" value="${esc(node.label)}"></label>
    <label>Fill <select data-field="fill">${opt(FILLS, node.fill)}</select></label>
    <label>Stroke <select data-field="stroke">${opt(STROKES, node.stroke)}</select></label>
    <button type="button" data-apply>Apply</button>
    <button type="button" data-delete>Delete</button>
  </div>`;
}

export default function mount(el, { row, api: a }) {
  const state = { nodes: [], edges: [], selected: null, diagramId: row.id, type: row.type };

  function render() {
    el.innerHTML = `
      <div class="palette">${(PALETTES[state.type] || PALETTES.flowchart).map(([shape, name]) =>
        `<button type="button" class="palette-shape" data-shape="${shape}">${esc(name)}</button>`).join('')}
        <button type="button" data-export>Export SVG</button>
        <a data-export-link download="diagram.svg" style="margin-left:8px"></a>
      </div>
      <div style="display:flex;gap:16px;align-items:flex-start">
        <div>${svgOf(state)}</div>
        <div data-panel>${editorHtml(state.nodes.find((n) => n.id === state.selected))}</div>
      </div>`;
    wire();
  }

  async function load() {
    const [n, e] = await Promise.all([a.get(`/Node?diagram=${state.diagramId}&pageSize=200`), a.get(`/Edge?diagram=${state.diagramId}&pageSize=200`)]);
    state.nodes = n.rows; state.edges = e.rows;
    render();
  }

  function svgPoint(clientX, clientY) {
    const svg = el.querySelector('[data-canvas]');
    const rect = svg.getBoundingClientRect();
    return { x: Math.round((clientX - rect.left) * (W / rect.width)), y: Math.round((clientY - rect.top) * (H / rect.height)) };
  }

  function wire() {
    for (const btn of el.querySelectorAll('.palette-shape')) {
      btn.addEventListener('mousedown', (ev) => startPaletteDrag(ev, btn.dataset.shape));
    }
    for (const g of el.querySelectorAll('[data-node-group]')) {
      g.addEventListener('mousedown', (ev) => startNodeDrag(ev, Number(g.dataset.nodeGroup)));
    }
    const apply = el.querySelector('[data-apply]');
    if (apply) apply.addEventListener('click', async () => {
      const panel = el.querySelector('[data-editor]');
      const label = panel.querySelector('[data-field="label"]').value;
      const fill = panel.querySelector('[data-field="fill"]').value;
      const stroke = panel.querySelector('[data-field="stroke"]').value;
      const res = await a.post(`/Node/${state.selected}`, { label, fill, stroke });
      if (res.ok) { Object.assign(state.nodes.find((n) => n.id === state.selected), { label, fill, stroke }); render(); }
    });
    const del = el.querySelector('[data-delete]');
    if (del) del.addEventListener('click', async () => {
      const id = state.selected;
      for (const e of state.edges.filter((e) => e.fromNode === id || e.toNode === id)) await a.post(`/Edge/${e.id}/delete`, {});
      await a.post(`/Node/${id}/delete`, {});
      state.selected = null;
      await load();
    });
    const exp = el.querySelector('[data-export]');
    if (exp) exp.addEventListener('click', () => {
      const svg = el.querySelector('[data-canvas]').outerHTML;
      const full = `<?xml version="1.0" encoding="UTF-8"?>${svg}`;
      el.querySelector('[data-export-link]').href = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(full)))}`;
      el.querySelector('[data-export-link]').textContent = 'Download ready';
    });
  }

  function startPaletteDrag(downEv, shape) {
    downEv.preventDefault();
    const start = { x: downEv.clientX, y: downEv.clientY };
    let moved = 0;
    const onMove = (ev) => { moved += Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0); };
    const onUp = async (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const p = svgPoint(ev.clientX, ev.clientY);
      if (p.x < 0 || p.x > W || p.y < 0 || p.y > H) return; // dropped outside the canvas: no-op
      const res = await a.post('/Node', { diagram: state.diagramId, shape, label: 'New', x: p.x, y: p.y });
      if (res.ok) await load();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startNodeDrag(downEv, id) {
    downEv.preventDefault();
    let moved = 0;
    const node = state.nodes.find((n) => n.id === id);
    const onMove = (ev) => {
      moved += Math.abs(ev.movementX || 0) + Math.abs(ev.movementY || 0);
      if (moved > DRAG_THRESHOLD) {
        const p = svgPoint(ev.clientX, ev.clientY);
        node.x = p.x; node.y = p.y;
        render();
      }
    };
    const onUp = async (ev) => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved > DRAG_THRESHOLD) {
        const p = svgPoint(ev.clientX, ev.clientY);
        const res = await a.post(`/Node/${id}`, { x: p.x, y: p.y });
        if (res.ok) { node.x = p.x; node.y = p.y; }
        render();
      } else {
        state.selected = id;
        render();
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  load();
}
mountWidgets('diagramcanvas', mount);
