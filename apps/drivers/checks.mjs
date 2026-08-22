// WebGen-Bench 000051 — driver recruitment website.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Register: submitting the profile form creates a user with a confirmation',
    run: async ({ follow, rowWith, must }) => {
      const after = await follow('/Profile', { name: 'Dana Ruiz', email: 'dana@example.com', phone: '+15550111' });
      must(after.html.includes('Registration completed successfully'), 'no registration confirmation');
      must(rowWith(after.html, 'Dana Ruiz'), 'the new profile is not listed');
      return 'profile created and confirmed';
    } },
  { task: 'A client posts a job; it appears among the postings',
    run: async ({ follow, rowWith, must }) => {
      const after = await follow('/Job', { title: 'Night route driver', company: 'Harbor Freight', location: 'Seattle', active: 'on' });
      must(after.html.includes('Job listing created successfully'), 'no confirmation after posting a job');
      const row = rowWith(after.html, 'Night route driver');
      must(row && row.includes('Harbor Freight') && row.includes('Seattle'), 'job details are wrong or missing');
      return 'job listed with its details';
    } },
  { task: 'A user applies for a job listing and gets a confirmation',
    run: async ({ get, follow, idOf, must }) => {
      const { html } = await get('/Job');
      const id = idOf(html, 'Night route driver');
      const after = await follow(`/Job/${id}/add/Application`, { name: 'Dana Ruiz', email: 'dana@example.com', message: 'Ten years on night routes.' });
      must(after.html.includes('application was submitted successfully'), 'no confirmation after applying');
      must(after.html.includes('Ten years on night routes.'), 'the application is not attached to the job');
      return 'application recorded under the job';
    } },
  { task: 'A user updates contact information and it is saved',
    run: async ({ get, follow, idOf, must }) => {
      const { html } = await get('/Profile');
      const id = idOf(html, 'Dana Ruiz');
      const after = await follow(`/Profile/${id}`, { name: 'Dana Ruiz', email: 'dana.ruiz@example.com', phone: '+15550222' });
      must(after.html.includes('updated successfully'), 'no confirmation after the update');
      must(after.html.includes('dana.ruiz@example.com') && after.html.includes('+15550222'), 'contact changes did not persist');
      return 'contact details saved and confirmed';
    } },
  { task: 'The contact form can be submitted and shows a thank-you message',
    run: async ({ follow, must }) => {
      const after = await follow('/ContactMessage', { name: 'Ivan Petrov', email: 'ivan@example.com', message: 'Do you hire in Denver?' });
      must(after.html.includes('Thank you'), 'no thank-you message after the contact form');
      return 'contact form accepted with a thank-you';
    } },
  { task: "Navigating from the home page to 'About Us' works",
    run: async ({ get, must }) => {
      const home = await get('/page/home');
      must(home.html.includes('href="/page/about"'), 'home page has no About us link');
      const about = await get('/page/about');
      must(about.status === 200 && /About us/.test(about.html), 'About us page did not open');
      return 'link present and the page opens';
    } },
  { task: 'The home page is reachable and renders',
    run: async ({ get, must, base }) => {
      const root = await fetch(base + '/', { redirect: 'manual' });
      must(root.status === 303 && root.headers.get('location') === '/page/home', 'root does not lead to the home page');
      const home = await get('/page/home');
      must(home.status === 200 && /Drivers wanted/.test(home.html), 'home page did not render');
      return 'root redirects to a rendering home page';
    } },
  { task: 'A client can see all active job postings',
    run: async ({ follow, get, rowWith, must }) => {
      await follow('/Job', { title: 'Closed route', company: 'Old Co', location: 'Reno' });
      const { html } = await get('/list/active-jobs');
      must(rowWith(html, 'Night route driver'), 'an active posting is missing');
      must(!rowWith(html, 'Closed route'), 'an inactive posting leaked into the active list');
      return 'only active postings listed';
    } },
  colorCheck('white', 'navy'),
];
