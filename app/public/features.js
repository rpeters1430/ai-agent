'use strict';
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

// ==================================================== 1. Split & Image Upload
function showNoticeToast(title, body, imgUrl) {
  const toast = h('div', { class: 'toast' },
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('b', {}, title),
      h('button', { class: 'icon', title: 'Dismiss', onclick: () => toast.remove() }, '✕')),
    body && h('div', { class: 'small muted', style: 'word-break:break-all' }, body),
    imgUrl && h('img', { src: imgUrl, class: 'toast-thumb', alt: '' }));
  $('#toasts').append(toast);
  setTimeout(() => toast.remove(), 7000);
}

async function uploadAndPasteFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    showDialog('File too large', 'Uploads are limited to 15 MB.');
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
  const res = await api('POST', '/api/upload', { filename: file.name || 'paste.png', data: dataUrl });
  const isImg = /^image\//.test(file.type || '');
  if (active && open.has(active)) {
    sendToActive(res.path + ' ', false);
    showNoticeToast('Uploaded & pasted path', res.path, isImg ? res.url : null);
  } else {
    showNoticeToast('Uploaded to container', res.path, isImg ? res.url : null);
  }
}

// ====================================================== 2. Rich Diff Viewer
let diffCtx = { repo: '', wt: '' };

function renderUnifiedDiff(text) {
  const box = $('#diffPatch');
  box.replaceChildren();
  if (!text || !text.trim()) {
    box.append(h('div', { class: 'small muted', style: 'padding:12px' }, 'No tracked diff (working tree matches HEAD).'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) {
    let cls = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) cls += ' diff-meta';
    else if (line.startsWith('@@')) cls += ' diff-hunk';
    else if (line.startsWith('+')) cls += ' diff-add';
    else if (line.startsWith('-')) cls += ' diff-del';
    frag.append(h('div', { class: cls }, line || ' '));
  }
  box.append(frag);
}

async function refreshDiffViewer() {
  const { repo, wt } = diffCtx;
  const qs = wt ? `?wt=${encodeURIComponent(wt)}` : '';
  const d = await api('GET', `/api/repos/${encodeURIComponent(repo)}/diff${qs}`);
  $('#diffTitle').textContent = `Diff · ${repo}${wt ? ` / ${wt}` : ''}`;

  const brSel = $('#diffBranchSel');
  brSel.replaceChildren(...(d.branches.length ? d.branches : [d.branch]).map((b) => h('option', { value: b }, b)));
  brSel.value = d.branch;

  const fbox = $('#diffFiles');
  fbox.replaceChildren();
  if (!d.files.length) {
    fbox.append(h('p', { class: 'small muted', style: 'margin:0' }, 'Working tree is clean.'));
  } else {
    for (const f of d.files) {
      fbox.append(h('div', { class: 'item' },
        h('div', { class: 'top' },
          h('span', { class: 'badge ' + (f.untracked ? 'warn' : 'live') }, f.code.trim() || 'M'),
          h('span', { class: 'name', title: f.path, style: 'font-family:var(--mono);font-size:12px' }, f.path),
          h('span', { class: 'spacer' }),
          h('button', { style: 'font-size:11px;padding:2px 8px', onclick: (e) => busy(e.target, async () => {
            if (!(await m3Confirm('Discard changes?', `Revert "${f.path}"? Uncommitted edits to this file will be lost.`, { okLabel: 'Discard', danger: true }))) return;
            await api('POST', `/api/repos/${encodeURIComponent(repo)}/git/action`, { wt: wt || undefined, action: 'discard', file: f.path });
            await refreshDiffViewer(); loadLocal();
          }) }, 'Discard'))));
    }
  }
  renderUnifiedDiff(d.diff);
}

async function openDiffViewer(repo, wt = '') {
  diffCtx = { repo, wt };
  closeMobileSheet();
  $('#diffDlg').showModal();
  $('#diffFiles').replaceChildren(h('p', { class: 'small muted' }, 'Loading diff…'));
  $('#diffPatch').replaceChildren();
  try { await refreshDiffViewer(); } catch (e) { $('#diffFiles').replaceChildren(h('p', { class: 'err small' }, e.message)); }
}

// ====================================================== 3. File & Image Browser
let filesCtx = { repo: '', wt: '', dir: '', currentFile: '' };

async function loadFilesDir(dir) {
  filesCtx.dir = dir;
  const { repo, wt } = filesCtx;
  $('#filesTitle').textContent = `Files · ${repo}${wt ? ` / ${wt}` : ''}`;
  const qs = new URLSearchParams({ ...(wt ? { wt } : {}), ...(dir ? { dir } : {}) });
  const d = await api('GET', `/api/repos/${encodeURIComponent(repo)}/files?${qs}`);

  const crumbs = $('#filesBreadcrumbs');
  crumbs.replaceChildren();
  const parts = dir ? dir.split('/').filter(Boolean) : [];
  crumbs.append(h('button', { class: 'link', onclick: () => loadFilesDir('') }, repo));
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const target = acc;
    crumbs.append(' / ', h('button', { class: 'link', onclick: () => loadFilesDir(target) }, p));
  }

  const list = $('#filesList');
  list.replaceChildren();
  if (parts.length) {
    const parent = parts.slice(0, -1).join('/');
    list.append(h('div', { class: 'item clickable', onclick: () => loadFilesDir(parent) },
      h('div', { class: 'top' }, h('span', { class: 'name' }, '📁 ..'))));
  }
  if (!d.entries.length) list.append(h('p', { class: 'small muted' }, 'Empty directory.'));
  for (const e of d.entries) {
    list.append(h('div', { class: 'item clickable', onclick: () => (e.dir ? loadFilesDir(e.path) : openFilePreview(e.path)) },
      h('div', { class: 'top' },
        h('span', { class: 'name' }, `${e.dir ? '📁' : e.isImage ? '🖼' : '📄'} ${e.name}`),
        h('span', { class: 'spacer' }),
        !e.dir && h('span', { class: 'meta' }, e.size >= 1024 ? `${Math.round(e.size / 1024)} KB` : `${e.size} B`))));
  }
}

