// Small standalone pages: a static /page/<id>, the login and register forms,
// and the outbox listing.
import { esc, label, plural, anyone, noPre, loaded, columnsOf, page, cell, enctype, widgetBlock } from '../render.mjs';
import { formFields } from './form.mjs';

// One live section (item 6): an embedded saved list (read with the viewer's own
// permissions, same as /list/<id>), an entity's create form (posting to the
// normal /Entity route, same as Entity.form), or plain text. What a section reads is
// decided here (sectionList, sectionForm) and loaded by the route (routes/load.mjs) before
// the page renders: the rows of each embedded list sit in `pre.sections`, keyed by section.
export function sectionList(graph, vc, s) {
  if (s.text !== undefined || s.form !== undefined) return null;
  const l = (graph.lists || []).find((x) => x.id === s.list);
  return l && vc.canSee(l) && vc.can(l.entity, 'view') ? l : null;
}
export function sectionForm(graph, store, vc, s) {
  if (s.form === undefined || !vc.can(s.form, 'create')) return null;
  const ov = graph.override?.[`${s.form}.form`] || {};
  return { entity: s.form, fields: store.fields[s.form], ov, only: ov.fields, skip: Object.keys(ov.fill || {}) };
}

function sectionHtml(graph, store, vc, pre, s) {
  if (s.text !== undefined) return `<div class="card"><p>${esc(s.text)}</p></div>`;
  if (s.form !== undefined) {
    const f = sectionForm(graph, store, vc, s);
    if (!f) return '';
    return `<form class="card" method="post" action="/${s.form}"${enctype(f.fields)}>
      ${formFields(store, s.form, f.fields, {}, f.only, { skip: f.skip, pre })}
      <p><button type="submit">${esc(f.ov.submit || `Add ${label(s.form)}`)}</button></p></form>`;
  }
  const l = sectionList(graph, vc, s);
  if (!l) return '';
  const rows = loaded(pre.sections, s, `section ${s.list}`);
  const listFields = store.fields[l.entity];
  const cols = columnsOf(l, listFields);
  const head = cols.map((c) => `<th>${esc(label(c))}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => cell(store, l.entity, listFields, r, c, l.labels || {}, vc, pre)).join('')}</tr>`).join('');
  return `<h3>${esc(l.title || plural(label(l.entity)))}</h3><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function staticPage(graph, p, flash, vc = anyone, store = null, pre = noPre) {
  const body = (p.body || []).map((t) => `<p>${esc(t)}</p>`).join('');
  const links = (p.links || []).map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join(' ');
  const buttons = (p.actions || []).map((a) => {
    const act = (graph.actions || []).find((x) => x.name === a);
    // Item 19: a global action has no entity to type its fields against, so
    // each is just a required plain-text input.
    const inputs = (act?.fields || []).map((f) =>
      `<label for="f_${f}">${esc(label(f))}</label><input type="text" id="f_${f}" name="${f}" required>`).join('');
    return `<form class="${inputs ? 'card' : 'inline'}" method="post" action="/action/${esc(a)}">${inputs}<button type="submit">${esc(act?.title || label(a))}</button></form>`;
  }).join(' ');
  const sections = (p.sections || []).map((s) => sectionHtml(graph, store, vc, pre, s)).join('');
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

export function registerView(graph, store, fields, submitted = {}, errors = [], vc = anyone, pre = noPre) {
  const problems = errors.length
    ? `<div class="card"><p class="error">Please fix the following before submitting:</p><ul>${errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>` : '';
  const skip = [graph.roles.role];
  return page(graph, { title: 'Register', vc,
    body: `<h2>Register</h2>${problems}<form class="card" method="post" action="/register"${enctype(fields)}>
      ${formFields(store, graph.roles.entity, fields, submitted, null, { skip, pre })}
      <p><button type="submit">Register</button> <a class="btn" href="/login">Login</a></p></form>` });
}

const act = (id, what, label) => `<form class="inline" method="post" action="/outbox/${id}/${what}"><button type="submit">${label}</button></form>`;
const when = (ms) => new Date(ms).toISOString();

// The buttons of a delivery: failed and unknown ones can be retried; only an unknown one (the request may have
// landed) can be marked as sent.
const actions = (r) => (r.status === 'failed' ? act(r.id, 'retry', 'Retry') : r.status === 'unknown' ? `${act(r.id, 'sent', 'Mark sent')} ${act(r.id, 'retry', 'Retry')}` : '');
const attemptNote = (r) => (r.status === 'queued' && r.nextAttemptAt ? `<div class="muted">attempt ${r.attempts + 1} at ${when(r.nextAttemptAt)}</div>` : '');

function breakerTable(breakers) {
  if (!breakers.length) return '';
  const rows = breakers.map((b) => `<tr><td>${esc(b.connector)}</td><td>${esc(b.mode)}</td><td><span class="status">${esc(b.state)}</span></td>
    <td>${b.failures}</td><td>${b.state === 'open' ? esc(when(b.openUntil)) : ''}</td></tr>`).join('');
  return `<h3>Circuit breakers</h3><p class="muted">A connector that keeps failing is not called until its cooldown is over.</p>
    <table><thead><tr><th>Connector</th><th>Mode</th><th>State</th><th>Failures</th><th>Open until</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Each connector and the mode it runs in now (the deploy file, runtime/deploy.mjs); never a secret, only how it is set up.
// A list, not table rows: a screen that counts the outbox's rows must not count these.
function modeList(modes) {
  if (!modes.length) return '';
  const items = modes.map((m) => `<li><b>${esc(m.connector)}</b> (${esc(m.kind)}): <span class="status">${esc(m.mode)}</span> <span class="muted">offers ${esc(m.modes.join(', '))}</span></li>`).join('');
  return `<h3>Connector modes</h3><p class="muted">Sandbox answers from the connector's own rules and sends nothing; live calls the provider. Switched only with the command line.</p><ul class="modes">${items}</ul>`;
}

export function outboxView(graph, rows, flash, vc = anyone, breakers = [], modes = []) {
  const body = rows.map((r) => `<tr><td>${r.id}</td><td>${esc(r.kind)}</td><td>${esc(r.connector)}</td><td>${esc(r.target)}</td>
    <td><span class="status">${esc(r.status)}</span>${r.code ? ` ${r.code}` : ''}${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}${attemptNote(r)}</td>
    <td><pre class="muted">${esc(JSON.stringify(r.payload, null, 1))}</pre></td><td>${esc(r.updatedAt)}</td><td>${actions(r)}</td></tr>`).join('');
  return page(graph, { title: 'Outbox', flash, vc,
    body: `<h2>Outbox</h2><p class="muted">Everything the application sent out, with its delivery status.</p>
      <table><thead><tr><th>#</th><th>Kind</th><th>Connector</th><th>Target</th><th>Status</th><th>Payload</th><th>Updated</th><th></th></tr></thead>
      <tbody>${body}</tbody></table><p class="muted">${rows.length} item(s)</p>${modeList(modes)}${breakerTable(breakers)}` });
}
