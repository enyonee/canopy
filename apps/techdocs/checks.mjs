// webgen-bench/000030 — a technical library: articles, solutions underneath them, discussion.
// One check per ui_instruct case, in the task's order.
import { colorCheck } from '../../verify/lib.mjs';

const ARTICLE = 'Zero-downtime Kubernetes rollouts';
const NEW_SOLUTION = 'Freeze the image tag before the rollout';
let samSolutionId = null, articleComments = 2, articleSolutions = 2;

// The slice of a detail page that belongs to one related table.
const section = (html, heading) => {
  const start = html.indexOf(`<h3>${heading}</h3>`);
  if (start < 0) return '';
  const rest = html.slice(start + heading.length + 9);
  const end = rest.indexOf('<h3>');
  return end < 0 ? rest : rest.slice(0, end);
};
const countOf = (html) => { const m = /(\d+) item\(s\)/.exec(html); return m ? Number(m[1]) : null; };
const solutionIdIn = (row) => { const m = /\/Solution\/(\d+)\/action\/upvote/.exec(row || ''); return m ? m[1] : null; };

export const checks = [
  { task: 'Navigate to the technical articles section using the main navigation menu.',
    run: async ({ asGuest, get, rows, rowWith, must }) => {
      asGuest();
      const home = await get('/');
      must(home.location === '/Article', `the root does not lead to the articles section: ${home.location}`);
      const nav = /<nav>([\s\S]*?)<\/nav>/.exec(home.html)[1];
      const items = [...nav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => ({ href: m[1], label: m[2] }))
        .filter((i) => !['/login', '/register'].includes(i.href));
      must(items.length === 4, `expected 4 menu items for a visitor, got ${items.length}: ${items.map((i) => i.label).join(', ')}`);
      const articles = items.find((i) => i.label === 'Technical articles');
      must(articles && articles.href === '/Article', `no "Technical articles" menu item: ${items.map((i) => `${i.label}→${i.href}`).join(', ')}`);
      for (const i of items) must((await get(i.href)).status === 200, `menu item ${i.label} (${i.href}) is broken`);
      const list = await get(articles.href);
      must(/<th>(?:<a[^>]*>)?Title/.test(list.html) && /<th>(?:<a[^>]*>)?Topic/.test(list.html)
        && /<th>(?:<a[^>]*>)?Solutions/.test(list.html) && /<th>(?:<a[^>]*>)?Verified Solutions/.test(list.html), 'the article table is missing columns');
      must(rows(list.html).length === 5 && countOf(list.html) === 5, `expected 5 published articles, got ${rows(list.html).length} / ${countOf(list.html)}`);
      must(rows(list.html)[0].includes('Rootless containers: what breaks and why'), `newest article is not first: ${rows(list.html)[0].slice(0, 100)}`);
      must(!rowWith(list.html, 'Sharding strategies for time-series data'), 'a draft article is listed in the public section');
      must(!rowWith(list.html, 'Connection pooling without a pooler'), 'an article still in review is listed in the public section');
      const kube = rowWith(list.html, ARTICLE);
      must(kube && /<a href="\/Topic\/1">Containers<\/a>/.test(kube) && /<td>2<\/td><td>1<\/td><td>2<\/td>/.test(kube), `derived solution / verified / comment counts wrong: ${kube}`);
      const containers = await get('/Article?topic=1');
      must(rows(containers.html).length === 2, `the topic filter does not narrow: ${rows(containers.html).length}`);
      return '4 menu items all 200; "Technical articles" → 5 published rows, draft and in-review hidden, topic filter narrows to 2';
    } },

  { task: 'Use the search functionality to find a specific technical topic.',
    run: async ({ asGuest, get, rows, rowWith, must }) => {
      asGuest();
      const hit = await get('/Article?q=kubernetes');
      must(rows(hit.html).length === 1 && countOf(hit.html) === 1 && rowWith(hit.html, ARTICLE), `search for "kubernetes" returned ${rows(hit.html).length} rows`);
      const inBody = await get('/Article?q=MTU');
      must(rows(inBody.html).length === 1 && rowWith(inBody.html, 'Diagnosing TCP retransmissions with tcpdump'),
        `search does not reach the article body: ${rows(inBody.html).length} rows for "MTU"`);
      const vacuum = await get('/Article?q=autovacuum');
      must(rows(vacuum.html).length === 1 && rowWith(vacuum.html, 'Tuning PostgreSQL autovacuum on write-heavy tables'), 'search for "autovacuum" missed its article');
      const none = await get('/Article?q=quantum');
      must(rows(none.html).length === 0 && countOf(none.html) === 0, `a nonsense query returned ${rows(none.html).length} rows`);
      const draft = await get('/Article?q=sharding');
      must(rows(draft.html).length === 0, 'search reaches unpublished drafts');
      const sol = await get('/Solution?q=subuid');
      must(rows(sol.html).length === 1 && rowWith(sol.html, 'Map the subuid ranges before the build'), `searching solutions returned ${rows(sol.html).length} rows`);
      const verified = await get('/Solution?verified=1');
      must(rows(verified.html).length === 2, `the verified filter returned ${rows(verified.html).length} rows, expected 2`);
      return 'title, body and summary searched: kubernetes→1, MTU→1, autovacuum→1, quantum→0, drafts excluded; solutions searched and filtered';
    } },

  { task: 'Open a technical article and verify its content.',
    run: async ({ asGuest, get, post, follow, rows, rowWith, must, flashOf }) => {
      asGuest();
      const list = await get('/Article');
      const articleId = /\/Article\/(\d+)/.exec(rowWith(list.html, ARTICLE))[1];
      let detail = await get(`/Article/${articleId}`);
      must(detail.status === 200, `the article returned ${detail.status}`);
      must(new RegExp(`<th>Title</th><td>${ARTICLE}</td>`).test(detail.html), 'the article page does not show its title');
      must(/<th>Summary<\/th><td>Rolling updates that never drop a request/.test(detail.html), 'the summary is missing');
      must(/<th>Body<\/th><td>A Deployment reports Progressing[\s\S]*maxUnavailable to 0[\s\S]*PodDisruptionBudget/.test(detail.html), 'the body is not the full technical text');
      must(/<th>Topic<\/th><td><a href="\/Topic\/1">Containers<\/a>/.test(detail.html), 'the topic is not shown as a link');
      must(/<th>Author<\/th><td><a href="\/User\/1">admin@techdocs.test<\/a>/.test(detail.html), 'the author is missing');
      must(/<th>Status<\/th><td><span class="status">Published<\/span>/.test(detail.html), 'the status is not Published');
      must(/<th>Solutions<\/th><td>2<\/td>/.test(detail.html) && /<th>Verified Solutions<\/th><td>1<\/td>/.test(detail.html)
        && /<th>Comments<\/th><td>2<\/td>/.test(detail.html) && /<th>Top Score<\/th><td>4<\/td>/.test(detail.html), 'the derived counters are wrong');
      const sols = section(detail.html, 'Solutions');
      must(rows(sols).length === 2 && countOf(sols) === 2, `expected 2 solutions under the article, got ${rows(sols).length}`);
      const gate = rowWith(sols, 'Gate the rollout on a real readiness probe');
      must(gate && /readinessProbe at \/healthz/.test(gate) && /<td>Yes<\/td><td>4<\/td>/.test(gate), `the verified top solution row is wrong: ${gate && gate.slice(0, 160)}`);
      must(rowWith(sols, 'Drain connections with a preStop hook'), 'the second solution is missing');
      const talk = section(detail.html, 'Discussion');
      must(rows(talk).length === 2 && rowWith(talk, 'The preStop hook was the piece we were missing all along.'), `expected 2 comments, got ${rows(talk).length}`);
      must(!/Post solution/.test(detail.html) && !/Post comment/.test(detail.html), 'a visitor without an account is offered the posting forms');

      const reg = await post('/register', { email: 'sam@techdocs.test', password: 'sam123', name: 'Sam' });
      must(reg.status === 303, `register returned ${reg.status}: ${reg.html.slice(0, 200)}`);
      const short = await post(`/Article/${articleId}/add/Solution`, { headline: 'Too thin', steps: 'Just restart it' });
      must(short.status === 400 && /at least 20 characters/.test(short.html), 'a solution with no detail was accepted');
      const posted = await post(`/Article/${articleId}/add/Solution`, { headline: NEW_SOLUTION,
        steps: 'Resolve the tag to a digest in CI and deploy the digest, so a re-pull during the rollout cannot bring up a different image than the one that was tested.' });
      must(posted.status === 303, `posting a solution returned ${posted.status}: ${posted.html.slice(0, 200)}`);
      detail = await get(posted.location);
      must(/Your solution has been posted/.test(flashOf(detail.html)), `flash: ${flashOf(detail.html)}`);
      must(/<th>Solutions<\/th><td>3<\/td>/.test(detail.html) && /<th>Verified Solutions<\/th><td>1<\/td>/.test(detail.html), 'the solution counters did not follow');
      articleSolutions = 3;
      const mine = rowWith(section(detail.html, 'Solutions'), NEW_SOLUTION);
      must(mine && /sam@techdocs.test/.test(mine) && /<td>No<\/td><td>0<\/td>/.test(mine), `the new solution row is wrong: ${mine && mine.slice(0, 160)}`);
      samSolutionId = solutionIdIn(mine);
      must(samSolutionId, 'the new solution offers no feedback button to a member');
      must(!/action\/verify/.test(mine), 'a member is offered to verify a solution');
      const voted = await follow(`/Solution/${samSolutionId}/action/upvote`, {});
      must(/your feedback was recorded/i.test(flashOf(voted.html)), `flash after the vote: ${flashOf(voted.html)}`);
      must(/<td>No<\/td><td>1<\/td>/.test(rowWith(section(voted.html, 'Solutions'), NEW_SOLUTION)), 'the score did not go up');
      must((await post(`/Solution/${samSolutionId}/action/verify`, {})).status === 403, 'a member could verify a solution');

      const tooShort = await post(`/Article/${articleId}/add/Comment`, { body: 'ok' });
      must(tooShort.status === 400 && /at least 5 characters/.test(tooShort.html), 'a two-letter comment was accepted');
      const said = await follow(`/Article/${articleId}/add/Comment`, { body: 'Pinning the digest closed a whole class of surprises for us.' });
      must(/Your comment has been posted/.test(flashOf(said.html)), `flash: ${flashOf(said.html)}`);
      must(/<th>Comments<\/th><td>3<\/td>/.test(said.html), 'the comment count did not follow');
      articleComments = 3;
      must(rows(section(said.html, 'Discussion')).length === 3, 'the new comment is not in the discussion');
      must((await get('/Article/new')).status === 403, 'a member opened the article form');
      return 'title, summary, full body, topic, author, status and 4 derived counters verified; 2 solutions + 2 comments shown; member added a solution (rule 400) and a comment, voted 0→1, refused verify and article writing';
    } },

  colorCheck('lavender', 'indigo'),
];

