// API keys & env vars, MCP servers and agent instruction files (CLAUDE.md / AGENTS.md / GEMINI.md).
import { $, api, busy, h } from './core.js';
import { localRepos } from './workspace.js';
import { closeMobileSheet } from './nav.js';
import { showNoticeToast } from './upload.js';

async function loadEnvList() {
  const { vars } = await api('GET', '/api/env');
  const box = $('#envList');
  box.replaceChildren();
  for (const v of vars) {
    const inp = h('input', { type: 'password', placeholder: v.masked ? `Current: ${v.masked}` : 'Not set — paste key…', autocomplete: 'off' });
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: 'name', style: 'font-family:var(--mono);font-size:12.5px' }, v.key),
        v.saved ? h('span', { class: 'badge live' }, 'saved')
          : v.fromEnv ? h('span', { class: 'badge size' }, 'from .env') : h('span', { class: 'badge' }, 'unset'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'small muted' }, v.hint)),
      h('div', { class: 'row' },
        inp,
        h('button', { class: 'primary', style: 'font-size:12px', onclick: (e) => busy(e.target, async () => {
          if (!inp.value.trim()) return;
          await api('POST', '/api/env', { vars: { [v.key]: inp.value.trim() } });
          await loadEnvList();
          showNoticeToast('API key saved', `${v.key} will be injected into new sessions & automations.`);
        }) }, 'Save'),
        v.saved && h('button', { style: 'font-size:12px', onclick: (e) => busy(e.target, async () => {
          await api('DELETE', `/api/env/${encodeURIComponent(v.key)}`);
          await loadEnvList();
        }) }, 'Clear'))));
  }
}

let cfgCache = { inst: [], mcp: {} };

async function loadInstructionsEditor() {
  const scopeVal = $('#cfgScope').value;
  const isRepo = scopeVal.startsWith('repo:');
  const repo = isRepo ? scopeVal.slice(5) : '';
  const qs = new URLSearchParams({ scope: isRepo ? 'repo' : 'global', ...(repo ? { repo } : {}) });
  const d = await api('GET', `/api/config/instructions?${qs}`);
  cfgCache.inst = d.files || [];
  renderSelectedInstruction();
}

function renderSelectedInstruction() {
  const name = $('#cfgFileName').value;
  const f = cfgCache.inst.find((x) => x.name === name);
  $('#cfgInstPath').textContent = f ? `${f.path}${f.exists ? '' : ' (will be created on save)'}` : '';
  $('#cfgInstText').value = f?.content || '';
}

async function loadMcpEditor() {
  const d = await api('GET', '/api/config/mcp');
  cfgCache.mcp = d.targets || {};
  renderSelectedMcp();
}

function renderSelectedMcp() {
  const k = $('#cfgMcpTarget').value;
  const t = cfgCache.mcp[k];
  $('#cfgMcpPath').textContent = t ? `${t.file} → "${t.prop}"` : '';
  $('#cfgMcpJson').value = JSON.stringify(t?.servers || {}, null, 2);
  $('#cfgMcpMsg').textContent = t?.error || '';
  $('#cfgMcpMsg').className = t?.error ? 'small err' : 'small muted';
}

function openConfigDialog() {
  const scopeSel = $('#cfgScope');
  scopeSel.replaceChildren(
    h('option', { value: 'global' }, 'Global (~/.claude, ~/.codex, ~/.gemini)'),
    ...(localRepos || []).map((r) => h('option', { value: `repo:${r.name}` }, `Repo: ${r.name}`)));
  closeMobileSheet();
  $('#cfgDlg').showModal();
  loadInstructionsEditor().catch(() => {});
  loadMcpEditor().catch(() => {});
}

export { loadEnvList, loadInstructionsEditor, renderSelectedInstruction, loadMcpEditor, renderSelectedMcp, openConfigDialog };
