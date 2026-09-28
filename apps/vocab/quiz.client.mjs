// Browser side of the vocabquiz widget, served at /widget/vocabquiz.mjs. One
// module renders all five activity kinds (the "kind" prop switches
// rendering); every kind posts its own {wordId, ...} answers as one JSON
// array to the single global action /action/submitQuiz, graded by
// plugins/vocab.mjs's vocab.grade block — the widget never grades itself.
import { api, mountWidgets } from '/widget/_api.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TITLES = { matching: 'Synonyms & Antonyms', fillblank: 'Fill in the Blank', unjumble: 'Unjumble the Letters', crossword: 'Mini Crossword', flashcard: 'Flashcards' };

export default function mount(el, { props, api: a }) {
  const kind = props.kind;
  const state = { wordSet: null, words: [], flashIdx: 0, flashKnown: [], result: '' };

  async function load() {
    const sets = (await a.get('/WordSet')).rows;
    if (!sets.length) { el.innerHTML = '<p data-empty>No word sets published yet.</p>'; return; }
    state.wordSet = sets.reduce((m, s) => (s.week > m.week ? s : m), sets[0]);
    const words = (await a.get(`/Word?wordSet=${state.wordSet.id}`)).rows;
    state.words = kind === 'crossword' ? words.filter((w) => w.inCrossword).sort((x, y) => x.crosswordNum - y.crosswordNum) : words;
    render();
  }

  function itemHtml(w) {
    if (kind === 'matching') return `<div data-qword="${w.id}" style="margin-bottom:10px">
      <strong>${esc(w.term)}</strong>
      <label>Synonym <input data-field="synonym"></label>
      <label>Antonym <input data-field="antonym"></label>
    </div>`;
    if (kind === 'fillblank') return `<div data-qword="${w.id}" style="margin-bottom:10px"><p>${esc(w.sentence)}</p><input data-field="value"></div>`;
    if (kind === 'unjumble') return `<div data-qword="${w.id}" style="margin-bottom:10px"><p>Scrambled: <b>${esc(w.scrambled)}</b></p><input data-field="value"></div>`;
    return `<div data-qword="${w.id}" style="margin-bottom:10px"><p>${w.crosswordNum}. ${esc(w.definition)}</p>
      <input data-field="value" maxlength="${w.term.length + 2}" style="letter-spacing:4px;font-family:monospace"></div>`;
  }

  function collect() {
    const out = [];
    for (const g of el.querySelectorAll('[data-qword]')) {
      const wordId = Number(g.dataset.qword);
      if (kind === 'matching') {
        out.push({ wordId, type: 'synonym', value: g.querySelector('[data-field="synonym"]').value });
        out.push({ wordId, type: 'antonym', value: g.querySelector('[data-field="antonym"]').value });
      } else {
        out.push({ wordId, value: g.querySelector('[data-field="value"]').value });
      }
    }
    return out;
  }

  async function submit(answers) {
    const res = await a.post('/action/submitQuiz', { kind, wordSet: state.wordSet.id, answers: JSON.stringify(answers) });
    state.result = res.ok ? res.flash : (res.errors?.[0] || 'Could not grade this attempt');
    render();
  }

  function renderFlash() {
    const w = state.words[state.flashIdx];
    if (!w) {
      el.innerHTML = `<h4>${TITLES.flashcard} — Week ${state.wordSet.week} — done</h4>
        <button type="button" data-submit-flash>Submit</button><p data-result>${esc(state.result)}</p>`;
      el.querySelector('[data-submit-flash]').addEventListener('click', () => {
        submit(state.words.map((word, i) => ({ wordId: word.id, knew: !!state.flashKnown[i] })));
      });
      return;
    }
    el.innerHTML = `<h4>${TITLES.flashcard} — Week ${state.wordSet.week} (${state.flashIdx + 1}/${state.words.length})</h4>
      <div data-card style="border:1px solid #999;padding:16px;min-width:220px;text-align:center">
        <p><b data-term style="font-size:20px">${esc(w.term)}</b></p>
        <p data-def style="display:none">${esc(w.definition)}</p>
      </div>
      <button type="button" data-flip>Flip</button>
      <button type="button" data-knew="1">I knew it</button>
      <button type="button" data-knew="0">Didn't know</button>`;
    el.querySelector('[data-flip]').addEventListener('click', () => {
      const d = el.querySelector('[data-def]');
      d.style.display = d.style.display === 'none' ? 'block' : 'none';
    });
    for (const btn of el.querySelectorAll('[data-knew]')) {
      btn.addEventListener('click', () => { state.flashKnown[state.flashIdx] = btn.dataset.knew === '1'; state.flashIdx++; renderFlash(); });
    }
  }

  function render() {
    if (kind === 'flashcard') { renderFlash(); return; }
    el.innerHTML = `<h4>${TITLES[kind]} — Week ${state.wordSet.week}</h4>
      <form data-quiz-form>${state.words.map(itemHtml).join('')}<button type="submit">Submit</button></form>
      <p data-result>${esc(state.result)}</p>`;
    el.querySelector('[data-quiz-form]').addEventListener('submit', (ev) => { ev.preventDefault(); submit(collect()); });
  }

  load();
}
mountWidgets('vocabquiz', mount);
