// Startup-only bootstrap, run once per serve(): the scaffold's one fake user
// (/identity) and the declared starting rows (/seed). No HTTP knowledge and
// no per-request state — this runs before the interpreter or any route exists.
import fs from 'node:fs';
import path from 'node:path';

export async function bootstrapIdentity(graph, store) {
  // Identity: one declared row stands for the current user. No login in the scaffold.
  // Created before seed data: a seed row (e.g. a booking for the one fake customer)
  // may reference it.
  if (!graph.identity) return null;
  const rows = await store.list(graph.identity.entity, {});
  return rows.length ? rows[rows.length - 1].id : await store.insert(graph.identity.entity, graph.identity.defaults || {});
}

// A seeded file/image field may be `{ "from": "seed/photo.jpg" }` (item 11): a path
// relative to the app directory, copied into filesDir under a fresh name — the same
// naming shape a real multipart upload gets (routes/context.mjs), so /file/Entity/:id/
// <field> serves it exactly the same way either source produced it.
function materializeFiles(entity, row, store, appDir, filesDir, counter) {
  const out = { ...row };
  for (const f of store.fields[entity]) {
    const v = out[f.name];
    if (!f.type.upload || !v || typeof v !== 'object') continue;
    fs.mkdirSync(filesDir, { recursive: true });
    const name = `${Date.now()}-${counter.n++}-${path.basename(v.from)}`;
    fs.copyFileSync(path.join(appDir, v.from), path.join(filesDir, name));
    out[f.name] = name;
  }
  return out;
}

// Seed: declared starting rows, inserted once per entity, only while it is empty.
// Entities seed in reference order (topological over ref: fields) so a row may
// point at a row seeded earlier. A self-reference — or a cycle between two seeded
// entities that no order can resolve — is inserted with that reference blank, then
// patched once every row it could point at exists; a reference the seed truly
// cannot produce still fails with the store's own "there is no X #N".
export async function bootstrapSeed(graph, store, appDir = '.', filesDir = null) {
  const remaining = new Set();
  for (const e of Object.keys(graph.seed || {})) if (!await store.count(e)) remaining.add(e);
  const refFields = (e) => store.fields[e].filter((f) => f.kind === 'ref');
  const counter = { n: 0 };
  // A seed row meets the same rules a block or a form write does (Store#insert/
  // #update's own guard, runtime/store/rules.mjs) — a violation is a boot
  // error, not a silent invariant break, so it is renamed here to name the
  // entity and the row (by position in its /seed array) around the store's
  // own message (the rule's).
  const named = async (entity, i, fn) => { try { return await fn(); } catch (e) { throw new Error(`seed ${entity}[${i}]: ${e.message}`); } };
  const seedOne = async (entity) => {
    const rows = graph.seed[entity].map((row) => materializeFiles(entity, row, store, appDir, filesDir, counter));
    const selfFields = refFields(entity).filter((f) => f.target === entity).map((f) => f.name);
    const ids = [];
    for (const [i, row] of rows.entries()) {
      ids.push(await named(entity, i, async () => {
        if (!selfFields.length) return await store.insert(entity, row);
        const rest = { ...row };
        for (const f of selfFields) delete rest[f];
        return await store.insert(entity, rest);
      }));
    }
    for (const [i, row] of rows.entries()) {
      const patch = Object.fromEntries(selfFields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]]));
      if (Object.keys(patch).length) await named(entity, i, async () => { await store.update(entity, ids[i], patch); });
    }
    console.log(`seed: ${rows.length} row(s) into ${entity}`);
  };
  while (remaining.size) {
    // Ready: every non-self reference either targets an entity already seeded,
    // or an entity outside this seed batch (already there, or the checker's problem).
    const ready = [...remaining].find((e) => refFields(e).every((f) => f.target === e || !remaining.has(f.target)));
    const next = ready || [...remaining][0]; // an unresolved cycle: best effort, in declared order
    await seedOne(next);
    remaining.delete(next);
  }
}
