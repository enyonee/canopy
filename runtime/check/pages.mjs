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
    if (!s || typeof s !== 'object' || Array.isArray(s)) { err(sp, 'a section must be an object', '{"list": "<saved list id>"} | {"form": "Entity"} | {"text": "…"}'); return; }
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

// The renderer maps `body`, `links`, `actions` and `sections` and escapes the text
// fields, so a wrong type there is a 500 at /page/<id>: refuse it here, by page name.
function checkShape(p, i, err) {
  const at = (k) => `/pages/${i}/${k}`;
  const name = p.id || p.title || `#${i}`;
  for (const k of ['body', 'links', 'actions', 'sections'])
    if (p[k] !== undefined && !Array.isArray(p[k])) err(at(k), `page "${name}": ${k} must be an array`, k === 'body' ? '"body": ["paragraph", …], one string per paragraph' : undefined);
  for (const k of ['id', 'title', 'heading'])
    if (p[k] !== undefined && typeof p[k] !== 'string') err(at(k), `page "${name}": ${k} must be a string`);
  (Array.isArray(p.body) ? p.body : []).forEach((t, j) => {
    if (typeof t !== 'string') err(`${at('body')}/${j}`, `page "${name}": body[${j}] must be a string (one paragraph)`);
  });
  (Array.isArray(p.links) ? p.links : []).forEach((l, j) => {
    for (const k of ['label', 'href'])
      if (typeof l?.[k] !== 'string') err(`${at('links')}/${j}/${k}`, `page "${name}": links[${j}] needs a string "${k}"`, '{"label": "Shop", "href": "/Product"}');
  });
}

export function check(graph, h) {
  const { err, checkRoles, actionNames } = h;
  if (graph.pages !== undefined && !Array.isArray(graph.pages)) { err('/pages', 'pages must be an array of page objects'); return; }
  (graph.pages || []).forEach((p, i) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { err(`/pages/${i}`, 'a page must be an object', '{"id": "about", "title": "About", "body": ["…"]}'); return; }
    checkShape(p, i, err);
    if (!p.id) err(`/pages/${i}/id`, 'page needs an id (it becomes /page/<id>)');
    if (!p.title) err(`/pages/${i}/title`, 'page needs a title (it is the menu label)');
    checkRoles(p, `/pages/${i}`);
    (Array.isArray(p.actions) ? p.actions : []).forEach((a, j) => {
      const act = (graph.actions || []).find((x) => x.name === a);
      if (!act) err(`/pages/${i}/actions/${j}`, `unknown action "${a}"`, `declared: ${actionNames.join(', ') || '(none)'}`);
      else if (act.in) err(`/pages/${i}/actions/${j}`, `action "${a}" is bound to ${act.in}`, 'page buttons need a global action (no "in")');
    });
    if (p.widget) checkWidget(h, p.widget, `/pages/${i}/widget`, null);
    if (p.refresh !== undefined && !(Number.isInteger(p.refresh) && p.refresh > 0))
      err(`/pages/${i}/refresh`, 'refresh must be a positive integer number of seconds');
    if (p.sections === undefined || Array.isArray(p.sections)) checkSections(graph, p, i, h);
  });
}