async function openFilePreview(relPath) {
  const { repo, wt } = filesCtx;
  filesCtx.currentFile = relPath;
  const qs = new URLSearchParams({ ...(wt ? { wt } : {}), path: relPath });
  const d = await api('GET', `/api/repos/${encodeURIComponent(repo)}/file?${qs}`);
  $('#filePreviewBox').classList.remove('hidden');
  $('#filePreviewName').textContent = relPath;
  const img = $('#filePreviewImg');
  const code = $('#filePreviewCode');
  if (d.isImage) {
    img.src = d.rawUrl;
    img.classList.remove('hidden');
    code.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    code.classList.remove('hidden');
    code.textContent = d.isBinary ? '(binary file — cannot preview as text)' : (d.content + (d.truncated ? '\n…(truncated at 300 KB)' : ''));
  }
}

async function openFileBrowser(repo, wt = '') {
  filesCtx = { repo, wt, dir: '', currentFile: '' };
  $('#filePreviewBox').classList.add('hidden');
  closeMobileSheet();
  $('#filesDlg').showModal();
  try { await loadFilesDir(''); } catch (e) { $('#filesList').replaceChildren(h('p', { class: 'err small' }, e.message)); }
}

// ====================================================== 4. Multi-Agent Arena
let arenaRepo = '';
function fillArenaModels(sel, agentKey) {
  const models = typeof appliedModels === 'function' ? appliedModels(agentKey) : [];
  sel.replaceChildren(h('option', { value: '' }, 'agent default'), ...models.map((m) => h('option', { value: m }, m)));
  sel.disabled = !['pi', 'opencode', 'claude', 'codex', 'qwen', 'dsh'].includes(agentKey);
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

// ====================================================== 5. Prompt Snippets
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

// ====================================================== 6. Port Preview Proxy
async function refreshPreviewPorts() {
  const box = $('#previewPorts');
  box.replaceChildren(h('span', { class: 'small muted' }, 'Scanning listening ports…'));
  try {
    const hData = await api('GET', '/api/system/health');
    box.replaceChildren();
    if (!hData.ports?.length) {
      box.append(h('span', { class: 'small muted' }, 'No dev servers detected yet. Start a server (e.g. npm run dev or dsh web) and click Scan ports, or enter a port below.'));
      return;
    }
    for (const port of hData.ports) {
      box.append(h('button', { class: 'tonal', onclick: () => openPortPreview(port, false) }, `:${port} (inline)`),
        h('a', { class: 'btn', href: `/preview/${port}/`, target: '_blank', rel: 'noopener noreferrer' }, `:${port} ↗`));
    }
  } catch (e) {
    box.replaceChildren(h('span', { class: 'err small' }, e.message));
  }
}

function openPortPreview(port, newTab) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    showDialog('Invalid port', 'Enter a port between 1024 and 65535.');
    return;
  }
  const url = `/preview/${p}/`;
  if (newTab) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  $('#previewPortInput').value = String(p);
  $('#previewFrameUrl').textContent = `Proxying container localhost:${p} → ${url}`;
  $('#previewFrameExt').href = url;
  $('#previewFrame').src = url;
  $('#previewFrameWrap').classList.remove('hidden');
}

