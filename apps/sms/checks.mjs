// WebGen-Bench 000043 — short message service platform.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Send a short message to a valid phone number; it appears in the records',
    run: async ({ follow, get, rowWith, must }) => {
      const after = await follow('/Message', { recipient: '+15550199', text: 'Your code is 4821' });
      must(after.html.includes('Message sent successfully'), 'no confirmation after sending');
      const { html } = await get('/Message');
      const row = rowWith(html, '+15550199');
      must(row, 'message is not in the sending records');
      must(row.includes('sent'), 'message status did not become "sent"');
      return 'record present with status sent';
    } },
  { task: 'Update a piece of user information',
    run: async ({ follow, must }) => {
      const after = await follow('/Contact/1', { name: 'Ann Lee', phone: '+15550102', email: 'ann.lee@example.com' });
      must(after.html.includes('updated successfully'), 'no confirmation after update');
      must(after.html.includes('ann.lee@example.com'), 'updated contact information did not persist');
      return 'contact updated and confirmed';
    } },
  { task: 'Configure a new sending policy; it appears in the list of active policies',
    run: async ({ follow, rowWith, must }) => {
      const after = await follow('/Policy', { name: 'Night quiet hours', dailyLimit: '20', enabled: 'on' });
      must(after.html.includes('Policy saved successfully'), 'no confirmation after saving the policy');
      const row = rowWith(after.html, 'Night quiet hours');
      must(row, 'policy is not in the list');
      must(row.includes('Active'), 'policy is not marked active');
      return 'policy listed and active';
    } },
  { task: 'View short message sending records with recipient, status and time',
    run: async ({ get, rowWith, must }) => {
      const { html } = await get('/Message');
      must(/<th>(?:<a[^>]*>)?Recipient(?: [▲▼])?(?:<\/a>)?<\/th>/.test(html) && /<th>(?:<a[^>]*>)?Status(?: [▲▼])?(?:<\/a>)?<\/th>/.test(html) && /<th>(?:<a[^>]*>)?Sent At(?: [▲▼])?(?:<\/a>)?<\/th>/.test(html),
        'records table is missing recipient, status or time');
      must(rowWith(html, 'Your code is 4821'), 'the sent message is missing from the records');
      return 'columns recipient, text, status, sentAt';
    } },
  { task: 'Monitor sending on the dashboard',
    run: async ({ follow, get, must }) => {
      await follow('/Message', { recipient: '+15550200', text: 'Second message' });
      const { html } = await get('/dashboard/monitor');
      const metric = (title) => {
        const m = new RegExp(`<b>(\\d+)</b>${title}`).exec(html);
        if (!m) throw new Error(`metric "${title}" is missing from the dashboard`);
        return Number(m[1]);
      };
      must(metric('Messages total') === 2, `expected 2 messages total, dashboard says ${metric('Messages total')}`);
      must(metric('Sent') === 2, 'sent counter does not match the records');
      must(metric('Active policies') >= 1, 'active policy counter is wrong');
      must(/Messages by status/.test(html), 'no breakdown by status');
      return 'counters match the records, breakdown present';
    } },
  colorCheck('azure', 'darkslateblue'),
];
