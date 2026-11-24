// Shows links that CLIs tried to open in a browser inside the container (see hub-open).
import { $, api, h, m3Prompt } from './core.js';
import { sendToActive } from './terminals.js';

let openSince = Date.now() - 60 * 1000;
const shownUrls = new Set();
async function pollOpenUrls() {
  const { now, urls } = await api('GET', `/api/open-urls?since=${openSince}`);
  for (const u of urls) {
    openSince = Math.max(openSince, u.ts);
    if (shownUrls.has(u.url)) continue;
    shownUrls.add(u.url);
    let host = ''; try { host = new URL(u.url).host; } catch { continue; }
    const toast = h('div', { class: 'toast' },
      h('div', {}, h('b', {}, 'A CLI wants to open a page'), h('div', { class: 'meta' }, host)),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: u.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open sign-in page'),
        h('button', { onclick: async (e) => { try { await navigator.clipboard.writeText(u.url); e.target.textContent = 'Copied'; } catch { await m3Prompt('Copy sign-in URL', 'Copy this address into your browser:', u.url, { okLabel: 'Done' }); } } }, 'Copy'),
        h('button', { class: 'icon', title: 'Dismiss', onclick: () => toast.remove() }, '✕')),
      h('form', { class: 'row', onsubmit: (e) => {
          e.preventDefault();
          const v = e.target.code.value.trim();
          if (v && sendToActive(v, true)) toast.remove();
        } },
        h('input', { type: 'text', name: 'code', placeholder: 'Paste the code it gives you here', autocomplete: 'off' }),
        h('button', { class: 'primary', type: 'submit' }, 'Send')));
    $('#toasts').append(toast);
  }
  if (!urls.length) openSince = Math.max(openSince, now - 5000);
}

export { pollOpenUrls };
