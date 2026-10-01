// Server side of the diagram maker: one real piece of domain logic (the
// layout algorithm — a genuine arrangement formula, not a UI trick) and the
// widget registration. Everything else the widget does (add/move/restyle/
// remove a node or edge, edit a label) goes straight through the core CRUD
// JSON routes every entity already has (POST /Node, POST /Node/:id,
// POST /Node/:id/delete, …) — no bespoke action needed for any of that, so
// there is nothing else to register here.
export default {
  async: true, // its blocks await store.*, resolve and text (docs/FORMAT.md "Plugins")
  blocks: {
    'diagram.layout': {
      summary: 'arrange the current diagram\'s nodes by its stored "layout": horizontal row, vertical column, or a radial circle; "free" leaves stored positions untouched',
      effects: ['db.write'], requires: [],
      run: async ({ store, entity, id }) => {
        const dg = await store.get(entity, id);
        if (!dg || dg.layout === 'free') return {};
        const nodes = await store.list('Node', { where: { diagram: dg.id }, sort: { field: 'id', dir: 'asc' } });
        const n = nodes.length;
        for (const [i, node] of nodes.entries()) {
          let x, y;
          if (dg.layout === 'horizontal') { x = 120 + i * 160; y = 200; }
          else if (dg.layout === 'vertical') { x = 300; y = 100 + i * 120; }
          else { const angle = n ? (2 * Math.PI * i) / n : 0; x = 400 + Math.round(200 * Math.cos(angle)); y = 260 + Math.round(200 * Math.sin(angle)); }
          await store.update('Node', node.id, { x: Math.round(x), y: Math.round(y) });
        }
        return { arranged: n };
      },
    },
  },
  widgets: {
    diagramcanvas: {
      summary: 'an SVG drag-and-drop canvas for one diagram: a shape palette (varies by diagram type), drag to add or move a node, click to edit its label or restyle it, a delete control per node, and a client-side SVG export',
      client: './canvas.client.mjs',
    },
  },
};