export const changes = [
  { title: 'editor role: publishes and curates, writes nothing', patch: 'change-1-role.patch.json', checks: [
    { task: 'An editor moves an article from review to published, verifies a solution and prunes the discussion, but cannot write or reach the admin surfaces',
      run: async ({ asGuest, login, get, post, follow, rows, rowWith, must, flashOf }) => {
        must((await login('admin@techdocs.test', 'admin123')).status === 303, 'admin could not log in');
        const made = await post('/User', { email: 'eli@techdocs.test', password: 'eli123', name: 'Eli', role: 'editor' });
        must(made.status === 303, `creating the editor returned ${made.status}: ${made.html.slice(0, 200)}`);
        asGuest();
        must((await login('eli@techdocs.test', 'eli123')).status === 303, 'the editor could not log in');

        let list = await get('/Article');
        must(rows(list.html).length === 5, `the editor sees ${rows(list.html).length} published articles, expected 5`);
        must(!/href="\/Article\/new"/.test(list.html), 'the editor is offered to write an article');
        must((await get('/Article/new')).status === 403, 'the editor opened the article form');
        must((await post('/Article', { title: 'Sneaking an article in', topic: 1, summary: 'x', body: 'y' })).status === 403, 'the editor wrote an article');
        must((await post('/Article/1/add/Solution', { headline: 'Mine now', steps: 'A perfectly long enough sentence for the rule.' })).status === 403, 'the editor posted a solution');
        must((await post('/Article/1/add/Comment', { body: 'Joining in' })).status === 403, 'the editor posted a comment');

        const review = await get('/Article/7');
        must(/<th>Status<\/th><td><span class="status">Review<\/span>/.test(review.html), 'article 7 is not waiting for review');
        must((await post('/Article/6/go/submit', {})).status === 403, 'the editor ran a transition it was not granted');
        const published = await follow('/Article/7/go/publish', {});
        must(/is published/.test(flashOf(published.html)), `flash after publishing: ${flashOf(published.html)}`);
        must(/<th>Status<\/th><td><span class="status">Published<\/span>/.test(published.html), 'the article did not become published');
        must((await post('/Article/7/go/publish', {})).status === 409, 'publishing twice was not refused');
        list = await get('/Article');
        must(rows(list.html).length === 6 && rowWith(list.html, 'Connection pooling without a pooler'), `after publishing the list has ${rows(list.html).length} rows, expected 6`);
        await follow('/Article/7/go/retract', {});
        list = await get('/Article');
        must(rows(list.html).length === 5 && !rowWith(list.html, 'Connection pooling without a pooler'), 'unpublishing did not take the article back out of the section');

        must((await post('/Solution/1/action/upvote', {})).status === 403, 'the editor voted on a solution');
        const verified = await follow('/Solution/2/action/verify', {});
        must(/verification updated/.test(flashOf(verified.html)), `flash after verifying: ${flashOf(verified.html)}`);
        must(/<th>Verified Solutions<\/th><td>2<\/td>/.test(verified.html) && new RegExp(`<th>Solutions</th><td>${articleSolutions}</td>`).test(verified.html),
          'verifying did not move the article counters');
        const del = await post('/Comment/1/delete', {});
        must(del.status === 303, `deleting a comment returned ${del.status}`);
        const after = await get('/Article/1');
        must(new RegExp(`<th>Comments</th><td>${articleComments - 1}</td>`).test(after.html)
          && !rowWith(after.html, 'The preStop hook was the piece we were missing all along.'), 'the comment was not removed');

        must((await get('/User')).status === 403, 'the editor listed the users');
        must((await get('/dashboard/library')).status === 403, 'the editor opened the dashboard');
        must((await get('/outbox')).status === 403, 'the editor opened the outbox');
        must((await get('/list/all-articles')).status === 403, "the editor opened the admin's editorial queue");
        return 'editor: publish review→published (list 5→6), 409 on repeat, retract back to 5, go:submit refused, solution verified (1→2), comment deleted; write, users, dashboard, outbox, queue all 403';
      } },
  ] },
];
