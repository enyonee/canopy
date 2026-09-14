// Reference app "crm" — each check is one requirement of a small sales CRM.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

let leadId = null, acmeId = null;
const today = () => new Date().toISOString().slice(0, 10);

export const checks = [
  { task: 'Without an anonymous role every page asks for a login first',
    run: async ({ asGuest, get, must }) => {
      asGuest();
      for (const p of ['/', '/Lead', '/Company', '/dashboard/pipeline']) {
        const r = await get(p);
        must(r.location.startsWith('/login'), `${p} did not redirect to login: ${r.status} ${r.location}`);
      }
      return 'four pages, all redirected to /login';
    } },
  { task: 'A sales person signs in and creates a company, a contact and a lead that becomes theirs',
    run: async ({ login, post, get, follow, idOf, rowWith, must, flashOf }) => {
      const r = await login('alice@crm.test', 'alice123');
      must(r.status === 303, `login returned ${r.status}`);
      let page = await follow('/Company', { name: 'Acme', industry: 'software', website: 'acme.test' });
      acmeId = idOf(page.html, 'Acme', 'Company');
      must(acmeId, 'the company is not in the list');
      page = await follow('/Contact', { name: 'Ann Acme', email: 'ann@acme.test', phone: '1', company: acmeId });
      must(rowWith(page.html, 'ann@acme.test'), 'the contact is not in the list');
      const dup = await post('/Contact', { name: 'Ann again', email: 'ann@acme.test' });
      must(dup.status === 400 && /A contact with this email already exists/.test(dup.html), 'a duplicate contact email was accepted');
      const contact = idOf(page.html, 'ann@acme.test', 'Contact');
      const form = await get('/Lead/new');
      must(!/name="owner"/.test(form.html), 'the owner is offered on the form although it is set from the session');
      must(!/name="status"/.test(form.html), 'the status is offered on the form although transitions own it');
      page = await follow('/Lead', { title: 'Big deal', company: acmeId, contact, value: '1500', source: 'referral' });
      must(/Lead saved/.test(flashOf(page.html)), `flash: ${flashOf(page.html)}`);
      const row = rowWith(page.html, 'Big deal');
      must(row && /alice@crm.test/.test(row) && /1500\.00/.test(row) && /status">New/.test(row), `lead row: ${row}`);
      leadId = idOf(page.html, 'Big deal', 'Lead');
      const bad = await post('/Lead', { title: 'Negative', value: '-5' });
      must(bad.status === 400 && /Value cannot be negative/.test(bad.html), 'a negative value was accepted');
      return 'company, contact (unique email), lead owned by the session user, rule enforced';
    } },
  { task: 'A new lead notifies the external system over HTTP with owner and value',
    run: async ({ must, sink }) => {
      const hooks = sink.received.filter((h) => h.path === '/hooks/crm');
      must(hooks.length === 1, `expected 1 call to /hooks/crm, got ${hooks.length}`);
      const b = hooks[0].body;
      must(b.event === 'lead.created' && b.title === 'Big deal' && b.owner === 'alice@crm.test' && b.value === 1500, `hook body: ${JSON.stringify(b)}`);
      sink.clear();
      return 'lead.created with title, owner email and value 1500';
    } },
  { task: 'Activities are logged from the lead; counts are derived; a meeting needs a due date',
    run: async ({ get, post, follow, rowWith, must }) => {
      let detail = await get(`/Lead/${leadId}`);
      must(/<th>Activities<\/th><td>0<\/td>/.test(detail.html) && /<th>Open<\/th><td>0<\/td>/.test(detail.html), 'derived counts are not 0 on a new lead');
      must(/<th>Age<\/th><td>0<\/td>/.test(detail.html), 'age is not 0 on a lead created today');
      const bad = await post(`/Lead/${leadId}/add/Activity`, { kind: 'meeting', note: 'Kickoff' });
      must(bad.status === 400 && /Calls, meetings and emails need a due date/.test(bad.html), 'a meeting without a date was accepted');
      detail = await follow(`/Lead/${leadId}/add/Activity`, { kind: 'call', note: 'Intro call', due: today() });
      must(/<th>Activities<\/th><td>1<\/td>/.test(detail.html) && /<th>Open<\/th><td>1<\/td>/.test(detail.html), 'counts did not follow the new activity');
      const row = rowWith(detail.html, 'Intro call');
      must(row && /alice@crm.test/.test(row), 'the activity owner was not filled from the session');
      const activity = /\/Activity\/(\d+)\/edit/.exec(row)[1];
      const after = await follow(`/Activity/${activity}`, { kind: 'call', note: 'Intro call', due: today(), done: 'on' });
      must(/<th>Open<\/th><td>0<\/td>/.test(after.html) && /<th>Activities<\/th><td>1<\/td>/.test(after.html), 'open count did not drop after marking done');
      return 'rule message, activities 1 / open 1 → open 0';
    } },
  { task: 'The pipeline moves through transitions; winning asks for a close date and notifies',
    run: async ({ get, post, follow, must, flashOf, sink }) => {
      let r = await follow(`/Lead/${leadId}/go/contact`, {});
      must(/status">Contacted/.test(r.html), 'contact transition did not move the status');
      must(!/go\/contact"/.test(r.html) && /go\/qualify"/.test(r.html), 'the offered transitions do not follow the status');
      const skip = await post(`/Lead/${leadId}/go/win`, { closedAt: today() });
      must(skip.status === 409, `winning from contacted returned ${skip.status}`);
      r = await follow(`/Lead/${leadId}/go/qualify`, {});
      must(/status">Qualified/.test(r.html), 'qualify did not move the status');
      const noDate = await post(`/Lead/${leadId}/go/win`, {});
      must(noDate.status === 400 && /closedAt is required/.test(noDate.html), 'winning without a close date was accepted');
      r = await follow(`/Lead/${leadId}/go/win`, { closedAt: today() });
      must(/Deal won: Big deal for 1500\.00/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/status">Won/.test(r.html) && new RegExp(`<th>Closed At</th><td>${today()}</td>`).test(r.html), 'won state or close date missing');
      const won = sink.received.find((h) => h.body.event === 'lead.won');
      must(won && won.body.value === 1500 && won.body.closedAt === today(), `no lead.won hook: ${JSON.stringify(sink.received.map((h) => h.body))}`);
      const company = await get(`/Company/${acmeId}`);
      must(/<th>Leads<\/th><td>1<\/td>/.test(company.html) && /<th>Pipeline<\/th><td>1500\.00<\/td>/.test(company.html), 'company derived pipeline is wrong');
      return 'new → contacted → qualified → won; 409 on a skipped step; close date required; hook and company pipeline';
    } },
  { task: 'Sales people see only their own leads and cannot touch others',
    run: async ({ asGuest, login, get, post, rows, rowWith, must }) => {
      asGuest();
      await login('bob@crm.test', 'bob123');
      const leads = await get('/Lead');
      must(rowWith(leads.html, 'Northwind renewal') && rowWith(leads.html, 'Helio pilot') && !rowWith(leads.html, 'Big deal'), 'bob sees the wrong leads');
      must((await get(`/Lead/${leadId}`)).status === 403, "bob opened alice's lead");
      must((await post(`/Lead/${leadId}`, { title: 'Hijacked' })).status === 403, "bob edited alice's lead");
      must((await post(`/Lead/${leadId}/go/reopen`, {})).status === 403, "bob moved alice's lead");
      must((await get('/dashboard/pipeline')).status === 403, 'bob opened the admin dashboard');
      const mine = await get('/list/my-leads');
      must(rows(mine.html).length === 2, `my-leads shows ${rows(mine.html).length} rows for bob`);
      const numbers = await get('/dashboard/mine');
      must(/<b>800\.00<\/b>My pipeline/.test(numbers.html) && /<b>2400\.00<\/b>My won/.test(numbers.html), 'the personal dashboard does not resolve @me');
      return 'own leads only; 403 on detail, edit, transition, admin dashboard; @me dashboard';
    } },
  { task: 'The admin sees everything, the dashboard sums by status, owner and month, and filters by period',
    run: async ({ asGuest, login, get, rows, must }) => {
      asGuest();
      await login('admin@crm.test', 'admin123');
      const leads = await get('/Lead');
      must(rows(leads.html).length === 3, `the admin sees ${rows(leads.html).length} leads`);
      const d = await get('/dashboard/pipeline');
      must(d.status === 200, `dashboard returned ${d.status}`);
      must(/<b>3900\.00<\/b>Won value/.test(d.html), 'won value should be 2400 + 1500');
      must(/<b>1<\/b>Open leads/.test(d.html) && /<b>800\.00<\/b>Pipeline value/.test(d.html), 'open leads / pipeline value wrong');
      must(/alice@crm.test<\/td><td>1<\/td><td>1500\.00<\/td>/.test(d.html), 'by-owner row for alice is wrong');
      must(/2026-01<\/td><td>2<\/td><td>3200\.00<\/td>/.test(d.html), 'by-month row for January is wrong');
      must(/Referral<\/td><td>2<\/td>/.test(d.html), 'by-source row is wrong');
      const jan = await get('/dashboard/pipeline?from=2026-01-01&to=2026-01-31');
      must(/<b>2<\/b>Leads/.test(jan.html) && /<b>2400\.00<\/b>Won value/.test(jan.html), 'the period filter does not narrow to January');
      return 'won 3900.00; by status, owner, month, source; January filter';
    } },
  { task: 'The outbox records the letters to contacts and the delivered hooks',
    run: async ({ get, rows, must }) => {
      const outbox = await get('/outbox');
      must(outbox.status === 200, `outbox returned ${outbox.status}`);
      const mails = rows(outbox.html).filter((x) => x.includes('<td>mail</td>'));
      const hooks = rows(outbox.html).filter((x) => x.includes('<td>http</td>'));
      must(mails.length === 2 && mails.every((m) => /ann@acme.test/.test(m)), `expected 2 letters to ann@acme.test, got ${mails.length}`);
      must(hooks.length === 2 && hooks.every((h) => /status">sent<\/span> 200/.test(h)), `expected 2 delivered hooks, got ${hooks.map((h) => /status">(\w+)/.exec(h)?.[1])}`);
      return '2 letters, 2 hooks sent with 200';
    } },
  { task: 'The due-today list shows open activities due by today and hides done ones',
    run: async ({ asGuest, login, follow, get, rows, must }) => {
      asGuest();
      await login('alice@crm.test', 'alice123');
      await follow(`/Lead/${leadId}/add/Activity`, { kind: 'email', note: 'Send contract', due: today() });
      await follow(`/Lead/${leadId}/add/Activity`, { kind: 'call', note: 'Next quarter', due: '2099-01-01' });
      const due = await get('/list/due');
      const shown = rows(due.html);
      must(shown.length === 1 && /Send contract/.test(shown[0]), `due list has ${shown.length} row(s): ${shown.map((r) => r.slice(0, 80))}`);
      return 'one due activity; done and future ones hidden';
    } },
  navCheck(3),
  colorCheck('aliceblue', 'darkslategray'),
];

// The three changes of the experiment template, applied as patches on the same database.
const retryId = (html) => { const m = /\/outbox\/(\d+)\/retry/.exec(html); return m ? m[1] : null; };
export const changes = [
  { title: 'second role with reduced access', patch: 'change-1-role.patch.json', checks: [
    { task: 'A viewer reads every lead and changes nothing',
      run: async ({ login, post, get, rows, must, asGuest }) => {
        await login('admin@crm.test', 'admin123');
        const made = await post('/User', { email: 'vic@crm.test', password: 'vic123', name: 'Vic', role: 'viewer' });
        must(made.status === 303, `creating the viewer returned ${made.status}`);
        asGuest();
        must((await login('vic@crm.test', 'vic123')).status === 303, 'the viewer could not log in');
        const leads = await get('/Lead');
        must(rows(leads.html).length === 3, `the viewer sees ${rows(leads.html).length} leads`);
        must(!/href="\/Lead\/new"/.test(leads.html) && !/\/edit"/.test(leads.html) && !/go\/contact"/.test(leads.html), 'the viewer is offered buttons it cannot use');
        must((await get('/Lead/new')).status === 403, 'the viewer opened the lead form');
        must((await post('/Lead', { title: 'x' })).status === 403, 'the viewer created a lead');
        must((await post(`/Lead/${leadId}/go/reopen`, {})).status === 403, 'the viewer moved a lead');
        must((await get('/dashboard/pipeline')).status === 403 && (await get('/dashboard/mine')).status === 403, 'the viewer opened a dashboard');
        return 'all 3 leads visible, no buttons, 403 on form, create, transition, dashboards';
      } },
  ] },
  { title: 'activity report per owner for a period, with a new field', patch: 'change-2-period.patch.json', checks: [
    { task: 'The new minutes field is migrated with its default and the report sums it by owner and period',
      run: async ({ login, get, must, migrations }) => {
        must(migrations.some((m) => /add column activity\.minutes \(\+ backfilled 3 row\(s\) with 30\)/.test(m)), `migrations: ${migrations.join(' | ')}`);
        await login('admin@crm.test', 'admin123');
        const d = await get('/dashboard/activity');
        must(d.status === 200, `report returned ${d.status}`);
        must(/<b>3<\/b>Activities/.test(d.html) && /<b>90<\/b>Minutes/.test(d.html), 'totals are wrong');
        must(/alice@crm.test<\/td><td>3<\/td><td>90<\/td>/.test(d.html), 'by-owner row is wrong');
        must(/Call<\/td><td>2<\/td>/.test(d.html) && /Email<\/td><td>1<\/td>/.test(d.html), 'by-kind rows are wrong');
        const t = today();
        const day = await get(`/dashboard/activity?from=${t}&to=${t}`);
        must(/<b>2<\/b>Activities/.test(day.html) && /<b>60<\/b>Minutes/.test(day.html), 'the period filter does not narrow to today');
        return 'backfilled 3 rows with 30; 3/90; today 2/60';
      } },
  ] },
  { title: 'HTTP notification with delivery status', patch: 'change-3-notify.patch.json', checks: [
    { task: 'A logged activity notifies the calendar; a failed delivery shows as failed and is retried',
      run: async ({ login, follow, get, rows, must, sink, flashOf, asGuest }) => {
        await login('alice@crm.test', 'alice123');
        sink.clear();
        await follow(`/Lead/${leadId}/add/Activity`, { kind: 'meeting', note: 'Demo', due: today() });
        const hit = sink.received.find((h) => h.path === '/hooks/calendar');
        must(hit && hit.body.event === 'activity.created' && hit.body.lead === 'Big deal' && hit.body.kind === 'meeting' && hit.body.owner === 'alice@crm.test' && hit.body.due === today(),
          `calendar got ${JSON.stringify(sink.received.map((h) => [h.path, h.body]))}`);
        sink.state.failing = true;
        await follow(`/Lead/${leadId}/add/Activity`, { kind: 'note', note: 'Offline' });
        sink.state.failing = false;
        asGuest();
        await login('admin@crm.test', 'admin123');
        let outbox = await get('/outbox');
        const top = rows(outbox.html)[0];
        must(/status">failed<\/span> 500/.test(top), `the failed delivery is not shown as failed: ${top.slice(0, 300)}`);
        const r = await follow(`/outbox/${retryId(top)}/retry`, {});
        must(/retried: sent/.test(flashOf(r.html)), `retry flash: ${flashOf(r.html)}`);
        outbox = await get('/outbox');
        must(/status">sent<\/span> 200/.test(rows(outbox.html)[0]), 'the retried delivery is not sent');
        return 'delivered with lead title and due; failure visible; retry → sent';
      } },
  ] },
];
