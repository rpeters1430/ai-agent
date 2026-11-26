// Multi-agent Arena: run 2-4 agents on one prompt in separate worktrees.
import { $, h } from './core.js';
import { status } from './workspace.js';
import { closeMobileSheet } from './nav.js';
import { appliedModels } from './automations.js';

let arenaRepo = '';
function fillArenaModels(sel, agentKey) {
  const models = typeof appliedModels === 'function' ? appliedModels(agentKey) : [];
  sel.replaceChildren(h('option', { value: '' }, 'agent default'), ...models.map((m) => h('option', { value: m }, m)));
  sel.disabled = !['pi', 'opencode', 'claude', 'codex', 'qwen', 'cline'].includes(agentKey);
}

function openArena(repoObj) {
  arenaRepo = repoObj.name;
  const f = $('#arenaForm');
  $('#arenaTitle').textContent = `Multi-Agent Arena · ${repoObj.name}`;
  f.base.value = repoObj.branch || 'HEAD';
  f.prompt.value = '';
  const installed = Object.entries(status.agents || {}).filter(([k, a]) => k !== 'shell' && a.installed);
  for (const [selName, modName, defIdx] of [['agent1', 'model1', 0], ['agent2', 'model2', 1]]) {
    const sel = f[selName];
    sel.replaceChildren(...installed.map(([k, a]) => h('option', { value: k }, a.label)));
    if (installed[defIdx]) sel.value = installed[defIdx][0];
    fillArenaModels(f[modName], sel.value);
  }
  closeMobileSheet();
  $('#arenaDlg').showModal();
  f.prompt.focus();
}

export { arenaRepo, fillArenaModels, openArena };
