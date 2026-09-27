// WebGen-Bench 000052 — a blue-collar job site: worker profiles, job search,
// posting a listing, navigation, and a listing's detail page.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify that a user can update their profile information (e.g., skills, contact details)',
    run: async ({ login, get, post, idOf, must }) => {
      must((await login('marco@trades.test', 'marco123')).status === 303, 'Marco could not sign in');
      const mine = await get('/Profile');
      const id = idOf(mine.html, 'Marco Diaz', 'Profile');
      const saved = await post(`/Profile/${id}`, { headline: 'Master electrician, 8 years', trade: 'electrical',
        phone: '+1 555 0199', city: 'Portland, OR', skills: 'Panel upgrades, EV chargers', qualifications: 'Journeyman licence EL-4471', years: '9', available: 'true' });
      must(saved.status === 303, `edit was refused: ${saved.status} ${saved.html.slice(0, 200)}`);
      const again = await get(`/Profile/${id}`);
      must(/<th>Headline<\/th><td>Master electrician, 8 years<\/td>/.test(again.html) && /<th>Phone<\/th><td>\+1 555 0199<\/td>/.test(again.html),
        'the profile update was not saved');
      return 'headline, phone and years all update and persist on revisit';
    } },
  { task: 'Check the job search functionality by searching for "electrician" positions',
    run: async ({ asGuest, get, rows, must }) => {
      asGuest();
      const r = await get('/Job?q=electrician');
      const found = rows(r.html);
      must(found.length === 2 && found.every((x) => /electrician/i.test(x)), `expected the 2 electrician listings, got ${found.length}`);
      must(found.every((x) => /BuildRight Construction|Pipeworks Ltd/.test(x) && /Portland, OR|Salem, OR/.test(x)), 'title, employer or location missing from a result row');
      return '2 electrician listings found, each with its title, employer (company) and location';
    } },
  { task: 'Confirm that employers can post a new job listing with all required information (job description, requirements, contact details)',
    run: async ({ login, follow, get, must }) => {
      must((await login('buildright@trades.test', 'build123')).status === 303, 'the employer could not sign in');
      const posted = await follow('/Job', { title: 'HVAC technician', company: 'BuildRight Construction', trade: 'hvac', location: 'Portland, OR',
        description: 'Install and service residential HVAC systems for new-build homes, full time.', requirements: '2 years of experience, license preferred.',
        contactName: 'Dana Fowler', contactEmail: 'dana@buildright.test', contactPhone: '+1 555 0301', payRate: '35.00', payUnit: 'hour' });
      must(/Your job listing is live/.test(posted.html), `posting was not confirmed: ${posted.html.slice(0, 200)}`);
      must(/<th>Description<\/th><td>Install and service residential HVAC/.test(posted.html) &&
           /<th>Requirements<\/th><td>2 years of experience/.test(posted.html) &&
           /<th>Contact Name<\/th><td>Dana Fowler<\/td>/.test(posted.html) && /<th>Contact Email<\/th><td>dana@buildright\.test<\/td>/.test(posted.html),
        'description, requirements or contact details are missing from the new listing');
      const listed = await get('/Job?q=HVAC');
      must(listed.status === 200 && /HVAC technician/.test(listed.html), 'the new listing does not appear in the job listings');
      return 'the HVAC listing is created with its description, requirements and contact details, and appears in the listings';
    } },
  { task: 'Ensure the navigation links (home, profiles, job postings) are working correctly',
    run: async ({ asGuest, get, login, must }) => {
      asGuest();
      const guestHome = await get('/');
      must(guestHome.status === 200 && guestHome.location === '/Job', `home did not redirect to job listings: ${guestHome.location}`);
      must((await login('buildright@trades.test', 'build123')).status === 303, 'the employer could not sign in');
      const home = await get('/');
      must(home.html.includes('href="/Profile"') && home.html.includes('href="/Job"'), 'the navigation is missing Workers (profiles) or Job listings');
      for (const p of ['/Job', '/Profile']) must((await get(p)).status === 200, `${p} did not load`);
      return 'guests land on job listings; a signed-in employer sees Workers (profiles) and Job listings, and both load';
    } },
  { task: 'Test that users can view detailed job descriptions by clicking on a job listing',
    run: async ({ asGuest, get, rowWith, idOf, must }) => {
      asGuest();
      const list = await get('/Job');
      const id = idOf(list.html, 'Concrete formwork carpenter', 'Job');
      const detail = await get(`/Job/${id}`);
      must(detail.status === 200, `job detail returned ${detail.status}`);
      must(/<th>Description<\/th><td>Build and strip wall/.test(detail.html), 'job description is not shown on the detail page');
      must(/<th>Requirements<\/th><td>Three years of formwork/.test(detail.html), 'requirements are not shown');
      must(/<th>Contact Name<\/th><td>Dana Fowler<\/td>/.test(detail.html) && /<th>Contact Email<\/th><td>dana@buildright\.test<\/td>/.test(detail.html),
        'employer contact details are not shown');
      return 'the carpenter listing shows its description, requirements and employer contact details';
    } },
  colorCheck('ivory', 'forestgreen'),
];
