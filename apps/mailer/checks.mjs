// webgen-bench/000042 — an email sending platform: compose, recipients, attachments, sending, templates.
// One check per ui_instruct case; the letters themselves are read back from the outbox.
import { colorCheck } from '../../verify/lib.mjs';

let draftId = null, sentSubject = 'Spring release';

export const checks = [
  { task: 'Locate and use the compose email feature to draft a new email',
    run: async ({ asGuest, login, get, post, must, flashOf }) => {
      asGuest();
      const anon = await get('/Email/new');
      must(anon.location.startsWith('/login'), `a guest reached the compose form: ${anon.status} ${anon.location}`);
      must((await login('sam@mailer.test', 'sam123')).status === 303, 'the sender could not log in');
      const form = await get('/Email/new');
      must(/name="subject"/.test(form.html) && /name="body"/.test(form.html) && /<button type="submit">Save draft<\/button>/.test(form.html),
        'the compose form has no subject, body or save button');
      const short = await post('/Email', { subject: 'Hi', body: 'Too short a subject' });
      must(short.status === 400 && /at least 3 characters/.test(short.html), 'a two-character subject was accepted');
      const saved = await post('/Email', { subject: sentSubject, body: 'Hello,\n\nThe spring release is out.\n\nSam' });
      must(saved.status === 303 && /^\/Email\/\d+/.test(saved.location), `saving the draft returned ${saved.status} ${saved.location}`);
      draftId = /\/Email\/(\d+)/.exec(saved.location)[1];
      const detail = await get(saved.location);
      must(/Draft saved/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(/<th>Status<\/th><td><span class="status">Draft<\/span>/.test(detail.html), 'the new email is not a draft');
      must(/<th>Owner<\/th><td><a href="\/User\/\d+">sam@mailer.test<\/a>/.test(detail.html), 'the owner was not filled from the session');
      return `draft #${draftId} composed; a short subject refused`;
    } },

  { task: 'Select a recipient from the recipient management list and add them to the new email',
    run: async ({ get, post, follow, rows, rowWith, idOf, must, flashOf }) => {
      const book = await get('/Recipient');
      must(rows(book.html).length === 4, `the recipient list shows ${rows(book.html).length} rows, expected 4`);
      must(/ada@clients.test/.test(book.html) && /Analytical Ltd/.test(book.html), 'the address book shows no address or company');
      const filtered = await get('/Recipient?list=partners');
      must(rows(filtered.html).length === 1 && rowWith(filtered.html, 'grace@partners.test'), 'the list filter does not narrow the address book');
      const searched = await get('/Recipient?q=Bletchley');
      must(rows(searched.html).length === 1 && rowWith(searched.html, 'alan@staff.test'), 'searching the address book by company found nothing');
      const ada = idOf(book.html, 'ada@clients.test', 'Recipient');
      const grace = idOf(book.html, 'grace@partners.test', 'Recipient');
      const added = await follow(`/Email/${draftId}/add/EmailRecipient`, { recipient: ada });
      must(/Recipient added/.test(flashOf(added.html)), `flash: ${flashOf(added.html)}`);
      await follow(`/Email/${draftId}/add/EmailRecipient`, { recipient: grace });
      const detail = await get(`/Email/${draftId}`);
      must(/<th>Recipients<\/th><td>2<\/td>/.test(detail.html), 'the recipient count did not follow the added rows');
      must(/ada@clients.test/.test(detail.html) && /grace@partners.test/.test(detail.html),
        'the recipients table does not show the addresses derived through the reference');
      const back = await get('/Recipient');
      must(/<td>1<\/td>/.test(rowWith(back.html, 'ada@clients.test')), 'the address book does not count the letters a recipient is on');
      return 'address book of 4 with filter and search; Ada and Grace added to the draft';
    } },

  { task: 'Upload an attachment to an email draft',
    run: async ({ get, upload, must }) => {
      const csv = 'item,price\nmug,12.50\nposter,25.00\n';
      const up = await upload(`/Email/${draftId}/add/Attachment`, { name: 'Price list' }, { field: 'file', name: 'prices.csv', content: csv });
      must(up.status === 303, `the upload returned ${up.status}: ${up.html.slice(0, 200)}`);
      const detail = await get(`/Email/${draftId}`);
      must(/<th>Files<\/th><td>1<\/td>/.test(detail.html), 'the attachment count did not follow');
      const href = (/href="(\/file\/Attachment\/\d+\/file)"/.exec(detail.html) || [])[1];
      must(href, 'the attachment has no download link');
      const file = await get(href);
      must(file.html === csv, `the downloaded file differs: ${JSON.stringify(file.html.slice(0, 40))}`);
      must(/filename="prices.csv"/.test(file.disposition), `content-disposition: ${file.disposition}`);
      return 'prices.csv uploaded, listed under the draft and downloaded back byte for byte';
    } },

  { task: 'Send a composed email to the selected recipients',
    run: async ({ get, post, login, asGuest, rows, rowWith, must, flashOf }) => {
      const sent = await post(`/Email/${draftId}/go/send`, {});
      must(sent.status === 303, `sending returned ${sent.status}: ${sent.html.slice(0, 200)}`);
      const detail = await get(sent.location);
      must(/Sent to 2 recipient\(s\)/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(/<th>Status<\/th><td><span class="status">Sent<\/span>/.test(detail.html), 'the email did not become sent');
      must(/<th>Sent At<\/th><td>\d{4}-\d{2}-\d{2}/.test(detail.html), 'the send time was not recorded');
      must(!/go\/send/.test(detail.html), 'a sent email is still offered the send button');
      const again = await post(`/Email/${draftId}/go/send`, {});
      must(again.status === 409, `sending twice returned ${again.status}, expected 409`);
      asGuest();
      must((await login('admin@mailer.test', 'admin123')).status === 303, 'the admin could not log in');
      const outbox = await get('/outbox');
      const letters = rows(outbox.html).filter((r) => /mail/.test(r));
      must(letters.length === 2, `the outbox holds ${letters.length} letters, expected 2`);
      const toAda = rowWith(outbox.html, 'ada@clients.test');
      must(toAda && /<span class="status">sent<\/span>/.test(toAda), `Ada's letter was not delivered: ${toAda}`);
      must(new RegExp(`subject&quot;: &quot;${sentSubject}`).test(outbox.html), 'the letter carries another subject');
      must(/spring release is out/.test(outbox.html), 'the letter body is not the draft body');
      asGuest();
      await login('sam@mailer.test', 'sam123');
      return 'one letter per recipient queued after the commit and delivered; a second send answers 409';
    } },

  { task: 'Access the sent emails section and verify that the recently sent email is present',
    run: async ({ get, rows, rowWith, must }) => {
      const nav = await get('/');
      must(/href="\/list\/sent"/.test(nav.html), 'the menu has no sent section');
      const sent = await get('/list/sent');
      must(sent.status === 200, `the sent list returned ${sent.status}`);
      const row = rowWith(sent.html, sentSubject);
      must(row, `the sent email is missing from the sent list: ${rows(sent.html).length} rows`);
      must(/<td>2<\/td>/.test(row) && /<td>1<\/td>/.test(row), `the sent row lost its recipient or file count: ${row}`);
      const drafts = await get('/list/drafts');
      must(!rowWith(drafts.html, sentSubject), 'the sent email is still listed as a draft');
      const found = await get(`/list/sent?q=Spring`);
      must(rowWith(found.html, sentSubject), 'searching the sent list found nothing');
      return 'the letter is in Sent with its counts, gone from Drafts, and findable by search';
    } },

  { task: 'Create and save a new email template',
    run: async ({ get, post, rows, must, flashOf }) => {
      const before = rows((await get('/Template')).html).length;
      const made = await post('/Template', { name: 'Release notes', subject: 'What shipped in the spring release',
        body: 'Hello,\n\nThe release notes are attached.\n\nSam' });
      must(made.status === 303, `saving the template returned ${made.status}: ${made.html.slice(0, 200)}`);
      const detail = await get(made.location);
      must(/Template saved/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(/<th>Subject<\/th><td>What shipped in the spring release<\/td>/.test(detail.html), 'the template subject was not saved');
      const dup = await post('/Template', { name: 'Release notes', subject: 'Another', body: 'x' });
      must(dup.status === 400 && /already exists/.test(dup.html), 'a second template took the same name');
      const list = await get('/Template');
      must(rows(list.html).length === before + 1, `the template list shows ${rows(list.html).length} rows, expected ${before + 1}`);
      return `template saved (${before + 1} in the library); a duplicate name refused`;
    } },

  { task: 'Edit an existing email template and save the changes',
    run: async ({ get, post, follow, idOf, must, flashOf }) => {
      const list = await get('/Template');
      const id = idOf(list.html, 'Release notes', 'Template');
      const edited = await post(`/Template/${id}`, { name: 'Release notes', subject: 'Spring release — what shipped',
        body: 'Hello,\n\nHere are the spring release notes.\n\nSam' });
      must(edited.status === 303, `editing returned ${edited.status}: ${edited.html.slice(0, 200)}`);
      const detail = await get(edited.location);
      must(/Template updated/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(/<th>Subject<\/th><td>Spring release — what shipped<\/td>/.test(detail.html), 'the edited subject was not saved');
      const composed = await post(`/Template/${id}/action/compose`, {});
      must(composed.status === 303 && /^\/Email\/\d+/.test(composed.location), `composing from the template returned ${composed.status} ${composed.location}`);
      const draft = await get(composed.location);
      must(/Draft started from Release notes/.test(flashOf(draft.html)), `flash: ${flashOf(draft.html)}`);
      must(/<th>Subject<\/th><td>Spring release — what shipped<\/td>/.test(draft.html), 'the new draft did not take the edited subject');
      must(/<th>Template<\/th><td><a href="\/Template\/\d+">Release notes<\/a>/.test(draft.html), 'the draft does not point back at its template');
      const used = await get(`/Template/${id}`);
      must(/<th>Used<\/th><td>1<\/td>/.test(used.html), 'the template does not count the drafts made from it');
      return 'template edited; a draft composed from it carries the new subject and counts against it';
    } },

  colorCheck('cornsilk', 'peru'),
];

export const changes = [
  { title: 'second role with reduced access', patch: 'change-1-role.patch.json', checks: [
    { task: 'An assistant drafts and edits letters but cannot send them, manage the address book or see another sender\'s mail',
      run: async ({ asGuest, login, get, post, rows, rowWith, must }) => {
        must((await login('admin@mailer.test', 'admin123')).status === 303, 'the admin could not log in');
        const made = await post('/User', { email: 'kim@mailer.test', password: 'kim123', name: 'Kim', role: 'assistant' });
        must(made.status === 303, `creating the assistant returned ${made.status}: ${made.html.slice(0, 200)}`);
        asGuest();
        must((await login('kim@mailer.test', 'kim123')).status === 303, 'the assistant could not log in');
        const mine = await get('/Email');
        must(rows(mine.html).length === 0, `the assistant sees ${rows(mine.html).length} of the sender's emails, expected none`);
        const draft = await post('/Email', { subject: 'Draft by the assistant', body: 'For Sam to send.' });
        must(draft.status === 303, `the assistant could not draft: ${draft.status}`);
        const id = /\/Email\/(\d+)/.exec(draft.location)[1];
        const book = await get('/Recipient');
        must(book.status === 200 && rows(book.html).length === 4, 'the assistant cannot read the address book');
        must(!/href="\/Recipient\/new"/.test(book.html), 'the assistant is offered to add a recipient');
        must((await post('/Recipient', { name: 'Sneak', email: 'sneak@x.test' })).status === 403, 'the assistant added a recipient');
        const added = await post(`/Email/${id}/add/EmailRecipient`, { recipient: 1 });
        must(added.status === 303, `the assistant could not add a recipient to the draft: ${added.status}`);
        const detail = await get(`/Email/${id}`);
        must(!/go\/send/.test(detail.html), 'the assistant is offered the send button');
        must((await post(`/Email/${id}/go/send`, {})).status === 403, 'the assistant sent an email');
        must((await post('/Template', { name: 'Assistant template', subject: 'x', body: 'y' })).status === 403, 'the assistant created a template');
        must((await get(`/Email/${draftId}`)).status === 403, "the assistant opened the sender's letter");
        must((await get('/outbox')).status === 403, 'the assistant opened the outbox');
        return 'assistant: own draft with recipients, send/templates/address-book/outbox 403, other senders invisible';
      } },
  ] },
];
