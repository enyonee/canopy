// Small standalone pages: a static /page/<id>, the login and register forms,
// and the outbox listing.
import { esc, label, anyone, page, enctype } from '../render.mjs';
import { formFields } from './form.mjs';

export function staticPage(graph, p, flash, vc = anyone) {
  const body = (p.body || []).map((t) => `<p>${esc(t)}</p>`).join('');
  const links = (p.links || []).map((l) => `<a class="btn" href="${esc(l.href)}">${esc(l.label)}</a>`).join(' ');
  const buttons = (p.actions || []).map((a) => {
    const act = (graph.actions || []).find((x) => x.name === a);
    return `<form class="inline" method="post" action="/action/${esc(a)}"><button type="submit">${esc(act?.title || label(a))}</button></form>`;
  }).join(' ');
  return page(graph, { title: p.title, flash, vc,
    body: `<h2>${esc(p.heading || p.title)}</h2><div class="card">${body}${buttons ? `<p>${buttons}</p>` : ''}</div><p>${links}</p>` });
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
