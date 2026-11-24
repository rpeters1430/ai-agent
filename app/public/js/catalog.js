// Ollama library browser ("Browse & pull…").
import { $, api, busy, h } from './core.js';
import { loadOllama, ollamaState, pollPulls } from './ollama.js';

let catPage = 1;
const catTags = new Map(); // name -> detail (cached per dialog session)
const SIZE_RE = /^(latest|[\d.]+[bmk](-cloud)?|cloud)$/i;

function installedNames() { return new Set((ollamaState.models || []).map((m) => m.name)); }
function pullingNames() { return new Set(Object.entries(ollamaState.pulls || {}).filter(([, p]) => !p.done).map(([n]) => n)); }

async function pullModel(model, btn) {
  await api('POST', '/api/ollama/pull', { model });
  btn.textContent = 'Pulling…'; btn.disabled = true;
  setTimeout(() => pollPulls().catch(() => {}), 300);
}

function capBadges(caps, cloud) {
  return [
    caps.includes('tools') ? h('span', { class: 'badge live' }, 'tools') : (!caps.includes('embedding') && h('span', { class: 'badge bad', title: 'No tool calling — agents cannot use it to edit files' }, 'no tools')),
    caps.includes('thinking') && h('span', { class: 'badge' }, 'thinking'),
    caps.includes('vision') && h('span', { class: 'badge' }, 'vision'),
    caps.includes('embedding') && h('span', { class: 'badge' }, 'embedding'),
    cloud && h('span', { class: 'badge cloud' }, 'cloud'),
  ];
}

function renderTags(box, d, showAll) {
  const inst = installedNames(), pulling = pullingNames();
  const main = d.tags.filter((t) => SIZE_RE.test(t.tag));
  const list = showAll || !main.length ? d.tags : main;
  box.replaceChildren(
    ...list.map((t) => h('div', { class: 'tagrow' },
      h('span', { class: 't', title: t.model }, t.model, t.latest && t.tag !== 'latest' ? ' (latest)' : ''),
      h('span', { class: 'opt muted' }, t.size || ''),
      h('span', { class: 'opt muted', title: 'context window' }, t.context ? `${t.context} ctx` : ''),
      h('span', { class: 'opt muted' }, t.input),
      inst.has(t.model) || (t.tag === 'latest' && inst.has(d.name)) ? h('span', { class: 'badge live' }, 'installed')
        : pulling.has(t.model) ? h('span', { class: 'badge' }, 'pulling…')
        : h('button', { class: 'primary', onclick: (e) => busy(e.target, () => pullModel(t.model, e.target)) }, 'Pull'))),
    d.tags.length > list.length && h('button', { style: 'justify-self:start;font-size:11px', onclick: () => renderTags(box, d, true) }, `Show all ${d.tags.length} variants (quantizations etc.)`));
}

function catalogCard(m) {
  const tagsBox = h('div', { class: 'tags' });
  const toggle = h('button', { style: 'font-size:12px', onclick: (e) => busy(e.target, async () => {
    if (tagsBox.childElementCount) { tagsBox.replaceChildren(); toggle.textContent = 'Show versions'; return; }
    tagsBox.replaceChildren(h('span', { class: 'small muted' }, 'Loading versions…'));
    let d = catTags.get(m.name);
    if (!d) { d = await api('GET', `/api/ollama/catalog/${encodeURIComponent(m.name)}`); catTags.set(m.name, d); }
    if (!d.tags.length) { tagsBox.replaceChildren(h('span', { class: 'small muted' }, 'No versions listed.')); return; }
    renderTags(tagsBox, d, false); toggle.textContent = 'Hide versions';
  }) }, 'Show versions');
  return h('div', { class: 'item' },
    h('div', { class: 'top', style: 'flex-wrap:wrap' },
      h('a', { class: 'name', href: `https://ollama.com/library/${m.name}`, target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit' }, m.name),
      ...capBadges(m.caps, m.cloud),
      h('span', { class: 'spacer' }),
      m.downloads && h('span', { class: 'meta' }, `${m.downloads >= 1e6 ? (m.downloads / 1e6).toFixed(1) + 'M' : Math.round(m.downloads / 1e3) + 'k'} pulls`)),
    m.description && h('div', { class: 'small' }, m.description),
    (m.sizes.length || m.context) && h('div', { class: 'top', style: 'flex-wrap:wrap' },
      ...m.sizes.map((s) => h('span', { class: 'badge size' }, s)),
      m.context && h('span', { class: 'badge' }, `${m.context} ctx`)),
    h('div', { class: 'usage ' + m.usage.level }, m.usage.text),
    h('div', {}, toggle), tagsBox);
}

async function loadCatalog(append) {
  const list = $('#catList');
  if (!append) { catPage = 1; list.replaceChildren(h('p', { class: 'muted small' }, 'Loading from ollama.com…')); }
  const qs = new URLSearchParams({ q: $('#catQ').value.trim(), c: $('#catC').value, p: String(catPage) });
  try {
    const r = await api('GET', `/api/ollama/catalog?${qs}`);
    if (!append) list.replaceChildren();
    if (!r.models.length && !append) list.append(h('p', { class: 'muted small' }, 'No models found.'));
    r.models.forEach((m) => list.append(catalogCard(m)));
    $('#catMore').classList.toggle('hidden', !r.more);
  } catch (e) { list.replaceChildren(h('p', { class: 'err small' }, e.message)); }
}

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  $('#browseModels').addEventListener('click', () => { $('#catalog').showModal(); if (!$('#catList').childElementCount) loadCatalog(false); });
  $('#catClose').addEventListener('click', () => $('#catalog').close());
  $('#catForm').addEventListener('submit', (e) => { e.preventDefault(); loadCatalog(false); });
  $('#catC').addEventListener('change', () => loadCatalog(false));
  $('#catMore').addEventListener('click', (e) => busy(e.target, async () => { catPage++; await loadCatalog(true); }));
  $('#catalog').addEventListener('close', () => loadOllama().catch(() => {}));
}

export { init };
