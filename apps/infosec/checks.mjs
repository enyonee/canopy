// WebGen-Bench 000055 — Global Institute of Information Security course site.
// One check per ui_instruct case. No login anywhere in the brief, so every check runs as a guest.
import { colorCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Navigate to the course catalog page',
    run: async ({ get, rows, must }) => {
      const r = await get('/Course');
      must(r.status === 200, `course catalogue returned ${r.status}`);
      const list = rows(r.html);
      must(list.length === 3, `expected 3 courses, got ${list.length}`);
      must(/Certified Ethical Hacking Foundations/.test(r.html) && /Network Security Analyst/.test(r.html) && /Advanced Penetration Testing/.test(r.html),
        'not all seeded course titles are shown');
      must(/An entry-level course covering the attacker mindset/.test(r.html), 'course descriptions are not shown');
      must(/Open Batches/.test(r.html) && /<td>2<\/td>/.test(list.find((x) => x.includes('Foundations')) || ''),
        'available batches are not shown in the catalogue');
      return '3 courses with titles, descriptions and open-batch counts';
    } },

  { task: 'Click on a course from the course catalog to view details',
    run: async ({ get, idOf, must }) => {
      const list = await get('/Course');
      const id = idOf(list.html, 'Network Security Analyst', 'Course');
      const d = await get(`/Course/${id}`);
      must(d.status === 200, `course detail returned ${d.status}`);
      must(/<th>Syllabus<\/th><td>Week 1: TCP\/IP security review/.test(d.html), 'the syllabus is not shown on the course detail page');
      must(/Institute Campus, Block C/.test(d.html) && /2026-10-12/.test(d.html), 'batch scheduling is not shown on the course detail page');
      must(/<th>Certification<\/th><td>Graduates sit the Network Security Analyst \(NSA\) certification exam/.test(d.html),
        'the certification pathway is not shown on the course detail page');
      return 'syllabus, batch schedule and certification pathway all shown on the course detail page';
    } },

  { task: 'Test the online enrollment functionality by attempting to enroll in a course',
    run: async ({ get, follow, idOf, must, flashOf }) => {
      const list = await get('/Course');
      const id = idOf(list.html, 'Certified Ethical Hacking Foundations', 'Course');
      const detail = await get(`/Course/${id}`);
      must(/Enrol now/.test(detail.html) && /name="email"/.test(detail.html), 'no enrollment form on the course page');
      const enrolled = await follow(`/Course/${id}/add/Enrollment`, { batch: '1', name: 'Priya Shah', email: 'priya@example.test', phone: '555-0100' });
      must(/You are enrolled/.test(flashOf(enrolled.html)), `no confirmation after enrolling: ${flashOf(enrolled.html)}`);
      must(/<th>Enrolled<\/th><td>1<\/td>/.test(enrolled.html), 'the course does not count the new enrollment');
      const outbox = await get('/outbox');
      must(/priya@example.test/.test(outbox.html) && /You are enrolled: Certified Ethical Hacking Foundations/.test(outbox.html),
        'no confirmation email was queued');
      return 'enrolled successfully; enrollment count 0 → 1; a confirmation email queued for priya@example.test';
    } },

  { task: 'Check the chatbot integration functionality by initiating a chat session',
    run: async ({ post, get, follow, must, flashOf, rows }) => {
      const created = await post('/Chat', { title: 'Visitor chat' });
      must(created.status === 303, `starting a chat returned ${created.status}`);
      const chatPath = created.location.split('?')[0];
      const started = await get(created.location);
      must(/Conversation started/.test(flashOf(started.html)), `no confirmation starting a chat: ${flashOf(started.html)}`);
      const courses = await follow(`${chatPath}/add/Message`, { text: 'What courses do you offer?' });
      must(/three programmes: Certified Ethical Hacking Foundations/.test(courses.html), 'the chatbot did not answer about courses');
      const timetables = await follow(`${chatPath}/add/Message`, { text: 'What are your batch timetables?' });
      must(/Foundations runs online starting 2026-10-05/.test(timetables.html), 'the chatbot did not answer about timetables');
      const enroll = await follow(`${chatPath}/add/Message`, { text: 'How do I enrol?' });
      must(/use the Enrol form on the course page/.test(enroll.html), 'the chatbot did not answer about enrolling');
      const nonsense = await follow(`${chatPath}/add/Message`, { text: 'zzqxwlfk' });
      must(/Sorry, I do not have an answer/.test(nonsense.html), 'the chatbot fabricated an answer for a question outside its data');
      const turns = rows(nonsense.html).filter((r) => r.startsWith('<td>'));
      must(turns.length === 4, `the conversation does not hold all four turns: got ${turns.length}`);
      return 'chatbot answered courses, timetables and enrollment from the FAQ data; a fallback for the unmatched question';
    } },

  { task: 'Access and fill out the contact form',
    run: async ({ follow, get, must, flashOf, rowWith }) => {
      const sent = await follow('/Contact', { name: 'Bo Nilsen', email: 'bo@example.test', message: 'Do you offer group discounts for the Network Security Analyst course?' });
      must(/your message has been received/.test(flashOf(sent.html)), `no acknowledgment after the contact form: ${flashOf(sent.html)}`);
      const row = rowWith(sent.html, 'Bo Nilsen');
      must(row && /bo@example\.test/.test(row) && /group discounts/.test(row), `the message is not recorded: ${row}`);
      return 'contact message from Bo Nilsen recorded with name, email and message';
    } },

  { task: 'Validate the content on the certification pathways section',
    run: async ({ get, must }) => {
      const page = await get('/page/pathways');
      must(page.status === 200, `certification pathways page returned ${page.status}`);
      must(/CEHF badge/.test(page.html) && /NSA credential/.test(page.html) && /Certified Ethical Hacker Professional \(CEHP\)/.test(page.html),
        'the pathways overview does not mention all three credentials');
      must(/href="\/Course\/1"/.test(page.html) && /href="\/Course\/2"/.test(page.html) && /href="\/Course\/3"/.test(page.html),
        'the pathways page does not link to the courses it describes');
      const course = await get('/Course/1');
      must(/CEHF Foundation Badge/.test(course.html), 'the per-course certification text is not shown on the course itself (not data-driven)');
      return 'certification overview names all three credentials and links to their courses; each course also carries its own certification field';
    } },

  colorCheck('lavender', 'indigo'),
];
