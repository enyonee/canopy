// `/pages`: static pages at /page/<id>, optionally with global-action buttons,
// a widget, an auto-refresh, or live `sections` (item 6).
import { checkWidget } from './util.mjs';

const SECTION_KEYS = ['list', 'form', 'text'];

export const NODES = ['pages'];

// A section embeds one of: a saved list (read with the viewer's own permissions),
// an entity's create form (posting to the normal route), or plain text.
function checkSections(graph, p, i, h) {
  const { err, checkEntity } = h;
  (p.sections || []).forEach((s, j) => {
    const sp = `/pages/${i}/sections/${j}`;
    const present = SECTION_KEYS.filter((k) => s[k] !== undefined);
    if (present.length !== 1) {
      err(sp, present.length ? `a section needs exactly one of ${SECTION_KEYS.join(', ')}, got ${present.join(', ')}` : `a section needs one of ${SECTION_KEYS.join(', ')}`,
        '{"list": "<saved list id>", "limit"?: 5} | {"form": "Entity"} | {"text": "…"}');
      return;
    }
    if (s.list !== undefined) {
      const ids = (graph.lists || []).map((l) => l.id);
      if (!ids.includes(s.list)) err(`${sp}/list`, `unknown list "${s.list}"`, ids.length ? `declared: ${ids.join(', ')}` : 'no /lists declared');
      if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit > 0)) err(`${sp}/limit`, 'limit must be a positive integer');
    } else if (s.form !== undefined) {
      checkEntity(s.form, `${sp}/form`);
    } else if (typeof s.text !== 'string') {
      err(`${sp}/text`, 'text must be a string');
    }
  });
}

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
    checkSections(graph, p, i, h);
  });
}
