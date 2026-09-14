// WebGen-Bench 000022 — customer service call logging. One check per ui_instruct case.
import { colorCheck } from '../../verify/lib.mjs';

const today = () => new Date().toISOString().slice(0, 10);
let clientId = null, callId = null;

export const checks = [
  { task: 'The client creator wizard adds a new client, confirms it, and the client appears in the client list',
    run: async ({ asGuest, login, get, post, rowWith, idOf, must, flashOf }) => {
      asGuest();
      must((await get('/Client')).location.startsWith('/login'), 'the client list is open without signing in');
      must((await login('mia@calls.test', 'mia123')).status === 303, 'the agent could not sign in');
      const wizard = await get('/Client/new');
      must(wizard.status === 200 && /Client creator wizard/.test(wizard.html) && /name="company"/.test(wizard.html), 'the wizard form is missing');
      const r = await post('/Client', { name: 'Vega Foods', company: 'Vega Foods Ltd', phone: '+1 555 0400', email: 'ops@vega.test', notes: 'Prefers email' });
      must(r.status === 303, `creating the client returned ${r.status}: ${r.html.slice(0, 300)}`);
      const list = await get(r.location);
      must(/Client created successfully/.test(flashOf(list.html)), `no confirmation: ${flashOf(list.html)}`);
      const row = rowWith(list.html, 'Vega Foods');
      must(row && /ops@vega.test/.test(row) && /<td>0<\/td>/.test(row), `the client row is wrong: ${row}`);
      clientId = idOf(list.html, 'Vega Foods', 'Client');
      must((await get('/User')).status === 403, 'an agent can open the team list');
      must((await post(`/Client/${clientId}/delete`, {})).status === 403, 'an agent can delete a client');
      return 'client created with confirmation, listed with 0 calls; agent denied team and delete';
    } },
  { task: 'A new call log with client, type and information is created; every field is preserved and confirmed',
    run: async ({ get, post, must, flashOf }) => {
      const form = await get('/CallLog/new');
      must(/name="client"/.test(form.html) && /name="type"/.test(form.html) && /name="information"/.test(form.html), 'the call log form lacks the required fields');
      must(!/name="agent"/.test(form.html) && !/name="status"/.test(form.html), 'agent or status is offered on the form');
      const bad = await post('/CallLog', { client: clientId, type: 'complaint', subject: 'Damaged parcel' });
      must(bad.status === 400 && /information is required/.test(bad.html), 'a call log without information was accepted');
      const r = await post('/CallLog', { client: clientId, type: 'complaint', subject: 'Damaged parcel', information: 'Box arrived crushed, two jars broken', additional: 'Photos promised by email' });
      must(r.status === 303 && /^\/CallLog\/\d+/.test(r.location), `creating the call log returned ${r.status} ${r.location}`);
      callId = /\/CallLog\/(\d+)/.exec(r.location)[1];
      const detail = await get(r.location);
      must(/Call log created successfully/.test(flashOf(detail.html)), `no confirmation: ${flashOf(detail.html)}`);
      must(new RegExp(`<th>Client</th><td><a href="/Client/${clientId}">Vega Foods</a></td>`).test(detail.html), 'the client is not preserved');
      must(/<th>Type<\/th><td>complaint<\/td>/.test(detail.html), 'the call type is not preserved');
      must(/<th>Information<\/th><td>Box arrived crushed, two jars broken<\/td>/.test(detail.html), 'the information is not preserved');
      must(/<th>Additional<\/th><td>Photos promised by email<\/td>/.test(detail.html), 'the additional information is not preserved');
      must(/<th>Agent<\/th><td><a href="\/User\/2">Mia<\/a><\/td>/.test(detail.html), 'the agent was not taken from the session');
      must(/<th>Status<\/th><td><span class="status">Open<\/span>/.test(detail.html), 'a new call is not open');
      return `call #${callId}: client, type, information, additional, agent from session, status open`;
    } },
  { task: "Modifying a client's information is saved, confirmed and shown on the client's profile",
    run: async ({ get, post, must, flashOf }) => {
      const form = await get(`/Client/${clientId}/edit`);
      must(/value="Vega Foods"/.test(form.html) && /value="\+1 555 0400"/.test(form.html), 'the edit form is not prefilled');
      const r = await post(`/Client/${clientId}`, { name: 'Vega Foods', company: 'Vega Foods International', phone: '+1 555 0499', email: 'ops@vega.test', notes: 'Prefers email' });
      must(r.status === 303 && r.location.startsWith(`/Client/${clientId}`), `edit returned ${r.status} ${r.location}`);
      const profile = await get(r.location);
      must(/Client information updated/.test(flashOf(profile.html)), `no confirmation: ${flashOf(profile.html)}`);
      must(/<th>Company<\/th><td>Vega Foods International<\/td>/.test(profile.html) && /<th>Phone<\/th><td>\+1 555 0499<\/td>/.test(profile.html), 'the changes are not on the profile');
      must(/<th>Calls<\/th><td>1<\/td>/.test(profile.html) && /Damaged parcel/.test(profile.html), "the profile does not list the client's calls");
      return 'company and phone changed, confirmed, derived call count 1';
    } },
  { task: 'An action step (and a follow-up step) is recorded on an existing call log with a confirmation',
    run: async ({ get, post, follow, rowWith, must, flashOf }) => {
      const bad = await post(`/CallLog/${callId}/add/ActionStep`, { kind: 'followUp', note: 'Check delivery' });
      must(bad.status === 400 && /A follow-up step needs a date/.test(bad.html), 'a follow-up without a date was accepted');
      let detail = await follow(`/CallLog/${callId}/add/ActionStep`, { kind: 'action', note: 'Sent a replacement parcel', due: today() });
      must(/Step recorded successfully/.test(flashOf(detail.html)), `no confirmation: ${flashOf(detail.html)}`);
      const row = rowWith(detail.html, 'Sent a replacement parcel');
      must(row && /<td>action<\/td>/.test(row) && /<td>No<\/td>/.test(row), `the step row is wrong: ${row}`);
      must(/<th>Steps<\/th><td>1<\/td>/.test(detail.html) && /<th>Pending<\/th><td>1<\/td>/.test(detail.html), 'step counts are not derived');
      detail = await follow(`/CallLog/${callId}/add/ActionStep`, { kind: 'followUp', note: 'Confirm the replacement arrived', due: '2026-09-30' });
      must(rowWith(detail.html, 'Confirm the replacement arrived') && /<th>Steps<\/th><td>2<\/td>/.test(detail.html), 'the follow-up step is not recorded');
      return 'rule message for a dateless follow-up; action + follow-up steps recorded, counts 2/2';
    } },
  { task: 'The menu leads to the open calls, shown as a list of only the open ones',
    run: async ({ get, rows, rowWith, must }) => {
      const home = await get('/');
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      must(/<a href="\/list\/open">Open calls<\/a>/.test(nav), 'the menu has no "Open calls" item');
      const open = await get('/list/open');
      must(open.status === 200 && /<h2>Open calls<\/h2>/.test(open.html), `open calls returned ${open.status}`);
      const shown = rows(open.html);
      must(shown.length === 3, `expected 3 open calls, got ${shown.length}`);
      must(shown.every((r) => /status">Open</.test(r)), 'a call that is not open is listed');
      must(rowWith(open.html, 'Late delivery') && rowWith(open.html, 'Bulk pricing') && rowWith(open.html, 'Damaged parcel'), 'an open call is missing');
      must(!rowWith(open.html, 'Password reset') && !rowWith(open.html, 'Invoice mismatch'), 'a closed or to-do call is listed as open');
      must(/go\/schedule"/.test(open.html) && /go\/close"/.test(open.html), 'the list offers no way to schedule or close a call');
      return '3 open calls, closed and to-do ones hidden, schedule/close offered';
    } },
  { task: 'The to-do calls list shows calls needing follow-up, consistent with what was logged',
    run: async ({ get, post, follow, rows, rowWith, must, flashOf }) => {
      const noDate = await post(`/CallLog/${callId}/go/schedule`, {});
      must(noDate.status === 400 && /followUp is required/.test(noDate.html), 'scheduling without a date was accepted');
      const r = await follow(`/CallLog/${callId}/go/schedule`, { followUp: '2026-09-30' });
      must(/Follow-up scheduled for 2026-09-30/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Status<\/th><td><span class="status">Todo<\/span>/.test(r.html), 'the call did not move to to-do');
      const todo = await get('/list/todo');
      must(todo.status === 200, `to-do calls returned ${todo.status}`);
      const shown = rows(todo.html);
      must(shown.length === 2, `expected 2 to-do calls, got ${shown.length}`);
      must(/Invoice mismatch/.test(shown[0]) && /2026-09-20/.test(shown[0]) && /<td>1<\/td>/.test(shown[0]), `the earliest follow-up is not first: ${shown[0]}`);
      must(/Damaged parcel/.test(shown[1]) && /Vega Foods/.test(shown[1]) && /2026-09-30/.test(shown[1]) && /<td>2<\/td>/.test(shown[1]), `the scheduled call is inconsistent: ${shown[1]}`);
      must(!rowWith(todo.html, 'Late delivery'), 'an open call is listed as to-do');
      must(rows((await get('/list/open')).html).length === 2, 'the scheduled call is still among the open ones');
      return 'date required; 2 to-do calls ordered by follow-up date with client and pending steps';
    } },
  { task: 'The call log report counts every call by type, status, agent, client and month, and narrows to a period',
    run: async ({ asGuest, login, get, must }) => {
      must((await get('/dashboard/report')).status === 200, 'the agent cannot open the report');
      asGuest();
      await login('admin@calls.test', 'admin123');
      const d = await get('/dashboard/report');
      must(d.status === 200 && /<h2>Call log report<\/h2>/.test(d.html), `report returned ${d.status}`);
      must(/<b>5<\/b>Calls/.test(d.html) && /<b>2<\/b>Open/.test(d.html) && /<b>2<\/b>To-do/.test(d.html) && /<b>1<\/b>Closed/.test(d.html), 'the totals are wrong');
      must(/Complaint<\/td><td>2<\/td>/.test(d.html) && /Billing<\/td><td>1<\/td>/.test(d.html), 'the by-type table is wrong');
      must(/Mia<\/td><td>3<\/td>/.test(d.html) && /Leo<\/td><td>2<\/td>/.test(d.html), 'the by-agent table is wrong');
      must(/Acme Ltd<\/td><td>2<\/td>/.test(d.html) && /Vega Foods<\/td><td>1<\/td>/.test(d.html), 'the by-client table is wrong');
      must(/2026-08<\/td><td>3<\/td>/.test(d.html) && /2026-07<\/td><td>1<\/td>/.test(d.html), 'the by-month table is wrong');
      const aug = await get('/dashboard/report?from=2026-08-01&to=2026-08-31');
      must(/<b>3<\/b>Calls/.test(aug.html) && /<b>2<\/b>Open/.test(aug.html) && !/2026-07<\/td>/.test(aug.html), 'the period filter does not narrow to August');
      return '5 calls; by type, agent, client, month; August filter 3';
    } },
  colorCheck('lightpink', 'mediumvioletred'),
];
