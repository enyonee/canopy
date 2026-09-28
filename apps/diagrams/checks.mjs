// webgen-bench/000079 — diagram maker: Diagram/Node/Edge rows, an SVG
// drag-and-drop canvas widget (diagramcanvas), and a real layout algorithm
// (plugins/diagram.mjs's diagram.layout block, applied through an on-update
// event whenever a diagram's "layout" preference changes).
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';

const jsonGet = async (base, path) => { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return { status: r.status, body: await r.json() }; };
const jsonPost = async (base, path, body = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString() });
  return { status: r.status, body: await r.json() };
};

export const checks = [
  { task: 'Attempt to create a new diagram using the provided interface',
    run: async ({ base, must }) => {
      const created = await jsonPost(base, '/Diagram', { title: 'Sprint Retro', type: 'flowchart' });
      must(created.status === 200 && created.body.ok, `create returned ${created.status}: ${JSON.stringify(created.body)}`);
      const id = created.body.id;
      const diagram = await jsonGet(base, `/Diagram/${id}`);
      must(diagram.body.title === 'Sprint Retro' && diagram.body.nodeCount === 0, `expected a blank new diagram: ${JSON.stringify(diagram.body)}`);
      const nodes = await jsonGet(base, `/Node?diagram=${id}`);
      must(nodes.body.rows.length === 0, 'a brand-new diagram already has nodes on its canvas');
      return `diagram #${id} created blank (0 nodes)`;
    } },
  { task: 'Access the options to choose a diagram type and select "Flowchart"',
    run: async ({ base, must }) => {
      const created = await jsonPost(base, '/Diagram', { title: 'Type Switch', type: 'mindmap' });
      const id = created.body.id;
      const changed = await jsonPost(base, `/Diagram/${id}`, { type: 'flowchart' });
      must(changed.status === 200 && changed.body.ok, `type change returned ${changed.status}`);
      const b = await openBrowser(`${base}/Diagram/${id}`);
      try {
        await b.until(`document.querySelectorAll('.palette-shape').length === 3`);
        const shapes = await b.eval(`[...document.querySelectorAll('.palette-shape')].map((x) => x.dataset.shape).sort().join(',')`);
        must(shapes === 'diamond,ellipse,rectangle', `flowchart palette missing tools: ${shapes}`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return 'canvas switched to flowchart type; palette shows process/decision/terminal tools';
    } },
  { task: 'Use the drag-and-drop interface to add a new shape to the diagram',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Diagram/1`);
      try {
        await b.until(`document.querySelectorAll('[data-node-group]').length === 4`);
        const before = await b.eval(`document.querySelectorAll('[data-node-group]').length`);
        const btn = await b.eval(`(() => { const r = document.querySelector('.palette-shape[data-shape="diamond"]').getBoundingClientRect(); return r.left + ',' + r.top; })()`);
        const [bx, by] = btn.split(',').map(Number);
        const svgRect = await b.eval(`(() => { const r = document.querySelector('[data-canvas]').getBoundingClientRect(); return r.left + ',' + r.top; })()`);
        const [sx, sy] = svgRect.split(',').map(Number);
        const dropClientX = sx + 400, dropClientY = sy + 260; // roughly the canvas centre in viewport coordinates
        await b.eval(`document.querySelector('.palette-shape[data-shape="diamond"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: ${bx + 5}, clientY: ${by + 5} }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${dropClientX}, clientY: ${dropClientY}, movementX: 40, movementY: 40 }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ${dropClientX}, clientY: ${dropClientY} }))`);
        await b.until(`document.querySelectorAll('[data-node-group]').length === ${4 + 1}`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
        const after = await b.eval(`document.querySelectorAll('[data-node-group]').length`);
        must(after === before + 1, `expected one new shape, had ${before} now ${after}`);
      } finally { await b.close(); }
      const nodes = await jsonGet(base, '/Node?diagram=1');
      const added = nodes.body.rows.find((n) => n.shape === 'diamond' && n.label === 'New');
      must(added, `no new diamond node was persisted: ${JSON.stringify(nodes.body.rows)}`);
      must(Math.abs(added.x - 400) < 60 && Math.abs(added.y - 260) < 60, `the new shape was not created near the drop position: ${JSON.stringify(added)}`);
      return 'a diamond dropped near the canvas centre was added to the canvas and persisted at that position';
    } },
  { task: 'Edit an existing element within a diagram (e.g., change the text in a shape)',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Diagram/1`);
      try {
        await b.until(`document.querySelectorAll('[data-node-group]').length >= 4`);
        await b.eval(`document.querySelector('[data-node-group="1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }))`);
        await b.until(`document.querySelector('[data-field="label"]') && document.querySelector('[data-field="label"]').value === 'Start'`);
        await b.eval(`(() => { const i = document.querySelector('[data-field="label"]'); i.value = 'Kickoff'; })()`);
        await b.eval(`document.querySelector('[data-apply]').click()`);
        await b.until(`document.querySelector('[data-node-group="1"] [data-label]').textContent === 'Kickoff'`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const node = await jsonGet(base, '/Node/1');
      must(node.body.label === 'Kickoff', `the label was not saved: ${JSON.stringify(node.body)}`);
      return 'node #1 relabelled "Start" -> "Kickoff", updated on the canvas immediately and persisted';
    } },
  { task: 'Remove an element from a diagram using the provided interface tools',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Diagram/1`);
      try {
        await b.until(`document.querySelectorAll('[data-node-group]').length >= 4`);
        const before = await b.eval(`document.querySelectorAll('[data-node-group]').length`);
        await b.eval(`document.querySelector('[data-node-group="4"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 620, clientY: 200 }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 620, clientY: 200 }))`);
        await b.until(`document.querySelector('[data-delete]')`);
        await b.eval(`document.querySelector('[data-delete]').click()`);
        await b.until(`document.querySelectorAll('[data-node-group]').length === ${before - 1}`);
      } finally { await b.close(); }
      const gone = await fetch(`${base}/Node/4`, { headers: { accept: 'application/json' } });
      must(gone.status === 404, `node #4 was not deleted server-side: ${gone.status}`);
      const edges = await jsonGet(base, '/Edge?diagram=1');
      must(!edges.body.rows.some((e) => e.fromNode === 4 || e.toNode === 4), 'an edge still references the deleted node');
      return 'node #4 ("Onboarded") removed from the canvas and from storage, its edge removed with it';
    } },
  { task: 'Rearrange elements on the canvas by dragging one element to a new position',
    run: async ({ base, must }) => {
      const before = await jsonGet(base, '/Node/2');
      const b = await openBrowser(`${base}/Diagram/1`);
      try {
        await b.until(`document.querySelector('[data-node-group="2"]')`);
        await b.eval(`document.querySelector('[data-node-group="2"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 260, clientY: 200 }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 260, movementX: 40, movementY: 60 }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 340, clientY: 300 }))`);
        await b.until(`document.querySelector('[data-node-group="2"] [data-label]').getAttribute('x') !== '${before.body.x}'`);
        must(!b.errors.length, `page errors while dragging: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const after = await jsonGet(base, '/Node/2');
      must(after.body.x !== before.body.x || after.body.y !== before.body.y, `the node did not move: before ${JSON.stringify(before.body)} after ${JSON.stringify(after.body)}`);
      return `node #2 dragged from (${before.body.x},${before.body.y}) to (${after.body.x},${after.body.y}), no page errors`;
    } },
  { task: 'Adjust the style of an element (e.g., change the color or border)',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Diagram/1`);
      try {
        await b.until(`document.querySelector('[data-node-group="3"]')`);
        await b.eval(`document.querySelector('[data-node-group="3"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 440, clientY: 200 }))`);
        await b.eval(`document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 440, clientY: 200 }))`);
        await b.until(`document.querySelector('[data-field="stroke"]')`);
        await b.eval(`(() => { document.querySelector('[data-field="fill"]').value = 'mistyrose'; document.querySelector('[data-field="stroke"]').value = 'crimson'; })()`);
        await b.eval(`document.querySelector('[data-apply]').click()`);
        await b.until(`document.querySelector('[data-node-group="3"] polygon').getAttribute('fill') === 'mistyrose'`);
        must(await b.eval(`document.querySelector('[data-node-group="3"] polygon').getAttribute('stroke') === 'crimson'`), 'stroke was not applied');
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const node = await jsonGet(base, '/Node/3');
      must(node.body.fill === 'mistyrose' && node.body.stroke === 'crimson', `style not persisted: ${JSON.stringify(node.body)}`);
      return 'node #3 restyled to a mistyrose fill / crimson stroke, visible on the canvas and persisted';
    } },
  { task: 'Navigate to the settings to change the layout of a diagram',
    run: async ({ base, must }) => {
      const positionsBefore = (await jsonGet(base, '/Node?diagram=2')).body.rows;
      const edited = await jsonPost(base, '/Diagram/2', { layout: 'horizontal' });
      must(edited.status === 200 && edited.body.ok, `changing the layout returned ${edited.status}: ${JSON.stringify(edited.body)}`);
      const after = (await jsonGet(base, '/Node?diagram=2')).body.rows.sort((a, b) => a.id - b.id);
      must(after.every((n) => n.y === 200), `horizontal layout should put every node on one row: ${JSON.stringify(after)}`);
      const xs = after.map((n) => n.x);
      must(xs.every((x, i) => i === 0 || x === xs[i - 1] + 160), `horizontal layout should space nodes evenly: ${xs}`);
      must(JSON.stringify(positionsBefore.map((n) => [n.x, n.y])) !== JSON.stringify(after.map((n) => [n.x, n.y])), 'positions did not actually change');
      return `diagram #2 switched to a horizontal layout; its ${after.length} nodes are now on one row, evenly spaced`;
    } },
  colorCheck('ghostwhite', 'slategray'),
];
