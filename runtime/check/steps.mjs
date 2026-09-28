// Steps are shared by actions, events and state transitions: one step-list
// walker, parameterised by the block catalog and the row entity (if any) the
// steps run against. Built once per validate() call; not a node-kind checker
// itself (no NODES export) — actions.mjs/events.mjs/states.mjs call it.
import { near } from './util.mjs';

export function createStepsChecker(h) {
  const { err, graph, fields, checkEntity, checkField, checkWhere, checkValues, CATALOG } = h;

  /** @param {Record<string, string>} [ctxIn] */
  function checkSteps(steps, path, entity, ctxIn = {}) {
    /** @type {Record<string, string>} */
    const ctxEntities = { ...ctxIn };
    if (entity) ctxEntities.row = entity;
    (steps || []).forEach((step, j) => {
      const p = `${path}/${j}`;
      const block = CATALOG[step.block];
      if (!block) {
        const n = near(step.block || '', Object.keys(CATALOG));
        return err(`${p}/block`, `unknown block "${step.block}"`,
          n.length ? `did you mean: ${n.join(', ')}?` : `catalog: ${Object.keys(CATALOG).join(', ')}`);
      }
      for (const req of block.requires)
        if (step[req] === undefined) err(p, `block "${step.block}" requires "${req}"`, block.summary);
      if (step.entity !== undefined) checkEntity(step.entity, `${p}/entity`);
      if (step.from !== undefined) checkEntity(step.from, `${p}/from`);
      const target = step.entity || entity;
      if (step.field && target) checkField(target, step.field, `${p}/field`, { stored: true });
      if (step.via && step.entity) checkField(step.entity, step.via, `${p}/via`);
      if (step.set && target) Object.keys(step.set).forEach((f) => checkField(target, f, `${p}/set/${f}`, { stored: true }));
      if (step.values && step.entity) Object.keys(step.values).forEach((f) => checkField(step.entity, f, `${p}/values/${f}`, { stored: true }));
      if (step.where && step.entity) checkWhere(step.entity, step.where, `${p}/where`);
      if (step.where && step.block === 'db.each' && step.from) checkWhere(step.from, step.where, `${p}/where`);
      if (step.into && entity) checkField(entity, step.into, `${p}/into`, { stored: true });
      if (block.connector) {
        const c = graph.connectors?.[step.connector];
        if (!c) err(`${p}/connector`, `unknown connector "${step.connector}"`, `declared: ${Object.keys(graph.connectors || {}).join(', ') || '(none; add /connectors)'}`);
        else if (c.kind !== block.connector) err(`${p}/connector`, `connector "${step.connector}" is ${c.kind}, ${step.block} needs ${block.connector}`);
      }
      if (block.check) block.check(step, { err, fields, entity, graph, path: p, checkEntity, checkField });
      for (const key of ['set', 'values', 'where', 'body', 'id', 'by', 'to', 'path'])
        if (step[key] !== undefined) checkValues(step[key], ctxEntities, `${p}/${key}`);
      for (const sub of block.nested ? block.nested(step) : []) checkSteps(sub.steps, `${p}/${sub.path}`, entity, { ...ctxEntities, ...sub.adds });
      if (block.exposes) Object.assign(ctxEntities, block.exposes(step));
    });
  }

  return checkSteps;
}
