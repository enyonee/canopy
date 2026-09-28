// POST /schedule/<name>/run — runs a declared timer immediately: the same
// interpreter as a global action (no row, no submitted values), inside one
// transaction, effects through the outbox. Gated the same way /outbox already
// is (`vc.outbox`: an operator, or anyone when the app has no roles at all),
// so checks can trigger a schedule deterministically instead of waiting on
// the clock.
import { errorPage } from '../render.mjs';

export async function handle(ctx) {
  const { graph, parts, req, ok, vc, interp, trace, user } = ctx;
  if (parts[0] !== 'schedule' || req.method !== 'POST' || parts[2] !== 'run') return undefined;
  const sched = (graph.schedule || []).find((s) => s.name === parts[1]);
  if (!sched) { ctx.answer(404, errorPage(graph, `no schedule "${parts[1]}"`), { ok: false, status: 404, errors: [`no schedule "${parts[1]}"`] }); return true; }
  if (!vc.outbox) { ctx.deny('Only an operator may run a schedule by hand.'); return true; }
  trace({ kind: 'schedule', name: sched.name, manual: true });
  await interp.attempt(() => interp.runSteps(sched.do, { rowEntity: null, id: null, values: {}, user }));
  const flash = `Ran "${sched.name}"`;
  if (ctx.wantsJSON) { ctx.sendJson(200, { ok: true, flash }); return true; }
  ok('/', flash);
  return true;
}
