// The settings screen (GET /settings): one card per connector of the graph — its kind, mode, breaker per mode, what the
// outbox did in the last 24 hours, each secret slot as set or MISSING, the webhook path, and the forms that change
// them. It is shown to an admin only and holds no secret value anywhere: a slot is "set" or "MISSING" and nothing
// else (no length, no prefix), a password field is always empty, and what a form posts is never written back.
import { esc, page, anyone } from '../render.mjs';

const when = (ms) => new Date(ms).toISOString();
const post = (action, fields, inner, cls = 'inline') => `<form class="${cls}" method="post" action="${action}">${Object.entries(fields)
  .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}${inner}</form>`;

const breakerCell = (b) => `<span class="status">${esc(b.state)}</span>${b.failures ? ` ${b.failures} failure(s)` : ''}${b.state === 'open' ? ` until ${esc(when(b.openUntil))}` : ''}`;

function slotRow(it, s, unreadable) {
  const at = { connector: it.connector, slot: s.slot };
  const state = unreadable ? '<span class="error">unreadable</span>' : s.set ? '<span class="status">set</span>' : '<span class="error">MISSING</span>';
  const save = post('/settings/secret', at, `<input type="password" name="value" autocomplete="new-password" aria-label="New value of ${esc(s.slot)}" placeholder="${s.set ? 'replace…' : 'new value'}"> <button type="submit">Save</button>`);
  const remove = s.set ? post('/settings/secret/remove', at, '<label><input type="checkbox" name="confirm" value="yes"> remove</label> <button type="submit">Remove</button>') : '';
  return `<tr><td>${esc(s.slot)}</td><td><code>${esc(s.name)}</code></td><td>${state}</td><td>${save}</td><td>${remove}</td></tr>`;
}

// The shape of a sandbox answer: names and types, never the values (a test answer is invented, but a shape is all a person needs).
const shapeText = (shape) => (shape === null ? 'the operation declares no output' : `<pre class="muted">${esc(JSON.stringify(shape, null, 1))}</pre>`);

function testResult(r) {
  return `<div class="card"><p><b>Test ${esc(r.op)}:</b> <span class="status">${esc(r.status)}</span>${r.code ? ` ${r.code}` : ''}${r.error ? ` <span class="error">${esc(r.error)}</span>` : ''}</p>
    <p class="muted">Answer shape (names and types):</p>${shapeText(r.shape)}</div>`;
}

function modeBlock(it, graphFile) {
  const other = it.modes.find((m) => m !== it.mode);
  const cli = other ? `<p class="muted">Switching to ${esc(other)} is done on the command line only:<br><code>node runtime/run.mjs ${esc(graphFile)} --connectors ${esc(other)} ${esc(it.connector)}${other === 'live' ? ' --confirm' : ''}</code></p>` : `<p class="muted">This kind runs in ${esc(it.mode)} mode only.</p>`;
  const test = it.mode === 'sandbox' && it.test
    ? `<p>${post('/settings/test', { connector: it.connector }, `<button type="submit">Send test</button> <span class="muted">runs ${esc(it.test)} through the sandbox; nothing is sent</span>`)}</p>`
    : it.mode === 'sandbox' ? '<p class="muted">No sandbox test is available for this kind.</p>' : '<p class="muted">Send test runs in sandbox mode only; this connector is live.</p>';
  return test + cli;
}

function card(it, model) {
  const slots = it.slots.length
    ? `<table><thead><tr><th>Slot</th><th>Stored as</th><th>State</th><th>Set or replace (empty = no change)</th><th>Remove</th></tr></thead><tbody>${it.slots.map((s) => slotRow(it, s, model.unreadable)).join('')}</tbody></table>`
    : '<p class="muted">No secret slots.</p>';
  const c = it.counts;
  const hook = it.hook ? `<p>Webhook path: <code>${esc(it.hook)}</code> <span class="muted">(POST; give the provider your public address followed by this path)</span></p>` : '';
  const breakers = it.modes.map((m) => `${esc(m)}: ${breakerCell(it.breakers[m])}`).join(' &middot; ');
  return `<div class="card connector"><h3>${esc(it.connector)} <span class="muted">${esc(it.kind)}</span> <span class="status">${esc(it.mode)}</span></h3>
    <p>Breaker: ${breakers}</p>
    <p>Last 24 hours: sent ${c.sent}, failed ${c.failed}, unknown ${c.unknown}, drift ${c.drift}</p>
    ${hook}${slots}${modeBlock(it, model.graphFile)}${model.test?.connector === it.connector ? testResult(model.test) : ''}</div>`;
}

export function settingsView(graph, vc, flash, model) {
  const note = model.unreadable ? '<div class="card"><p class="error">The secret store cannot be read (wrong or missing master key), so no slot can be shown or changed.</p></div>' : '';
  return page(graph, { title: 'Settings', flash, vc: vc ?? anyone,
    body: `<h2>Connector settings</h2><p class="muted">A secret is written to the encrypted store and never shown again. Mode changes go through the command line.</p>${note}
      ${model.items.map((it) => card(it, model)).join('') || '<p class="muted">This graph has no connectors.</p>'}` });
}
