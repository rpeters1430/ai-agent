// Prompt snippets library.
import { $, api, busy, h } from './core.js';
import { sendToActive } from './terminals.js';

async function loadSnippetsList() {
  const { snippets } = await api('GET', '/api/snippets');
  const box = $('#snippetsList');
  box.replaceChildren();
  if (!snippets.length) box.append(h('p', { class: 'small muted' }, 'No snippets yet. Add one below.'));
  for (const s of snippets) {
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: 'name' }, s.title),
        h('span', { class: 'spacer' }),
        h('button', { class: 'primary', style: 'font-size:11px;padding:3px 10px', onclick: () => {
          $('#snippetsDlg').close();
          sendToActive(s.text, true);
        } }, 'Send ⏎'),
        h('button', { style: 'font-size:11px;padding:3px 9px', title: 'Paste without pressing Enter', onclick: () => {
          $('#snippetsDlg').close();
          sendToActive(s.text, false);
        } }, 'Insert'),
        h('button', { class: 'icon', title: 'Delete snippet', onclick: (e) => busy(e.target, async () => {
          await api('DELETE', `/api/snippets/${encodeURIComponent(s.id)}`);
          await loadSnippetsList();
        }) }, '✕')),
      h('div', { class: 'small muted', style: 'font-family:var(--mono)' }, s.text)));
  }
}

export { loadSnippetsList };
