// WebGen-Bench 000087 — entertainment directory: band + advertiser registration, login, media links, ads.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Verify band registration form functionality.',
    run: async ({ asGuest, get, follow, must, flashOf }) => {
      asGuest();
      const form = await get('/register');
      must(/name="name"/.test(form.html) && /name="email"/.test(form.html) && !/name="role"/.test(form.html),
        'registration form should ask for name and email, and never let the visitor pick a role');
      const r = await follow('/register', { name: 'The Wandering Echoes', email: 'echoes@bands.test', password: 'echoes123', bio: 'A four-piece folk-rock band from Austin.', contact: 'contact@wanderingechoes.test' });
      must(r.status === 200, `registration did not complete: ${r.status}`);
      must(!/error|invalid/i.test(flashOf(r.html) || ''), `registration produced an error: ${flashOf(r.html)}`);
      return 'band registered with name, bio and contact information, no error';
    } },
  { task: 'Test band login functionality.',
    run: async ({ asGuest, login, must }) => {
      asGuest();
      const ok = await login('echoes@bands.test', 'echoes123');
      must(ok.status === 303, `valid band credentials were rejected: ${ok.status}`);
      asGuest();
      const bad = await login('echoes@bands.test', 'wrong-password');
      must(bad.status === 401, `invalid credentials should be rejected with an error, got ${bad.status}`);
      must(/invalid|incorrect|wrong/i.test(bad.html), 'wrong password should show an error message');
      return 'valid band credentials sign in (303); wrong password is rejected with an error (401)';
    } },
  { task: 'Check the ability for band members to provide a profile picture link.',
    run: async ({ asGuest, upload, get, idOf, must, flashOf }) => {
      asGuest();
      // Registers through /register (roles.register fixes role "band"), not
      // the generic /User/new — that route is reserved for advertiser
      // sign-up (see "Assess the registration form..." below), now that
      // User.form.fill forces role "advertiser" there.
      const r = await upload('/register', { name: 'Paper Moon Trio', email: 'papermoon@bands.test', password: 'paper123', bio: 'Jazz trio.', contact: 'papermoon@bands.test' },
        { field: 'photo', name: 'band.jpg', content: 'fake-jpeg-bytes-for-band-photo' });
      must(r.status === 303, `band signup with a photo failed: ${r.status}: ${r.html.slice(0, 200)}`);
      const list = await get('/list/bands');
      const id = idOf(list.html, 'Paper Moon Trio', 'User');
      const detail = await get(`/User/${id}`);
      must(detail.status === 200 && /<img[^>]+src="\/file\/User\/\d+\/photo(?:\?[^"]*)?"/.test(detail.html), 'the uploaded photo is not shown on the band profile');
      return `band #${id} profile shows the uploaded photo as an image`;
    } },
  { task: 'Validate the upload of audio sample links by band members.',
    run: async ({ asGuest, get, idOf, must }) => {
      asGuest();
      const list = await get('/list/bands');
      const id = idOf(list.html, 'The Midnight Owls', 'User');
      const detail = await get(`/User/${id}`);
      must(detail.status === 200 && /https:\/\/audio\.example\.test\/midnight-owls-demo\.mp3/.test(detail.html), 'the audio sample link is not shown on the band profile');
      return `band #${id} profile shows its audio sample link`;
    } },
  { task: 'Confirm functionality for band members to add YouTube video links.',
    run: async ({ asGuest, get, idOf, must }) => {
      asGuest();
      const list = await get('/list/bands');
      const id = idOf(list.html, 'The Midnight Owls', 'User');
      const detail = await get(`/User/${id}`);
      must(detail.status === 200 && /https:\/\/youtube\.com\/watch\?v=example1/.test(detail.html), 'the YouTube link is not shown on the band profile');
      return `band #${id} profile shows its YouTube video link`;
    } },
  { task: 'Assess the registration form functionality for advertisers.',
    run: async ({ asGuest, get, post, must, flashOf }) => {
      asGuest();
      const form = await get('/User/new');
      must(/name="name"/.test(form.html) && /name="email"/.test(form.html) && !/name="role"/.test(form.html),
        'advertiser signup form is missing name or email, or lets the visitor pick a role');
      const posted = await post('/User', { name: 'BrightAd Media', email: 'brightad@bands.test', password: 'bright123' });
      // User.form.fill forces role "advertiser" on this route, regardless of
      // what (if anything) a client sends for it — closing a real gap: this
      // route used to leave every /User/new signup on the field's plain
      // default ("band"), so an "advertiser" never actually got that role.
      must(posted.status === 303, `advertiser registration did not complete: ${posted.status}: ${posted.html.slice(0, 200)}`);
      const r = await get(posted.location);
      must(!/error|invalid/i.test(flashOf(r.html) || ''), `advertiser registration produced an error: ${flashOf(r.html)}`);
      return 'advertiser registered via the sign-up form, no error, no way to self-assign a role';
    } },
  { task: 'Evaluate login functionality for advertisers.',
    run: async ({ asGuest, login, get, post, must } ) => {
      asGuest();
      const ok = await login('brightad@bands.test', 'bright123');
      must(ok.status === 303, `valid advertiser credentials were rejected: ${ok.status}`);
      const placed = await post('/Ad', { title: 'Summer concert series — tickets now open', linkUrl: 'https://brightad.test/summer' });
      must(placed.status === 303, `advertiser could not place an ad (role must actually be "advertiser"): ${placed.status}: ${placed.html.slice(0, 200)}`);
      const ads = await get('/Ad');
      must(/Summer concert series/.test(ads.html), 'the placed ad is not shown in the public ad list');
      asGuest();
      const bad = await login('brightad@bands.test', 'wrong-password');
      must(bad.status === 401 && /invalid|incorrect|wrong/i.test(bad.html), 'wrong advertiser password should show an error message');
      return 'advertiser signs in, genuinely places an ad (role "advertiser" grants do:create on Ad), and a bad password is rejected with an error';
    } },
  colorCheck('floralwhite', 'darkgoldenrod'),
];
