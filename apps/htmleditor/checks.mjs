// webgen-bench/000081 — HTML editor: Project/Document/Image rows, a widget
// (plugins/htmleditor.mjs's htmleditor) that is the code editor: code/text
// mode toggle, live sandboxed preview, client-side syntax highlighting.
import { openBrowser } from '../../verify/browser.mjs';
import { colorCheck } from '../../verify/lib.mjs';

const jsonGet = async (base, path) => { const r = await fetch(base + path, { headers: { accept: 'application/json' } }); return { status: r.status, body: await r.json() }; };

export const checks = [
  { task: 'Open the HTML editor and switch between HTML code mode and text editing mode',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Document/1`);
      try {
        await b.until(`document.querySelector('[data-html-input]')`);
        const original = await b.eval(`document.querySelector('[data-html-input]').value`);
        must(/<h1>Welcome<\/h1>/.test(original), `code mode does not show the stored content: ${original}`);
        await b.eval(`document.querySelector('[data-mode-btn="text"]').click()`);
        await b.until(`document.querySelector('[data-text-input]')`);
        const text = await b.eval(`document.querySelector('[data-text-input]').value`);
        must(text.includes('Welcome') && text.includes('We build things people love.') && !/<h1>/.test(text),
          `text mode did not derive plain text correctly: ${JSON.stringify(text)}`);
        await b.eval(`document.querySelector('[data-mode-btn="code"]').click()`);
        await b.until(`document.querySelector('[data-html-input]')`);
        const backToCode = await b.eval(`document.querySelector('[data-html-input]').value`);
        must(backToCode === original, `switching modes without converting lost or changed the HTML: ${backToCode}`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return 'code -> text (plain, tag-free) -> code round-trips the original HTML unchanged';
    } },
  { task: 'Enter HTML code in the editor and view the live preview of the content',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Document/2`);
      try {
        await b.until(`document.querySelector('[data-preview]') && document.querySelector('[data-preview]').contentDocument.body.innerHTML.includes('About us')`);
        await b.eval(`(() => { const t = document.querySelector('[data-html-input]'); t.value = '<h2>Live!</h2><p>Typed just now.</p>'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await b.until(`document.querySelector('[data-preview]').contentDocument.body.innerHTML.includes('Typed just now.')`);
        const heading = await b.eval(`document.querySelector('[data-preview]').contentDocument.querySelector('h2').textContent`);
        must(heading === 'Live!', `the preview iframe did not render the new heading: ${heading}`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return 'typing new HTML immediately re-renders the sandboxed preview iframe';
    } },
  { task: 'Enable syntax highlighting within the HTML editor while editing a code file',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Document/1`);
      try {
        await b.until(`document.querySelector('[data-highlight] .tok-tag')`);
        const tagColor = await b.eval(`getComputedStyle(document.querySelector('[data-highlight] .tok-tag')).color`);
        const attrColor = await b.eval(`document.querySelector('[data-highlight] .tok-attr') && getComputedStyle(document.querySelector('[data-highlight] .tok-attr')).color`);
        const strColor = await b.eval(`document.querySelector('[data-highlight] .tok-str') && getComputedStyle(document.querySelector('[data-highlight] .tok-str')).color`);
        must(tagColor && attrColor && strColor, `expected tag, attribute and string tokens to all be present: tag=${tagColor} attr=${attrColor} str=${strColor}`);
        must(tagColor !== attrColor && attrColor !== strColor && tagColor !== strColor, `tokens are not visually distinct: ${tagColor} / ${attrColor} / ${strColor}`);
        const commentPresent = await b.eval(`!!document.querySelector('[data-highlight] .tok-comment')`);
        must(commentPresent, 'the HTML comment in the seed content was not tokenised');
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      return 'tag, attribute, string and comment tokens each render in a visibly distinct colour';
    } },
  { task: 'Save the current HTML document as a template page',
    run: async ({ base, must }) => {
      const b = await openBrowser(`${base}/Document/2`);
      try {
        await b.until(`document.querySelector('[data-html-input]')`);
        await b.eval(`(() => { const t = document.querySelector('[data-html-input]'); t.value = '<h1>About us</h1><p>Template body kept intact.</p>'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await b.eval(`document.querySelector('[data-template]').click()`);
        await b.until(`document.querySelector('[data-status]').textContent === 'Saved as template'`);
        must(!b.errors.length, `page errors: ${b.errors.join('; ')}`);
      } finally { await b.close(); }
      const doc = await jsonGet(base, '/Document/2');
      must(doc.body.isTemplate === true || doc.body.isTemplate === 1, `document was not marked as a template: ${JSON.stringify(doc.body)}`);
      must(doc.body.content.includes('Template body kept intact.'), `the template lost its content: ${doc.body.content}`);
      const templates = await jsonGet(base, '/list/templates');
      const row = templates.body.rows.find((r) => r.id === 2);
      must(row, `document #2 does not appear under Templates: ${JSON.stringify(templates.body.rows)}`);
      return 'document #2 saved as a template, listed under Templates with its edited content intact';
    } },
  { task: 'Access the basic user guide from within the HTML editor interface',
    run: async ({ base, get, must }) => {
      const editor = await get('/Document/1');
      must(/href="\/page\/guide"/.test(editor.html), 'the editor page has no link to the guide');
      const guide = await get('/page/guide');
      must(guide.status === 200, `the guide page returned ${guide.status}`);
      must(/Using the HTML editor/.test(guide.html) && /Convert to HTML/.test(guide.html) && /Save as Template/.test(guide.html),
        'the guide does not cover the editor\'s own features');
      return 'a Help link on the editor page opens a guide that documents modes, conversion and templates';
    } },
  colorCheck('honeydew', 'darkolivegreen'),
];
