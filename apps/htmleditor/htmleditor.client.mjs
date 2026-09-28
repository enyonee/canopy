// Browser side of the HTML editor widget, served at /widget/htmleditor.mjs.
// Two independent buffers (html / text) so switching tabs never loses either
// version; only the explicit "Convert to HTML" button regenerates html from
// text. Syntax highlighting is a small regex tokeniser over the raw source
// (see highlight()) — not a real parser, just enough to colour tags,
// attributes and strings distinctly, as the brief asks for.
import { api, mountWidgets } from '/widget/_api.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Colour a tag's own markup: "<div class=\"x\">" -> tag name, each
// attribute name and its quoted value get their own <span> class.
function highlightTag(chunk) {
  return chunk.replace(/(<\/?[a-zA-Z][\w:-]*)|([a-zA-Z_:][\w:-]*)(=)("[^"]*"|'[^']*')|(\/?>)/g,
    (m, tagOpen, attrName, eq, attrVal, close) => {
      if (tagOpen) return `<span class="tok-tag">${esc(tagOpen)}</span>`;
      if (attrName) return `<span class="tok-attr">${esc(attrName)}</span>${esc(eq)}<span class="tok-str">${esc(attrVal)}</span>`;
      if (close) return `<span class="tok-tag">${esc(close)}</span>`;
      return esc(m);
    });
}

function highlight(src) {
  let i = 0, out = '';
  const n = src.length;
  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i);
      const stop = end === -1 ? n : end + 3;
      out += `<span class="tok-comment">${esc(src.slice(i, stop))}</span>`;
      i = stop; continue;
    }
    if (src[i] === '<') {
      const end = src.indexOf('>', i);
      const stop = end === -1 ? n : end + 1;
      out += highlightTag(src.slice(i, stop));
      i = stop; continue;
    }
    const next = src.indexOf('<', i);
    const stop = next === -1 ? n : next;
    out += esc(src.slice(i, stop));
    i = stop;
  }
  return out;
}

// HTML -> plain text: a detached element gives us real DOM parsing for free;
// inserting a newline after each block-ish element keeps paragraphs apart.
function deriveText(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  for (const el of div.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6, li')) el.insertAdjacentText('afterend', '\n');
  return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

// Plain text -> HTML: blank-line-separated blocks become paragraphs, a
// single newline inside a block becomes <br>. Deterministic, no data lost.
function textToHtml(text) {
  return text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
    .map((block) => `<p>${esc(block).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export default function mount(el, { row, api: a }) {
  const state = { mode: 'code', html: row.content, text: '' };

  function updatePreview() {
    const frame = el.querySelector('[data-preview]');
    if (frame) frame.srcdoc = state.html;
  }
  function setStatus(s) { const st = el.querySelector('[data-status]'); if (st) st.textContent = s; }

  function render() {
    el.innerHTML = `
      <style>
        [data-highlight] .tok-tag { color: #7b3fa0; font-weight: 600; }
        [data-highlight] .tok-attr { color: #b5651d; }
        [data-highlight] .tok-str { color: #1a7f37; }
        [data-highlight] .tok-comment { color: #888888; font-style: italic; }
      </style>
      <div class="toolbar" style="margin-bottom:6px">
        <button type="button" data-mode-btn="code" ${state.mode === 'code' ? 'disabled' : ''}>Code</button>
        <button type="button" data-mode-btn="text" ${state.mode === 'text' ? 'disabled' : ''}>Text</button>
        ${state.mode === 'text' ? '<button type="button" data-convert>Convert to HTML</button>' : ''}
        <button type="button" data-save>Save</button>
        <button type="button" data-template>Save as Template</button>
        <a data-help href="/page/guide">Help</a>
        <span data-status></span>
      </div>
      ${state.mode === 'code' ? `
        <div style="display:flex;gap:8px;align-items:flex-start">
          <div style="flex:1;min-width:0">
            <textarea data-html-input style="width:100%;height:220px;font-family:monospace;font-size:13px" spellcheck="false">${esc(state.html)}</textarea>
            <pre data-highlight style="width:100%;height:220px;overflow:auto;border:1px solid #ccc;margin:4px 0 0;font-family:monospace;font-size:13px;white-space:pre-wrap">${highlight(state.html)}</pre>
          </div>
          <iframe data-preview sandbox="allow-same-origin" title="Live preview" style="flex:1;height:220px;border:1px solid #ccc;background:white"></iframe>
        </div>` : `
        <textarea data-text-input style="width:100%;height:220px;font-family:inherit;font-size:14px">${esc(state.text)}</textarea>`}
    `;
    wire();
    if (state.mode === 'code') updatePreview();
  }

  function wire() {
    for (const btn of el.querySelectorAll('[data-mode-btn]')) {
      btn.addEventListener('click', () => {
        if (btn.dataset.modeBtn === 'text') state.text = deriveText(state.html);
        state.mode = btn.dataset.modeBtn;
        render();
      });
    }
    const conv = el.querySelector('[data-convert]');
    if (conv) conv.addEventListener('click', () => { state.html = textToHtml(state.text); state.mode = 'code'; render(); });
    const save = el.querySelector('[data-save]');
    save.addEventListener('click', async () => {
      const res = await a.post(`/Document/${row.id}`, { content: state.html });
      setStatus(res.ok ? 'Saved' : (res.errors?.[0] || 'Save failed'));
    });
    const tmpl = el.querySelector('[data-template]');
    tmpl.addEventListener('click', async () => {
      const res = await a.post(`/Document/${row.id}`, { content: state.html, isTemplate: 'true' });
      setStatus(res.ok ? 'Saved as template' : (res.errors?.[0] || 'Save failed'));
    });
    const htmlInput = el.querySelector('[data-html-input]');
    if (htmlInput) htmlInput.addEventListener('input', (e) => {
      state.html = e.target.value;
      el.querySelector('[data-highlight]').innerHTML = highlight(state.html);
      updatePreview();
    });
    const textInput = el.querySelector('[data-text-input]');
    if (textInput) textInput.addEventListener('input', (e) => { state.text = e.target.value; });
  }

  render();
}
mountWidgets('htmleditor', mount);
