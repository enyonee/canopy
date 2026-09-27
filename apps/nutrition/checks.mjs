// webgen-bench/000063 — Canadian nutrition facts: search, analysis, packaging design.
import { colorCheck, navCheck } from '../../verify/lib.mjs';

export const checks = [
  { task: 'Search for "apple" using the product search function',
    run: async ({ get, rows, rowWith, must }) => {
      const { html, status } = await get('/Food?q=apple');
      must(status === 200, `search returned ${status}`);
      must(rows(html).length === 1, `expected 1 result for "apple", got ${rows(html).length}`);
      const row = rowWith(html, 'Apple');
      must(row && /<td>fruit<\/td>/.test(row) && /1 medium \(182 g\)/.test(row) && /<td>95<\/td>/.test(row), `apple row: ${row}`);
      const detail = await get('/Food/1');
      must(/<th>Serving Size<\/th><td>1 medium \(182 g\)<\/td>/.test(detail.html) && /<th>Calories<\/th><td>95<\/td>/.test(detail.html)
        && /<th>Sodium<\/th><td>2<\/td>/.test(detail.html) && /<th>Fiber<\/th><td>4<\/td>/.test(detail.html) && /<th>Protein<\/th><td>0<\/td>/.test(detail.html),
        `apple label: ${detail.html}`);
      return 'search for "apple" returns exactly the Apple label with full per-serving nutrition facts';
    } },

  { task: 'Enter "chicken, rice, broccoli" as ingredients with serving sizes into the nutrition analysis function',
    run: async ({ get, post, rows, must, flashOf }) => {
      const created = await post('/Analysis', {});
      must(created.status === 303, `starting an analysis returned ${created.status}: ${created.html.slice(0, 200)}`);
      const id = /\/Analysis\/(\d+)/.exec(created.location)[1];
      const started = await get(created.location);
      must(/Analysis started/.test(flashOf(started.html)), `flash: ${flashOf(started.html)}`);
      const chicken = await get('/Food?q=chicken'); const chickenId = /\/Food\/(\d+)/.exec(chicken.html)[1];
      const rice = await get('/Food?q=rice'); const riceId = /\/Food\/(\d+)/.exec(rice.html)[1];
      const broccoli = await get('/Food?q=broccoli'); const broccoliId = /\/Food\/(\d+)/.exec(broccoli.html)[1];
      await post(`/Analysis/${id}/add/AnalysisItem`, { food: chickenId, grams: 150 });
      await post(`/Analysis/${id}/add/AnalysisItem`, { food: riceId, grams: 200 });
      const r3 = await post(`/Analysis/${id}/add/AnalysisItem`, { food: broccoliId, grams: 100 });
      must(r3.status === 303, `adding an ingredient returned ${r3.status}: ${r3.html.slice(0, 200)}`);
      const detail = await get(`/Analysis/${id}`);
      const items = rows(detail.html).filter((r) => /\/AnalysisItem\//.test(r));
      must(items.length === 3, `expected 3 ingredient rows, got ${items.length}`);
      // 150g chicken (165 kcal/100g) + 200g rice (205 kcal/158g) + 100g broccoli (55 kcal/156g) = 542 kcal
      must(/<th>Total Calories<\/th><td>542<\/td>/.test(detail.html), `total calories: ${detail.html}`);
      must(/<th>Total Protein<\/th><td>54<\/td>/.test(detail.html), `total protein: ${detail.html}`);
      must(/<th>Items<\/th><td>3<\/td>/.test(detail.html), `item count: ${detail.html}`);
      return `analysis #${id}: chicken 150g + rice 200g + broccoli 100g = 542 kcal, 54 g protein, derived from the seeded per-serving facts`;
    } },

  { task: 'Use the packaging design function to initiate a new food package design',
    run: async ({ get, post, follow, must, flashOf }) => {
      const form = await get('/PackageDesign/new');
      must(form.status === 200 && /name="material"/.test(form.html) && /name="labelLanguage"/.test(form.html) && /name="allergenStatement"/.test(form.html),
        'the packaging design form is missing its Canadian compliance options');
      must(/plasticFilm|paperboard|glassJar|aluminumCan|flexiblePouch/.test(form.html), 'no material options offered');
      must(/bilingual|englishOnly|frenchOnly/.test(form.html), 'no label-language options offered');
      const r = await follow('/PackageDesign', { food: 1, material: 'glassJar', labelLanguage: 'bilingual', netQuantity: '200 g', allergenStatement: 'Contains no known allergens.' });
      must(/Packaging design started/.test(flashOf(r.html)), `flash: ${flashOf(r.html)}`);
      must(/<th>Material<\/th><td>glassJar<\/td>/.test(r.html) && /<th>Bilingual Compliant<\/th><td>Yes<\/td>/.test(r.html), `design page: ${r.html}`);
      return 'a new packaging design session opens with material, label-language and allergen-declaration compliance options';
    } },

  { task: 'Navigate to the nutrition analysis page and verify the presence of field labels and input boxes',
    run: async ({ get, post, must }) => {
      const created = await post('/Analysis', {});
      must(created.status === 303, `starting an analysis returned ${created.status}: ${created.html.slice(0, 200)}`);
      const id = /\/Analysis\/(\d+)/.exec(created.location)[1];
      const detail = await get(`/Analysis/${id}`);
      must(/<label[^>]*>Food(?:\s*\*)?<\/label>/.test(detail.html) && /<select[^>]*name="food"/.test(detail.html), 'no labelled Food input on the analysis page');
      must(/<label[^>]*>Grams(?:\s*\*)?<\/label>/.test(detail.html) && /<input[^>]*name="grams"/.test(detail.html), 'no labelled Grams input on the analysis page');
      return 'the ingredient add-form on the analysis page has labelled Food and Grams inputs';
    } },

  { task: 'Attempt to search for a non-existent food item like "xyz123" in the product search function',
    run: async ({ get, rows, must }) => {
      const { html, status } = await get('/Food?q=xyz123');
      must(status === 200, `search returned ${status}`);
      must(rows(html).length === 0, `expected no rows for "xyz123", got ${rows(html).length}`);
      must(/<p class="muted">0 item\(s\)/.test(html), 'the page does not tell the visitor that nothing matched');
      return 'searching "xyz123" returns zero rows and a "0 item(s)" notice, gracefully';
    } },

  navCheck(3),
  colorCheck('linen', 'maroon'),
];
