// `/seed`: starting rows, inserted once while the table is empty. A seeded
// reference must resolve on a fresh table: either the same entity (a
// self-reference, patched once every row exists — see runtime/boot.mjs) or an
// entity the seed itself produces enough rows for, or the one /identity row.
// Anything else — an entity seed never touches — is a row the seed cannot make.
export const NODES = ['seed'];

export function check(graph, h) {
  const { err, checkEntity, checkField, fields } = h;
  for (const [entity, rows] of Object.entries(graph.seed || {})) {
    if (!checkEntity(entity, `/seed/${entity}`)) continue;
    (rows || []).forEach((row, i) =>
      Object.entries(row).forEach(([f, v]) => {
        const p = `/seed/${entity}/${i}/${f}`;
        if (!checkField(entity, f, p, { stored: true })) return;
        const field = fields[entity][f];
        // A seeded file/image may name a real file to copy in at boot (item 11)
        // instead of a stored filename — the only field kind this shape is legal on.
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (!field.type.upload) err(p, `"${f}" is ${field.kind}; only a file or image field can seed { "from": <path> }`);
          else if (typeof v.from !== 'string' || !v.from) err(`${p}/from`, 'a seeded file needs "from": a path to the file, relative to the app directory');
          return;
        }
        if (field.kind !== 'ref' || v === null || v === undefined || v === '') return;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return; // not id-shaped; the store reports it plainly at boot
        const target = field.target;
        const producible = target === entity || target === graph.identity?.entity || graph.seed[target] !== undefined;
        const produced = target === entity ? rows.length : target === graph.identity?.entity ? 1 : (graph.seed[target] || []).length;
        if (n > produced)
          err(p, `${entity}.${f} seeds a reference to ${target} #${n}, but the seed produces ${producible ? `only ${produced}` : 'no'} ${target} row(s)`,
            producible ? `use an id from 1 to ${produced}` : `add "${target}" to /seed, or point at a row that already exists`);
      }));
  }
}
