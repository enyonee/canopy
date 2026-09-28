// `/pages`: static pages at /page/<id>, optionally with global-action buttons,
// a widget, or an auto-refresh.
import { checkWidget } from './util.mjs';

export const NODES = ['pages'];

export function check(graph, h) {
  const { err, checkRoles, actionNames } = h;
  (graph.pages || []).forEach((p, i) => {
    if (!p.id) err(`/pages/${i}/id`, 'page needs an id (it becomes /page/<id>)');
    if (!p.title) err(`/pages/${i}/title`, 'page needs a title (it is the menu label)');
    checkRoles(p, `/pages/${i}`);
    (p.actions || []).forEach((a, j) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (!act) err(`/pages/${i}/actions/${j}`, `unknown action "${a}"`, `declared: ${actionNames.join(', ') || '(none)'}`);
      else if (act.in) err(`/pages/${i}/actions/${j}`, `action "${a}" is bound to ${act.in}`, 'page buttons need a global action (no "in")');
    });
    if (p.widget) checkWidget(h, p.widget, `/pages/${i}/widget`, null);
    if (p.refresh !== undefined && !(Number.isInteger(p.refresh) && p.refresh > 0))
      err(`/pages/${i}/refresh`, 'refresh must be a positive integer number of seconds');
  });
}
