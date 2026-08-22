// WebGen-Bench 000080 — advanced to-do list.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Create a new task via the Add Task form',
    run: async ({ follow, get, rowWith, must }) => {
      await follow('/Task', { title: 'Buy milk', notes: 'from the corner shop' });
      const { html } = await get('/Task');
      must(rowWith(html, 'Buy milk'), 'new task is not in the list');
      must(html.includes('from the corner shop'), 'notes are not shown');
      return 'row present with title and notes';
    } },
  { task: 'Edit an existing task and save',
    run: async ({ get, follow, idOf, rowWith, must }) => {
      const id = idOf((await get('/Task')).html, 'Buy milk');
      await follow(`/Task/${id}`, { title: 'Buy oat milk', notes: 'from the corner shop' });
      const { html } = await get('/Task');
      must(rowWith(html, 'Buy oat milk'), 'edited title is not in the list');
      return 'title updated in place';
    } },
  { task: 'Mark a task as completed',
    run: async ({ get, follow, idOf, rowWith, must }) => {
      const id = idOf((await get('/Task')).html, 'Buy oat milk');
      await follow(`/Task/${id}/action/toggle`, {});
      const { html } = await get('/Task');
      const row = rowWith(html, 'Buy oat milk');
      must(/class="done"/.test(html), 'no strikethrough on the completed row');
      must(row.includes('Completed'), 'the row does not read Completed');
      return 'strikethrough + Completed';
    } },
  { task: 'Delete a task',
    run: async ({ get, follow, idOf, rowWith, must }) => {
      await follow('/Task', { title: 'Throwaway' });
      const id = idOf((await get('/Task')).html, 'Throwaway');
      await follow(`/Task/${id}/delete`, {});
      const { html } = await get('/Task');
      must(!rowWith(html, 'Throwaway'), 'the deleted task is still visible');
      return 'row gone from the list';
    } },
  { task: 'Search tasks by title or keyword',
    run: async ({ follow, get, rowWith, must }) => {
      await follow('/Task', { title: 'Call the dentist', notes: 'annual checkup' });
      const a = await get('/Task?q=dentist');
      must(rowWith(a.html, 'Call the dentist'), 'search by title found nothing');
      must(!rowWith(a.html, 'Buy oat milk'), 'search returned unrelated rows');
      const b = await get('/Task?q=checkup');
      must(rowWith(b.html, 'Call the dentist'), 'search by notes found nothing');
      return 'matches by title and notes, excludes the rest';
    } },
  { task: 'Filter completed and uncompleted tasks',
    run: async ({ get, rowWith, must }) => {
      const done = await get('/list/completed');
      must(rowWith(done.html, 'Buy oat milk'), 'completed filter hides a completed task');
      must(!rowWith(done.html, 'Call the dentist'), 'completed filter shows an active task');
      const active = await get('/list/active');
      must(rowWith(active.html, 'Call the dentist'), 'active filter hides an active task');
      must(!rowWith(active.html, 'Buy oat milk'), 'active filter shows a completed task');
      const all = await get('/Task');
      must(rowWith(all.html, 'Buy oat milk') && rowWith(all.html, 'Call the dentist'), 'filtering changed the data');
      return 'both directions, unfiltered state intact';
    } },
  navCheck(3),
  colorCheck('lavender', 'indigo'),
];
