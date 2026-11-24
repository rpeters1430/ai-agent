// Custom OpenAI-compatible providers.
import { $, api, busy, h, m3Confirm } from './core.js';
import { ollamaState, renderLaunchModels } from './ollama.js';
import { showNoticeToast } from './upload.js';

let customProvidersState = [];
async function loadCustomProviders() {
  const box = $('#customProviders');
  if (!box) return;
  const d = await api('GET', '/api/providers');
  customProvidersState = d.providers || [];
  if (ollamaState) { ollamaState.applied = d.applied; renderLaunchModels(); }
  box.replaceChildren();
  if (!customProvidersState.length) {
    box.append(h('p', { class: 'small muted', style: 'margin:0' }, 'No custom providers added yet. Click ＋ above to add LM Studio, llama.cpp, vLLM, OpenRouter, or DeepSeek.'));
    return;
  }
  for (const p of customProvidersState) {
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: 'name' }, p.name),
        h('span', { class: 'badge' }, p.id),
        h('span', { class: 'spacer' }),
        h('span', { class: 'meta' }, `${p.models.length} model(s)`)),
      h('div', { class: 'meta' }, p.baseUrl),
      h('div', { class: 'actions' },
        h('button', { class: 'tonal', onclick: (e) => busy(e.target, async () => {
          const r = await api('POST', `/api/providers/${encodeURIComponent(p.id)}/apply`, { targets: ['opencode', 'pi'] });
          ollamaState.applied = r.applied; renderLaunchModels();
          showNoticeToast('Provider applied', `${p.name} models written to OpenCode & Pi.`);
        }) }, 'Apply to OpenCode & Pi'),
        h('button', { onclick: () => openProviderDlg(p) }, 'Edit'),
        h('button', { onclick: (e) => busy(e.target, async () => {
          if (!(await m3Confirm('Remove provider?', `Remove "${p.name}" from Agent Hub, OpenCode, and Pi?`, { okLabel: 'Remove', danger: true }))) return;
          const r = await api('DELETE', `/api/providers/${encodeURIComponent(p.id)}`);
          ollamaState.applied = r.applied; renderLaunchModels();
          await loadCustomProviders();
        }) }, 'Delete'))));
  }
}

function openProviderDlg(p) {
  const f = $('#providerForm');
  f.id.value = p?.id || '';
  f.id.readOnly = !!p;
  f.name.value = p?.name || '';
  f.baseUrl.value = p?.baseUrl || '';
  f.apiKey.value = p?.hasKey ? p.apiKey : '';
  f.contextWindow.value = String(p?.contextWindow || 32768);
  f.models.value = (p?.models || []).join('\n');
  $('#providerDiscoverMsg').textContent = '';
  $('#providerDlg').showModal();
}

export { loadCustomProviders, openProviderDlg };
