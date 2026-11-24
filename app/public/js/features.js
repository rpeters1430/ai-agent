// Starts the feature modules and wires their buttons.
import { $, api, busy, m3Confirm, m3Prompt, showDialog } from './core.js';
import { loadLocal, loadSessions } from './workspace.js';
import { attach, sendToActive, setSplitPair, toggleSplit } from './terminals.js';
import { closeMobileSheet } from './nav.js';
import { showNoticeToast, uploadAndPasteFile } from './upload.js';
import { diffCtx, refreshDiffViewer } from './diff.js';
import { filesCtx } from './files.js';
import { arenaRepo, fillArenaModels } from './arena.js';
import { loadSnippetsList } from './snippets.js';
import { openPortPreview, refreshPreviewPorts } from './preview.js';
import { loadCustomProviders, openProviderDlg } from './providers.js';
import { loadEnvList, loadInstructionsEditor, loadMcpEditor, openConfigDialog, renderSelectedInstruction, renderSelectedMcp } from './config.js';
import { loadContainerHealth } from './health.js';

// Extended Agent Hub features:
// - Split-screen terminals toggle
// - Drag/drop & clipboard image/file upload into container
// - Rich Diff Viewer + Commit / Stash / Branch switcher
// - File & Image Browser
// - Prompt Snippets library
// - Port Preview Proxy (auto-discovered container ports + iframe/tab)
// - Multi-Agent Arena Compare (launches 2 worktrees in Split View)
// - GitHub Issues & PRs Browser
// - Custom OpenAI-Compatible Providers (LM Studio, llama.cpp, vLLM, OpenRouter, DeepSeek)
// - Runtime API Keys & Env Vars manager
// - Agent Instructions (CLAUDE.md / AGENTS.md / GEMINI.md) & MCP Server editor
// - Container & Worktree Health + Cleanup

let featuresInited = false;
function initFeatures() {
  if (!featuresInited) {
    featuresInited = true;
    wireFeatureEvents();
  }
  loadCustomProviders().catch(() => {});
  loadContainerHealth().catch(() => {});
}