// ====================================================== 7. GitHub Issues / PRs Browser
async function openRepoIssues(fullName) {
  const [owner, name] = fullName.split('/');
  $('#issuesTitle').textContent = `Issues & PRs · ${fullName}`;
  const sel = $('#issuesAgentSel');
  const installed = Object.entries(status.agents || {}).filter(([k, a]) => k !== 'shell' && a.installed);
  sel.replaceChildren(...installed.map(([k, a]) => h('option', { value: k }, a.label)));
  if (typeof autoState !== 'undefined' && autoState.watch?.agent) sel.value = autoState.watch.agent;
  const list = $('#issuesList');
  list.replaceChildren(h('p', { class: 'small muted' }, 'Loading open issues & PRs…'));
  closeMobileSheet();
  $('#issuesDlg').showModal();
  try {
    const d = await api('GET', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/items`);
    list.replaceChildren();
    if (!d.items.length) { list.append(h('p', { class: 'small muted' }, 'No open issues or pull requests.')); return; }
    for (const it of d.items) {
      list.append(h('div', { class: 'item' },
        h('div', { class: 'top' },
          h('span', { class: 'badge ' + (it.isPr ? 'size' : 'live') }, it.isPr ? (it.draft ? 'PR draft' : 'PR') : 'Issue'),
          h('a', { class: 'name', href: it.url, target: '_blank', rel: 'noopener noreferrer', style: 'color:inherit' }, `#${it.number} ${it.title}`)),
        h('div', { class: 'top badges' },
          h('span', { class: 'meta' }, `@${it.author} · ${it.comments} comments`),
          ...it.labels.map((l) => h('span', { class: 'badge' }, l.name))),
        h('div', { class: 'actions' },
          h('button', { class: 'agent', onclick: (e) => busy(e.target, async () => {
            await api('POST', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/dispatch`, {
              number: it.number, action: 'fix_issue', title: it.title, agent: sel.value,
            });
            showNoticeToast('Automation queued', `${it.isPr ? 'Working on PR' : 'Fixing issue'} #${it.number} in ${fullName}`);
            if (typeof loadAuto === 'function') loadAuto();
          }) }, it.isPr ? 'Work on PR' : 'Fix issue'),
          it.isPr && h('button', { onclick: (e) => busy(e.target, async () => {
            await api('POST', `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/dispatch`, {
              number: it.number, action: 'review', title: it.title, agent: sel.value,
            });
            showNoticeToast('Review queued', `Reviewing PR #${it.number} in ${fullName}`);
            if (typeof loadAuto === 'function') loadAuto();
          }) }, 'Review PR'))));
    }
  } catch (e) {
    list.replaceChildren(h('p', { class: 'err small' }, e.message));
  }
}

// ====================================================== 8. Custom OpenAI Providers
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

// ====================================================== 9. API Keys & Env Vars
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

// ====================================================== 10. MCP & Instructions
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

// ====================================================== 11. Container Health
async function loadContainerHealth() {
  const box = $('#healthSummary');
  if (!box) return;
  try {
    const d = await api('GET', '/api/system/health');
    const gbStr = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');
    const upHrs = Math.floor(d.processUptimeSec / 3600);
    const upMin = Math.floor((d.processUptimeSec % 3600) / 60);
    box.replaceChildren(
      h('div', {}, `CPU load: ${d.loadavg.join(' / ')} (${d.cpus} cores) · UI up ${upHrs}h ${upMin}m`),
      h('div', {}, `RAM: ${gbStr(d.mem.used)} / ${gbStr(d.mem.total)} · Worktrees: ${d.worktrees.count} (${gbStr(d.worktrees.bytes)})`),
      d.disk && h('div', {}, `Disk: ${gbStr(d.disk.used)} / ${gbStr(d.disk.total)} (${d.disk.pct} used)`),
      h('div', {}, `Listening ports: ${d.ports.length ? d.ports.map((p) => ':' + p).join(', ') : 'none'}`));
  } catch (e) {
    box.textContent = e.message;
  }
}

// ====================================================== Event Wiring
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
