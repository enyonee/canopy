// Small standalone pages: a static /page/<id>, the login and register forms,
// and the outbox listing.
import { esc, label, plural, anyone, page, cell, enctype, widgetBlock } from '../render.mjs';
import { formFields } from './form.mjs';

// One live section (item 6): an embedded saved list (read with the viewer's own
// permissions, same as /list/<id>), an entity's create form (posting to the
// normal /Entity route, same as Entity.form), or plain text. `store`/`resolveTop`
// are only ever used here, so staticPage's other, far more common callers (every
// existing test, and a page with no sections) need neither.
function sectionHtml(graph, store, vc, resolveTop, s) {
  if (s.text !== undefined) return `<div class="card"><p>${esc(s.text)}</p></div>`;
  if (s.form !== undefined) {
    if (!vc.can(s.form, 'create')) return '';
    const entityFields = store.fields[s.form];
    const ov = graph.override?.[`${s.form}.form`] || {};
    return `<form class="card" method="post" action="/${s.form}"${enctype(entityFields)}>
      ${formFields(store, s.form, entityFields, {}, ov.fields, { skip: Object.keys(ov.fill || {}) })}
      <p><button type="submit">${esc(ov.submit || `Add ${label(s.form)}`)}</button></p></form>`;
  }
  const l = (graph.lists || []).find((x) => x.id === s.list);
  if (!l || !vc.canSee(l) || !vc.can(l.entity, 'view')) return '';
  const where = { ...resolveTop(l.where || {}), ...vc.ownWhere(l.entity) };
  let rows = store.list(l.entity, { where, sort: l.sort, search: l.search || [] });
  if (s.limit) rows = rows.slice(0, s.limit);
  const listFields = store.fields[l.entity];
  const cols = l.columns || listFields.filter((f) => !f.type.secret).map((f) => f.name);
  const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => cell(store, l.entity, listFields, r, c, l.labels || {})).join('')}</tr>`).join('');
  return `<h3>${esc(l.title || plural(label(l.entity)))}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function staticPage(graph, p, flash, vc = anyone, store = null, resolveTop = (x) => x) {
  const body = (p.body || []).map((t) => `<p>${esc(t)}</p>`).join('');
  const links = (p.links || []).map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join(' ');
  const buttons = (p.actions || []).map((a) => {
    const act = (graph.actions || []).find((x) => x.name === a);
    return `<form class="inline" method="post" action="/action/${esc(a)}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
  }).join(' ');
  const sections = (p.sections || []).map((s) => sectionHtml(graph, store, vc, resolveTop, s)).join('');
  return page(graph, { title: p.title, flash, vc, refresh: p.refresh,
    body: `<h2>${esc(p.heading || p.title)}</h2><div class="card">${body}${buttons ? `<p>${buttons}</p>` : ''}</div>
      ${p.widget ? widgetBlock(p.widget) : ''}${sections}<p>${links}</p>` });
}

export function loginView(graph, { error = '', next = '', login = '' } = {}, vc = anyone) {
  const problems = error ? `<div class="card"><p class="error">${esc(error)}</p></div>` : '';
  return page(graph, { title: 'Login', vc,
    body: `<h2>Login</h2>${problems}<form class="card" method="post" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <label for="login">${esc(label(graph.roles.login))}</label><input type="text" id="login" name="login" value="${esc(login)}" required>
      <label for="password">Password</label><input type="password" id="password" name="password" required>
      <p><button type="submit">Login</button>${graph.roles.register ? ` <a class="btn" href="/register">Register</a>` : ''}</p></form>` });
}

export function registerView(graph, store, fields, submitted = {}, errors = [], vc = anyone) {
  const problems = errors.length
    ? `<div class="card"><p class="error">Please fix the following before submitting:</p><ul>${errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>` : '';
  const skip = [graph.roles.role];
  return page(graph, { title: 'Register', vc,
    body: `<h2>Register</h2>${problems}<form class="card" method="post" action="/register"${enctype(fields)}>
      ${formFields(store, graph.roles.entity, fields, submitted, null, { skip })}
      <p><button type="submit">Register</button> <a class="btn" href="/login">Login</a></p></form>` });
}

export function outboxView(graph, rows, flash, vc = anyone) {
  const body = rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.kind)}</td><td>${esc(r.connector)}</td><td>${esc(r.target)}</td>
    <td><span class="status">${esc(r.status)}</span>${r.code ? ` ${r.code}` : ''}${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}</td>
    <td><pre class="muted">${esc(JSON.stringify(r.payload, null, 1))}</pre></td><td>${esc(r.updatedAt)}</td>
    <td>${r.status === 'failed' ? `<form class="inline" method="post" action="/outbox/${r.id}/retry"><button type="submit">Retry</button></form>` : ''}</td></tr>`).join('');
  return page(graph, { title: 'Outbox', flash, vc,
    body: `<h2>Outbox</h2><p class="muted">Everything the application sent out, with its delivery status.</p>
      <table><thead><tr><th>#</th><th>Kind</th><th>Connector</th><th>Target</th><th>Status</th><th>Payload</th><th>Updated</th><th></th></tr></thead>
      <tbody>${body}</tbody></table><p class="muted">${rows.length} item(s)</p>` });
}