function wireFeatureEvents() {
  // Split view
  $('#splitBtn')?.addEventListener('click', () => toggleSplit());

  // Image/file upload button + drag & drop + clipboard paste
  $('#uploadImgBtn')?.addEventListener('click', () => $('#uploadFileInput').click());
  $('#uploadFileInput')?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) uploadAndPasteFile(f).catch((err) => showDialog('Upload failed', err.message));
  });
  const termsEl = $('#terms');
  if (termsEl) {
    termsEl.addEventListener('dragover', (e) => { e.preventDefault(); termsEl.classList.add('drop-active'); });
    termsEl.addEventListener('dragleave', () => termsEl.classList.remove('drop-active'));
    termsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      termsEl.classList.remove('drop-active');
      const f = e.dataTransfer?.files?.[0];
      if (f) uploadAndPasteFile(f).catch((err) => showDialog('Upload failed', err.message));
    });
  }
  window.addEventListener('paste', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const item = [...(e.clipboardData?.items || [])].find((it) => it.kind === 'file');
    if (item) {
      e.preventDefault();
      const f = item.getAsFile();
      if (f) uploadAndPasteFile(f).catch((err) => showDialog('Upload failed', err.message));
    }
  });

  // Diff viewer
  $('#diffClose')?.addEventListener('click', () => $('#diffDlg').close());
  $('#diffRefresh')?.addEventListener('click', (e) => busy(e.target, refreshDiffViewer));
  $('#diffCommitForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter || e.target.querySelector('button'), async () => {
      const msg = $('#diffCommitMsg').value.trim();
      if (!msg) return;
      const r = await api('POST', `/api/repos/${encodeURIComponent(diffCtx.repo)}/git/action`, {
        wt: diffCtx.wt || undefined, action: 'commit', message: msg, addAll: true,
      });
      $('#diffCommitMsg').value = '';
      showNoticeToast('Committed', r.output.split('\n')[0] || msg);
      await refreshDiffViewer(); loadLocal();
    });
  });
  $('#diffBranchSel')?.addEventListener('change', (e) => busy(e.target, async () => {
    await api('POST', `/api/repos/${encodeURIComponent(diffCtx.repo)}/git/action`, {
      wt: diffCtx.wt || undefined, action: 'checkout', branch: e.target.value,
    });
    await refreshDiffViewer(); loadLocal();
  }));
  $('#diffNewBranch')?.addEventListener('click', (e) => busy(e.target, async () => {
    const b = await m3Prompt('New branch', 'Branch name to create and switch to:', '', { placeholder: 'feat/my-change', okLabel: 'Create' });
    if (!b) return;
    await api('POST', `/api/repos/${encodeURIComponent(diffCtx.repo)}/git/action`, {
      wt: diffCtx.wt || undefined, action: 'checkout', branch: b.trim(), create: true,
    });
    await refreshDiffViewer(); loadLocal();
  }));
  $('#diffStash')?.addEventListener('click', (e) => busy(e.target, async () => {
    const r = await api('POST', `/api/repos/${encodeURIComponent(diffCtx.repo)}/git/action`, { wt: diffCtx.wt || undefined, action: 'stash' });
    showNoticeToast('Stashed', r.output || 'Saved to stash');
    await refreshDiffViewer(); loadLocal();
  }));
  $('#diffStashPop')?.addEventListener('click', (e) => busy(e.target, async () => {
    const r = await api('POST', `/api/repos/${encodeURIComponent(diffCtx.repo)}/git/action`, { wt: diffCtx.wt || undefined, action: 'stash', pop: true });
    showNoticeToast('Stash popped', r.output || 'Restored');
    await refreshDiffViewer(); loadLocal();
  }));

  // File browser
  $('#filesClose')?.addEventListener('click', () => $('#filesDlg').close());
  $('#filePreviewClose')?.addEventListener('click', () => $('#filePreviewBox').classList.add('hidden'));
  $('#fileSendPath')?.addEventListener('click', () => {
    if (filesCtx.currentFile) { $('#filesDlg').close(); sendToActive(filesCtx.currentFile + ' ', false); }
  });

  // Arena
  $('#arenaCancel')?.addEventListener('click', () => $('#arenaDlg').close());
  $('#arenaForm')?.agent1.addEventListener('change', (e) => fillArenaModels($('#arenaForm').model1, e.target.value));
  $('#arenaForm')?.agent2.addEventListener('change', (e) => fillArenaModels($('#arenaForm').model2, e.target.value));
  $('#arenaForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button[type=submit]'), async () => {
      const r = await api('POST', `/api/repos/${encodeURIComponent(arenaRepo)}/arena`, {
        prompt: f.prompt.value,
        base: f.base.value,
        agents: [
          { agent: f.agent1.value, model: f.model1.value || '' },
          { agent: f.agent2.value, model: f.model2.value || '' },
        ],
      });
      $('#arenaDlg').close();
      await loadSessions();
      await loadLocal();
      if (r.runs?.length >= 2) {
        attach(r.runs[0].session, r.runs[0].label);
        attach(r.runs[1].session, r.runs[1].label);
        setSplitPair(r.runs[0].session, r.runs[1].session);
      }
    });
  });

  // Snippets
  $('#snippetsBtn')?.addEventListener('click', () => { $('#snippetsDlg').showModal(); loadSnippetsList().catch(() => {}); });
  $('#snippetsClose')?.addEventListener('click', () => $('#snippetsDlg').close());
  $('#snippetAddForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button[type=submit]'), async () => {
      await api('POST', '/api/snippets', { title: f.title.value, text: f.text.value });
      f.reset();
      await loadSnippetsList();
    });
  });

  // Port Preview
  $('#previewBtn')?.addEventListener('click', () => {
    $('#previewFrameWrap').classList.add('hidden');
    $('#previewDlg').showModal();
    refreshPreviewPorts();
  });
  $('#previewClose')?.addEventListener('click', () => { $('#previewFrame').src = 'about:blank'; $('#previewDlg').close(); });
  $('#previewRefresh')?.addEventListener('click', () => refreshPreviewPorts());
  $('#previewCustomForm')?.addEventListener('submit', (e) => { e.preventDefault(); openPortPreview($('#previewPortInput').value, false); });
  $('#previewOpenTab')?.addEventListener('click', () => openPortPreview($('#previewPortInput').value, true));

  // Issues browser
  $('#issuesClose')?.addEventListener('click', () => $('#issuesDlg').close());

  // Custom providers
  $('#addProviderBtn')?.addEventListener('click', () => openProviderDlg(null));
  $('#providerCancel')?.addEventListener('click', () => $('#providerDlg').close());
  $('#providerDiscover')?.addEventListener('click', (e) => busy(e.target, async () => {
    const f = $('#providerForm');
    $('#providerDiscoverMsg').textContent = 'Querying /models…';
    const r = await api('POST', '/api/providers/discover', { id: f.id.value, baseUrl: f.baseUrl.value, apiKey: f.apiKey.value });
    f.models.value = (r.models || []).join('\n');
    $('#providerDiscoverMsg').textContent = `Found ${r.models.length} model(s).`;
  }));
  $('#providerForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button[type=submit]'), async () => {
      await api('POST', '/api/providers', {
        id: f.id.value, name: f.name.value, baseUrl: f.baseUrl.value,
        apiKey: f.apiKey.value, contextWindow: Number(f.contextWindow.value) || 32768, models: f.models.value,
      });
      await api('POST', `/api/providers/${encodeURIComponent(f.id.value.trim().toLowerCase())}/apply`, { targets: ['opencode', 'pi'] });
      $('#providerDlg').close();
      await loadCustomProviders();
      showNoticeToast('Provider saved & applied', `${f.name.value} is ready in OpenCode and Pi.`);
    });
  });

  // API Keys
  $('#openEnvBtn')?.addEventListener('click', () => { closeMobileSheet(); $('#envDlg').showModal(); loadEnvList().catch(() => {}); });
  $('#envClose')?.addEventListener('click', () => $('#envDlg').close());
  $('#envCustomForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button[type=submit]'), async () => {
      await api('POST', '/api/env', { vars: { [f.key.value.trim().toUpperCase()]: f.value.value } });
      f.reset();
      await loadEnvList();
    });
  });

  // MCP & Instructions
  $('#openCfgBtn')?.addEventListener('click', openConfigDialog);
  $('#cfgClose')?.addEventListener('click', () => $('#cfgDlg').close());
  for (const b of document.querySelectorAll('#cfgTabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#cfgTabs button')) x.classList.toggle('active', x === b);
      const tab = b.dataset.tab;
      $('#cfgInstPanel').classList.toggle('hidden', tab !== 'instructions');
      $('#cfgMcpPanel').classList.toggle('hidden', tab !== 'mcp');
    });
  }
  $('#cfgScope')?.addEventListener('change', () => loadInstructionsEditor().catch(() => {}));
  $('#cfgFileName')?.addEventListener('change', renderSelectedInstruction);
  $('#cfgInstSave')?.addEventListener('click', (e) => busy(e.target, async () => {
    const scopeVal = $('#cfgScope').value;
    const isRepo = scopeVal.startsWith('repo:');
    await api('PUT', '/api/config/instructions', {
      scope: isRepo ? 'repo' : 'global',
      repo: isRepo ? scopeVal.slice(5) : '',
      name: $('#cfgFileName').value,
      content: $('#cfgInstText').value,
    });
    showNoticeToast('Saved', `Updated ${$('#cfgFileName').value}`);
    await loadInstructionsEditor();
  }));
  $('#cfgMcpTarget')?.addEventListener('change', renderSelectedMcp);
  $('#cfgMcpSave')?.addEventListener('click', (e) => busy(e.target, async () => {
    let parsed;
    try { parsed = JSON.parse($('#cfgMcpJson').value || '{}'); } catch (err) {
      $('#cfgMcpMsg').className = 'small err';
      $('#cfgMcpMsg').textContent = `Invalid JSON: ${err.message}`;
      return;
    }
    await api('PUT', '/api/config/mcp', { target: $('#cfgMcpTarget').value, servers: parsed });
    $('#cfgMcpMsg').className = 'small';
    $('#cfgMcpMsg').textContent = 'Saved (with .bak backup). Restart running agent sessions to reload MCP servers.';
    await loadMcpEditor();
  }));

  // Health & prune
  $('#refreshHealth')?.addEventListener('click', (e) => busy(e.target, loadContainerHealth));
  $('#pruneBtn')?.addEventListener('click', (e) => busy(e.target, async () => {
    const rmMerged = await m3Confirm('Prune workspace', 'Remove old temp uploads, prune stale git worktrees, and also delete clean merged worktrees?', { okLabel: 'Prune all' });
    const r = await api('POST', '/api/system/prune', { removeMerged: !!rmMerged });
    showNoticeToast('Cleanup done', `Pruned ${r.prunedRepos} repo(s), removed ${r.removedWorktrees} merged worktree(s), ${r.removedUploads} temp upload(s).`);
    await loadContainerHealth();
    await loadLocal();
  }));
}

export { initFeatures };
