// `/schedule`: named timers the server runs on an interval — steps like an
// action with no row (see runtime/server.mjs, runtime/routes/schedule.mjs).
// "every" is validated against the same rule server.mjs uses to compute the
// timer interval (runtime/schedule.mjs, a leaf both sides import).
import { validEvery } from '../schedule.mjs';

export const NODES = ['schedule'];

export function check(graph, h) {
  const { err, checkSteps } = h;
  const names = new Set();
  (graph.schedule || []).forEach((s, i) => {
    const p = `/schedule/${i}`;
    if (!s.name) err(`${p}/name`, 'schedule needs a name (it becomes /schedule/<name>/run)');
    else if (names.has(s.name)) err(`${p}/name`, `schedule "${s.name}" is declared twice`);
    names.add(s.name);
    if (!validEvery(s.every)) err(`${p}/every`, `"every" must be <n>s|m|h|d`, 'e.g. "5m", "1h", "30s"');
    if (!Array.isArray(s.do) || !s.do.length) err(`${p}/do`, 'schedule needs at least one step');
    checkSteps(s.do, `${p}/do`, null);
  });
}
