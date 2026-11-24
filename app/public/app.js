'use strict';
const $ = (s) => document.querySelector(s);

// Tiny DOM builder (all text via textContent - no HTML injection).
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && url !== '/api/login') { showLogin(); throw new Error('unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
function showDialog(title, body) { $('#dlgTitle').textContent = title; $('#dlgBody').textContent = body; $('#dlg').showModal(); }
async function busy(btn, fn) { btn.disabled = true; try { return await fn(); } catch (e) { if (e.message !== 'unauthorized') showDialog('Error', e.message); } finally { btn.disabled = false; } }

// Reusable Material 3 Expressive confirm & prompt modal (replaces native browser popups).
function m3Modal({ title, message = '', input = false, defaultValue = '', placeholder = '', okLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#m3Modal');
    const form = $('#m3ModalForm');
    const inp = $('#m3ModalInput');
    const okBtn = $('#m3ModalOk');
    const cancelBtn = $('#m3ModalCancel');
    $('#m3ModalTitle').textContent = title;
    $('#m3ModalMsg').textContent = message;
    $('#m3ModalMsg').classList.toggle('hidden', !message);
    inp.classList.toggle('hidden', !input);
    inp.value = defaultValue;
    inp.placeholder = placeholder;
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'danger' : 'primary';

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onSubmit = (e) => { e.preventDefault(); finish(input ? inp.value : true); };
    const onCancel = (e) => { if (e) e.preventDefault(); finish(input ? null : false); };

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    if (input) { inp.focus(); inp.select(); } else okBtn.focus();
  });
}
const m3Confirm = (title, message, opts = {}) => m3Modal({ title, message, input: false, okLabel: 'Confirm', ...opts });
const m3Prompt = (title, message, defaultValue = '', opts = {}) => m3Modal({ title, message, input: true, defaultValue, okLabel: 'OK', ...opts });

function setRailBadge(selector, count) {
  const el = $(selector);
  if (!el) return;
  const n = Number(count) || 0;
  el.textContent = n > 99 ? '99+' : String(n);
  el.classList.toggle('hidden', n <= 0);
}

// -------------------------------------------------- M3 Expressive Theme ----
const M3_SEEDS = [
  { id: 'ember',    label: 'Ember',    swatch: '#ff9f62', cursor: '#ff9f62', darkBg: '#0b0d10', lightBg: '#ffffff' },
  { id: 'cobalt',   label: 'Cobalt',   swatch: '#82b4ff', cursor: '#82b4ff', darkBg: '#0a0c12', lightBg: '#ffffff' },
  { id: 'sage',     label: 'Sage',     swatch: '#6fdba6', cursor: '#6fdba6', darkBg: '#0a0e0c', lightBg: '#ffffff' },
  { id: 'amethyst', label: 'Amethyst', swatch: '#cfa6ff', cursor: '#cfa6ff', darkBg: '#0d0b11', lightBg: '#ffffff' },
  { id: 'rose',     label: 'Rose',     swatch: '#ff94ad', cursor: '#ff94ad', darkBg: '#0f0b0d', lightBg: '#ffffff' },
];
let themeSeed = 'ember';
let themeMode = 'dark';
const lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : { matches: false, addEventListener() {} };

function resolvedScheme() {
  return themeMode === 'auto' ? (lightQuery.matches ? 'light' : 'dark') : themeMode;
}
function xtermTheme() {
  const seed = M3_SEEDS.find((s) => s.id === themeSeed) || M3_SEEDS[0];
  if (resolvedScheme() === 'light') {
    return {
      background: seed.lightBg,
      foreground: '#1d1b1a',
      cursor: seed.swatch,
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(120, 120, 140, 0.25)',
      black: '#1d1b1a', red: '#ba1a2b', green: '#137a43', yellow: '#946000',
      blue: '#1a5bc2', magenta: '#6b38b5', cyan: '#00687d', white: '#e6ddd5',
    };
  }
  return {
    background: seed.darkBg,
    foreground: '#e6eaf0',
    cursor: seed.cursor,
    cursorAccent: seed.darkBg,
    selectionBackground: '#394659',
  };
}
function applyTheme() {
  const scheme = resolvedScheme();
  document.documentElement.dataset.seed = themeSeed;
  document.documentElement.dataset.scheme = scheme;
  for (const b of document.querySelectorAll('#seedPicker .seed-dot')) {
    const on = b.dataset.seed === themeSeed;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  for (const b of document.querySelectorAll('#modePicker button')) {
    const on = b.dataset.mode === themeMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
  const xt = xtermTheme();
  for (const e of open.values()) e.term.options.theme = xt;
  // Match the phone's status / address bar to the app.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) requestAnimationFrame(() => { meta.content = getComputedStyle(document.documentElement).getPropertyValue('--md-surf-low').trim() || meta.content; });
}
function initTheme() {
  try {
    const s = localStorage.getItem('m3Seed');
    const m = localStorage.getItem('m3Mode');
    if (M3_SEEDS.some((x) => x.id === s)) themeSeed = s;
    if (['dark', 'light', 'auto'].includes(m)) themeMode = m;
  } catch {}
  const sp = $('#seedPicker');
  if (sp) {
    sp.replaceChildren(...M3_SEEDS.map((s) =>
      h('button', {
        type: 'button', class: 'seed-dot', role: 'radio', 'data-seed': s.id, title: s.label, 'aria-label': s.label,
        style: `--dot-color:${s.swatch}`,
        onclick: () => { themeSeed = s.id; try { localStorage.setItem('m3Seed', s.id); } catch {} applyTheme(); },
      })));
  }
  for (const b of document.querySelectorAll('#modePicker button')) {
    b.addEventListener('click', () => {
      themeMode = b.dataset.mode;
      try { localStorage.setItem('m3Mode', themeMode); } catch {}
      applyTheme();
    });
  }
  $('#themeQuickToggle')?.addEventListener('click', () => {
    themeMode = resolvedScheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('m3Mode', themeMode); } catch {}
    applyTheme();
  });
  lightQuery.addEventListener?.('change', () => { if (themeMode === 'auto') applyTheme(); });
  applyTheme();
}

// ---------------------------------------------------------------- auth ----
let sessionsTimer = null, openUrlsTimer = null;
function stopBackgroundPolling() {
  clearInterval(sessionsTimer); sessionsTimer = null;
  clearInterval(openUrlsTimer); openUrlsTimer = null;
  clearTimeout(pullTimer); pullTimer = null;
  clearTimeout(testTimer); testTimer = null;
  for (const e of open.values()) {
    clearTimeout(e.reconnTimer); e.reconnTimer = null;
    e.paused = true;
    try { e.ws?.close(); } catch {}
  }
}
function showLogin() {
  stopBackgroundPolling();
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#pw').focus();
}
$('#oauthForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target, msg = $('#oauthMsg');
  busy(f.querySelector('button'), async () => {
    msg.className = ''; msg.textContent = '';
    try { const r = await api('POST', '/api/oauth-callback', { url: f.url.value }); msg.className = r.ok ? 'ok' : 'err'; msg.textContent = r.message; if (r.ok) f.url.value = ''; setTimeout(() => loadStatus().catch(() => {}), 3000); }
    catch (err) { msg.className = 'err'; msg.textContent = err.message; }
  });
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try { await api('POST', '/api/login', { password: $('#pw').value }); $('#pw').value = ''; start(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.reload(); });
$('#logoutAll').addEventListener('click', async () => {
  if (!(await m3Confirm('Sign out all devices', 'Revoke sessions on every browser and device? You will need to sign in again everywhere.', { okLabel: 'Sign out all', danger: true }))) return;
  await api('POST', '/api/logout', { all: true });
  location.reload();
});

// --------------------------------------------------------------- state ----
let status = { agents: {}, github: {}, logins: {} };
let ghRepos = [];
let localRepos = [];
let sessions = [];
const open = new Map(); // session name -> { term, fit, ws, el, tab }
let active = null;

async function loadStatus() {
  status = await api('GET', '/api/status');
  const g = $('#github'); g.replaceChildren();
  if (status.github.connected) {
    g.classList.remove('muted');
    g.append(h('img', { src: status.github.avatar, alt: '' }), h('span', {}, 'GitHub: ', h('b', {}, status.github.login)), h('span', { class: 'badge live' }, status.github.source === 'token' ? 'token' : 'gh'));
  } else {
    g.classList.add('muted');
    g.append('GitHub not connected — use “GitHub login” or set GITHUB_TOKEN.');
  }
  const l = $('#logins'); l.replaceChildren();
  for (const [k, label] of Object.entries(status.logins)) {
    l.append(h('button', { title: `Open a terminal to sign in (${label})`, onclick: (e) => busy(e.target, () => launch({ kind: 'login', agent: k })) }, label));
  }
}

async function loadLocal() {
  localRepos = (await api('GET', '/api/repos/local')).repos;
  renderLocal();
}
// Keep <details> open across re-renders.
const openDetails = new Set();
function keepOpen(key, ...kids) {
  return h('details', { open: openDetails.has(key), ontoggle: (e) => (e.target.open ? openDetails.add(key) : openDetails.delete(key)) }, ...kids);
}

const OLLAMA_CLIS_ORDER = ['pi', 'opencode', 'claude', 'codex', 'qwen', 'dsh'];
const AGENT_LABEL = { pi: 'Pi', opencode: 'OpenCode', claude: 'Claude Code', codex: 'Codex', qwen: 'Qwen Code', dsh: 'DeepSeek Harness' };
const AGENT_SHORT = { pi: 'Pi', opencode: 'OC', claude: 'Claude', codex: 'Codex', qwen: 'Qwen', dsh: 'DSH' };

function agentButtons(repo, wt, small) {
  return Object.entries(status.agents).map(([k, a]) =>
    h('button', { class: 'agent' + (a.installed ? '' : ' dis'), title: a.installed ? `Start ${a.label} in ${repo}${wt ? ` / ${wt}` : ''}` : `${a.label} not installed`,
      onclick: (e) => busy(e.target, () => {
        const model = OLLAMA_CLIS_ORDER.includes(k) ? $('#launchModel').value : '';
        const avail = [...(ollamaState.applied?.[k] || []), ...(ollamaState.applied?.custom?.[k] || [])];
        if (model && !avail.includes(model))
          throw new Error(`${model} isn't configured for ${a.label} yet. Apply it in the Models tab first.`);
        return launch({ agent: k, repo, wt: wt || undefined, yolo: $('#yolo').checked, model: model || undefined });
      }) }, small && k === 'opencode' ? 'OpenCode' : a.label));
}

function gitButton(repo, wt, op, label, confirmText) {
  return h('button', { onclick: (e) => busy(e.target, async () => {
    if (confirmText && !(await m3Confirm(`Confirm ${op}`, confirmText, { okLabel: label }))) return;
    const o = await api('POST', `/api/repos/${encodeURIComponent(repo)}/git`, { op, wt: wt || undefined });
    showDialog(`${op} — ${repo}${wt ? ' / ' + wt : ''}`, o.output || '(no output)'); loadLocal();
  }) }, label);
}

async function newWorktree(r) {
  const branch = await m3Prompt(`New worktree · ${r.name}`, 'Branch name (existing or new):', '', { placeholder: 'feature/login-page', okLabel: 'Next' });
  if (!branch) return;
  const base = await m3Prompt(`Base commit · ${r.name}`, `Start "${branch.trim()}" from which branch/commit?\n(Ignored if the branch already exists.)`, r.branch || 'HEAD', { okLabel: 'Create worktree' });
  if (base === null) return;
  const w = await api('POST', `/api/repos/${encodeURIComponent(r.name)}/worktrees`, { branch: branch.trim(), base: base.trim() });
  openDetails.add(`wt:${r.name}`);
  await loadLocal();
  showDialog('Worktree ready', `${w.created ? 'Created new branch' : 'Checked out existing branch'} "${w.branch}" in its own folder:\n/workspace/.worktrees/${r.name}/${w.name}\n\n` +
    `Start an agent from its row under "worktrees". Agents there can't disturb ${r.branch || 'the main checkout'} or each other. When done: push → PR, then remove the worktree.`);
}

async function removeWorktree(r, w) {
  const dirty = w.dirty > 0;
  const msg = (dirty ? `⚠ It has ${w.dirty} uncommitted change(s) that will be DISCARDED.\n\n` : '') +
    'Agents running in this worktree will be stopped.';
  if (!(await m3Confirm(`Remove worktree "${w.branch}"?`, msg, { okLabel: 'Remove', danger: dirty }))) return;
  const deleteBranch = !w.pushed && w.aheadOfMain === 0 ? true
    : await m3Confirm(`Delete branch "${w.branch}"?`, 'Only happens if it is fully merged; otherwise the branch is kept.', { okLabel: 'Delete branch' });
  const o = await api('DELETE', `/api/repos/${encodeURIComponent(r.name)}/worktrees/${encodeURIComponent(w.name)}`, { force: dirty, deleteBranch });
  await loadLocal(); await loadSessions();
  if (o.note) showDialog('Worktree removed', o.note);
}

function renderWorktrees(r, liveWt) {
  const wts = r.worktrees || [];
  return keepOpen(`wt:${r.name}`,
    h('summary', {}, `worktrees${wts.length ? ` (${wts.length})` : ''}`),
    h('div', { class: 'wts', style: 'margin-top:6px' },
      h('div', { class: 'small muted' }, 'Separate checkouts on their own branch, so several agents can work on this repo at once.'),
      ...wts.map((w) => h('div', { class: 'wt' },
        h('div', { class: 'top' },
          h('span', { class: 'name', title: `/workspace/.worktrees/${r.name}/${w.name}` }, `⎇ ${w.branch}`),
          liveWt.has(`${r.name}/${w.name}`) && h('span', { class: 'badge live' }, 'live'),
          h('span', { class: 'spacer' }),
          w.missing ? h('span', { class: 'badge bad' }, 'missing')
            : h('span', { class: 'badge' + (w.dirty ? ' dirty' : '') }, w.dirty ? `${w.dirty} changed` : 'clean'),
          w.aheadOfMain > 0 && h('span', { class: 'badge', title: `commits not on ${w.mainBranch}` }, `+${w.aheadOfMain}`)),
        !w.missing && h('div', { class: 'actions' }, agentButtons(r.name, w.name, true)),
        h('div', { class: 'actions' },
          !w.missing && gitButton(r.name, w.name, 'status', 'status'),
          !w.missing && h('button', { onclick: () => typeof openDiffViewer === 'function' ? openDiffViewer(r.name, w.name) : null }, 'diff'),
          !w.missing && h('button', { onclick: () => typeof openFileBrowser === 'function' ? openFileBrowser(r.name, w.name) : null }, 'files'),
          !w.missing && gitButton(r.name, w.name, 'push', 'push', `Push branch "${w.branch}" to origin?`),
          !w.missing && gitButton(r.name, w.name, 'pr', 'open PR', `Open a GitHub pull request for "${w.branch}" (title/body from its commits)? Push it first.`),
          h('button', { title: 'Remove this worktree', onclick: (e) => busy(e.target, () => removeWorktree(r, w)) }, 'remove')))),
      h('div', {}, h('button', { onclick: (e) => busy(e.target, () => newWorktree(r)) }, '＋ new worktree'))));
}

function renderLocal() {
  const box = $('#localRepos'); box.replaceChildren();
  if (!localRepos.length) box.append(h('p', { class: 'muted small' }, 'No repositories yet. Clone one from GitHub below, or create a new one with ＋.'));
  const live = new Set(sessions.filter((s) => !s.wt).map((s) => s.repo));
  const liveWt = new Set(sessions.filter((s) => s.wt).map((s) => `${s.repo}/${s.wt}`));
  for (const r of localRepos) {
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: 'name', title: r.remote || '' }, r.name),
        live.has(r.name) && h('span', { class: 'badge live' }, 'live'),
        h('span', { class: 'spacer' }),
        r.git && h('span', { class: 'badge' + (r.dirty ? ' dirty' : '') }, r.dirty ? `${r.dirty} changed` : 'clean')),
      r.git && h('div', { class: 'meta' }, `⎇ ${r.branch}${r.ahead ? `  ↑${r.ahead}` : ''}${r.behind ? `  ↓${r.behind}` : ''}`),
      h('div', { class: 'actions' }, agentButtons(r.name, '')),
      r.git && renderWorktrees(r, liveWt),
      r.git && keepOpen(`git:${r.name}`, h('summary', {}, 'git & tools'),
        h('div', { class: 'actions', style: 'margin-top:6px' },
          h('button', { onclick: () => typeof openDiffViewer === 'function' ? openDiffViewer(r.name, '') : null }, 'diff & commit'),
          h('button', { onclick: () => typeof openFileBrowser === 'function' ? openFileBrowser(r.name, '') : null }, 'files'),
          h('button', { title: 'Run 2 agents on the same prompt in separate worktrees side-by-side', onclick: () => typeof openArena === 'function' ? openArena(r) : null }, '⚔ arena'),
          gitButton(r.name, '', 'status', 'status'), gitButton(r.name, '', 'fetch', 'fetch'),
          gitButton(r.name, '', 'pull', 'pull'), gitButton(r.name, '', 'log', 'log'),
          gitButton(r.name, '', 'push', 'push', `Push ${r.branch} to origin?`),
          h('button', { onclick: (e) => busy(e.target, async () => {
            const c = await m3Prompt(`Delete ${r.name}?`, `Delete ${r.name} (and its worktrees) from the workspace? Unpushed work will be lost.\nType "${r.name}" to confirm:`, '', { placeholder: r.name, okLabel: 'Delete', danger: true });
            if (c !== r.name) return;
            await api('DELETE', `/api/repos/${encodeURIComponent(r.name)}`, { confirm: c }); loadLocal();
          }) }, 'remove')))));
  }
}

async function loadGh(btn) {
  const box = $('#ghRepos');
  box.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
  try { ghRepos = (await api('GET', '/api/repos/github')).repos; renderGh(); }
  catch (e) { box.replaceChildren(h('p', { class: 'err small' }, e.message)); }
}
function renderGh() {
  const q = $('#ghFilter').value.toLowerCase();
  const box = $('#ghRepos'); box.replaceChildren();
  const cloned = new Set(localRepos.map((r) => {
    const m = (r.remote || '').match(/github\.com[:/]+(.+?)(?:\.git)?\/?$/i);
    return m ? m[1].toLowerCase() : '';
  }).filter(Boolean));
  const watched = typeof watchedRepoSet === 'function' ? watchedRepoSet() : new Set();
  const list = ghRepos.filter((r) => !q || r.full_name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
  if (!list.length) box.append(h('p', { class: 'muted small' }, 'No matching repositories.'));
  for (const r of list.slice(0, 200)) {
    const isCloned = cloned.has(r.full_name.toLowerCase());
    const isWatched = watched.has(r.full_name.toLowerCase());
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: 'name', title: r.full_name }, r.full_name),
        r.private && h('span', { class: 'badge' }, 'private'),
        r.archived && h('span', { class: 'badge' }, 'archived'),
        h('span', { class: 'spacer' }),
        typeof toggleWatchRepo === 'function' && h('button', {
          class: isWatched ? 'tonal' : '',
          style: 'font-size:12px;padding:2px 8px',
          title: isWatched ? 'Watching for issues & PRs (click to unwatch)' : 'Watch for issues & PRs in Automations',
          onclick: (e) => busy(e.target, () => toggleWatchRepo(r.full_name, isWatched)),
        }, isWatched ? 'Watching' : 'Watch'),
        typeof openRepoIssues === 'function' && h('button', {
          style: 'font-size:12px;padding:2px 8px',
          title: 'Browse open issues & PRs to fix or review',
          onclick: () => openRepoIssues(r.full_name),
        }, 'Issues/PRs'),
        isCloned ? h('span', { class: 'badge live' }, 'cloned')
          : h('button', { class: 'primary', style: 'font-size:12px;padding:2px 8px', onclick: (e) => busy(e.target, async () => {
              e.target.textContent = 'Cloning…';
              await api('POST', '/api/repos/clone', { full_name: r.full_name });
              await loadLocal(); renderGh();
            }) }, 'Clone')),
      r.description && h('div', { class: 'meta', style: 'font-family:inherit' }, r.description)));
  }
}

async function loadSessions() {
  sessions = (await api('GET', '/api/sessions')).sessions;
  setRailBadge('#railBadgeSessions', sessions.length);
  const box = $('#sessions'); box.replaceChildren();
  if (!sessions.length) box.append(h('p', { class: 'muted small' }, 'No running sessions.'));
  const now = Date.now();
  for (const s of sessions) {
    const idleSec = s.activity ? Math.max(0, Math.floor((now - s.activity) / 1000)) : null;
    const isActive = idleSec !== null && idleSec < 30;
    const isQuiet = idleSec !== null && idleSec >= 120 && s.agent && !['shell', 'update'].includes(s.agent) && !s.agent.startsWith('login');
    box.append(h('div', { class: 'item clickable', onclick: () => attach(s.name, s.label) },
      h('div', { class: 'top' },
        h('span', { class: 'name' }, s.label || s.name),
        h('span', { class: 'meta' }, s.repo ? `${s.repo}${s.wt ? ' / ' + s.wt : ''}` : '~'),
        h('span', { class: 'spacer' }),
        isActive ? h('span', { class: 'badge live', title: 'Recent terminal output' }, 'active')
          : isQuiet ? h('span', { class: 'badge warn', title: `No output for ${Math.floor(idleSec / 60)}m` }, `quiet ${Math.floor(idleSec / 60)}m`) : null,
        s.attached ? h('span', { class: 'badge', title: 'Browser tabs viewing this session' }, `${s.attached} viewing`) : null,
        h('button', { class: 'icon', title: 'Kill session', onclick: async (e) => {
          e.stopPropagation();
          if (!(await m3Confirm('Kill session', `Stop "${s.label || s.name}"? The running agent will be terminated.`, { okLabel: 'Kill session', danger: true }))) return;
          await api('DELETE', `/api/sessions/${encodeURIComponent(s.name)}`); closeTab(s.name); loadSessions();
        } }, '✕'))));
  }
  const liveKey = sessions.map((s) => `${s.repo}/${s.wt}`).sort().join('|');
  if (liveKey !== lastLiveKey) { lastLiveKey = liveKey; renderLocal(); }
}
let lastLiveKey = null;

// ------------------------------------------------------------ terminals ---
async function launch(opts) {
  const { name } = await api('POST', '/api/sessions', opts);
  await loadSessions();
  const s = sessions.find((x) => x.name === name);
  attach(name, s?.label || name);
}

let termFontSize = 13;
try {
  const saved = Number(localStorage.getItem('termFontSize'));
  if (saved >= 10 && saved <= 22) termFontSize = saved;
} catch {}

function setFontSize(next, focus = true) {
  termFontSize = Math.max(10, Math.min(22, next));
  try { localStorage.setItem('termFontSize', String(termFontSize)); } catch {}
  for (const e of open.values()) e.term.options.fontSize = termFontSize;
  const cur = open.get(active);
  if (cur) requestAnimationFrame(() => { try { cur.fit.fit(); } catch {} if (focus) cur.term.focus(); });
}

// Touch: one-finger swipe scrolls (mouse wheel to tmux / the app, or xterm's scrollback),
// with a little momentum; two-finger pinch changes the font size. Taps fall through and focus the terminal.
function attachTouch(term, el) {
  let startY = 0, lastY = 0, lastT = 0, acc = 0, vel = 0, moved = false, raf = 0;
  let pinch0 = 0, pinchFont = 0;
  const lineH = () => Math.max(8, el.clientHeight / Math.max(1, term.rows));
  const wheel = (lines) => {
    if (!lines) return;
    const mouse = term.modes?.mouseTrackingMode && term.modes.mouseTrackingMode !== 'none';
    if (mouse) {
      const e = [...open.values()].find((x) => x.term === term);
      if (e?.ws?.readyState !== 1) return;
      const btn = lines < 0 ? 64 : 65;   // SGR wheel up / down
      const col = Math.max(1, Math.floor(term.cols / 2)), row = Math.max(1, Math.floor(term.rows / 2));
      const seq = `\x1b[<${btn};${col};${row}M`.repeat(Math.min(Math.abs(lines), 12));
      e.ws.send(JSON.stringify({ t: 'i', d: seq }));
    } else {
      term.scrollLines(lines);
    }
  };
  const step = (dy) => {
    acc += dy;
    const lh = lineH();
    const n = Math.trunc(acc / lh);
    if (n) { acc -= n * lh; wheel(-n); }   // finger down = content moves down = scroll up
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  el.addEventListener('touchstart', (ev) => {
    cancelAnimationFrame(raf);
    if (ev.touches.length === 2) { pinch0 = dist(ev.touches); pinchFont = termFontSize; moved = true; return; }
    if (ev.touches.length !== 1) return;
    startY = lastY = ev.touches[0].clientY; lastT = performance.now(); acc = 0; vel = 0; moved = false; pinch0 = 0;
  }, { passive: true });
  el.addEventListener('touchmove', (ev) => {
    if (ev.touches.length === 2 && pinch0) {
      ev.preventDefault();
      const next = Math.round(pinchFont * (dist(ev.touches) / pinch0));
      if (next !== termFontSize && next >= 10 && next <= 22) setFontSize(next, false);
      return;
    }
    if (ev.touches.length !== 1 || pinch0) return;
    const y = ev.touches[0].clientY, now = performance.now();
    if (!moved && Math.abs(y - startY) < 8) return;
    moved = true;
    ev.preventDefault();
    const dy = y - lastY;
    vel = dy / Math.max(1, now - lastT);
    lastY = y; lastT = now;
    step(dy);
  }, { passive: false });
  el.addEventListener('touchend', (ev) => {
    if (pinch0) { if (ev.touches.length === 0) pinch0 = 0; return; }
    if (!moved) return;                        // a tap: let xterm focus / open the keyboard
    ev.preventDefault();                       // a swipe: don't turn it into a click
    if (Math.abs(vel) < 0.3) return;
    let v = vel * 16, last = performance.now();
    const glide = (t) => {
      const dt = Math.min(48, t - last); last = t;
      v *= Math.pow(0.95, dt / 16);
      if (Math.abs(v) < 0.6) return;
      step(v * dt / 16);
      raf = requestAnimationFrame(glide);
    };
    raf = requestAnimationFrame(glide);
  }, { passive: false });
}

function sendRawToActive(seq) {
  const e = open.get(active);
  if (!e || e.ws?.readyState !== 1) return;
  e.ws.send(JSON.stringify({ t: 'i', d: seq }));
  e.term.focus();
}

// Sticky modifiers for the on-screen keybar: tap = next key only, double-tap = locked until tapped again.
const mods = { ctrl: 0, alt: 0 };   // 0 off, 1 one-shot, 2 locked
const modBtns = {};
function renderMods() {
  for (const [k, b] of Object.entries(modBtns)) {
    b.classList.toggle('armed', mods[k] === 1);
    b.classList.toggle('locked', mods[k] === 2);
    b.setAttribute('aria-pressed', String(mods[k] > 0));
  }
}
function consumeMods() {
  for (const k of Object.keys(mods)) if (mods[k] === 1) mods[k] = 0;
  renderMods();
}
// Apply armed Ctrl/Alt to input typed on the phone keyboard (or a keybar key).
function applyMods(d) {
  if (!mods.ctrl && !mods.alt) return d;
  if (d.length !== 1 && !/^\x1b\[[ABCD]$/.test(d)) return d;          // leave pastes / terminal replies alone
  let out = d;
  if (mods.ctrl && d.length === 1) {
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);       // A-Z [ \ ] ^ _
    else if (d === ' ' || d === '2' || d === '@') out = '\x00';
    else if (d === '/' || d === '7') out = '\x1f';
    else if (d === '?' || d === '8') out = '\x7f';
  } else if (mods.ctrl && /^\x1b\[[ABCD]$/.test(d)) {
    out = `\x1b[1;5${d[2]}`;                                           // Ctrl+arrow (word jump)
  }
  if (mods.alt) out = '\x1b' + out;
  consumeMods();
  return out;
}

function initKeybar() {
  const keys = [
    ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', 'mod:ctrl'], ['Alt', 'mod:alt'],
    ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
    '|',
    ['^C', '\x03'], ['^D', '\x04'], ['^R', '\x12'], ['^L', '\x0c'], ['^Z', '\x1a'], ['S-Tab', '\x1b[Z'],
    '|',
    ['/', '/'], ['-', '-'], ['|', '|'], ['~', '~'], ['`', '`'],
    '|',
    ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'], ['⏎', '\r'],
    '|',
    ['A−', 'font:-1'], ['A+', 'font:1'],
  ];
  const bar = $('#keybar'), btn = $('#keysToggle');
  const lastTap = {};
  bar.replaceChildren(...keys.map((k) => {
    if (k === '|') return h('span', { class: 'sep', 'aria-hidden': 'true' });
    const [label, seq] = k;
    const attrs = { type: 'button', onmousedown: (ev) => ev.preventDefault() };   // keep the terminal focused (keyboard stays up)
    if (seq.startsWith('mod:')) {
      const m = seq.slice(4);
      attrs.class = 'mod';
      attrs.title = `${label}: tap for the next key, double-tap to lock`;
      attrs.onclick = () => {
        const now = Date.now();
        if (mods[m] === 1 && now - (lastTap[m] || 0) < 350) mods[m] = 2;
        else mods[m] = mods[m] ? 0 : 1;
        lastTap[m] = now;
        renderMods();
        open.get(active)?.term.focus();
      };
      const b = h('button', attrs, label);
      modBtns[m] = b;
      return b;
    }
    if (seq.startsWith('font:')) {
      attrs.onclick = () => setFontSize(termFontSize + Number(seq.slice(5)));
      attrs.title = 'Terminal font size (or pinch the terminal)';
      return h('button', attrs, label);
    }
    attrs.onclick = () => sendRawToActive(applyMods(seq));
    return h('button', attrs, label);
  }));
  const setOpen = (on) => {
    bar.classList.toggle('hidden', !on);
    btn.classList.toggle('active', on);
    try { localStorage.setItem('keybar', on ? '1' : '0'); } catch {}
    const cur = open.get(active);
    if (cur) requestAnimationFrame(() => { try { cur.fit.fit(); } catch {} });
  };
  let initial = false;
  try {
    const saved = localStorage.getItem('keybar');
    initial = saved !== null ? saved === '1' : window.matchMedia('(pointer: coarse)').matches;
  } catch {}
  if (initial) setOpen(true);
  btn.addEventListener('click', () => setOpen(bar.classList.contains('hidden')));
}

function attach(name, label) {
  closeMobileSheet();
  if (open.has(name)) return activate(name);
  const el = h('div', { class: 'term' });
  $('#terms').append(el);
  const term = new Terminal({
    cursorBlink: true, fontSize: termFontSize, scrollback: 5000, allowProposedApi: true,
    fontFamily: 'ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: xtermTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit); term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(el);
  // Phone keyboards: no auto-capitalize / autocorrect / predictive junk in the terminal.
  if (term.textarea) {
    for (const [k, v] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['autocomplete', 'off'], ['spellcheck', 'false'], ['enterkeyhint', 'send']]) term.textarea.setAttribute(k, v);
  }
  attachTouch(term, el);
  // Let the browser handle paste/copy shortcuts instead of sending ^V / ^C to the program.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'v') return false;              // native paste event -> xterm -> pty
    if (k === 'c' && term.hasSelection() && (e.metaKey || (e.ctrlKey && e.shiftKey))) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });
  const dot = h('span', { class: 'dot', title: 'connecting' });
  const tab = h('button', { class: 'tab', onclick: () => activate(name) }, dot, h('span', {}, label),
    h('span', { class: 'x', title: 'Close tab (session keeps running)', onclick: (e) => { e.stopPropagation(); closeTab(name); } }, '×'));
  $('#tabs').append(tab);
  const entry = { term, fit, el, tab, dot, ws: null, closed: false, paused: false, bytes: 0, retries: 0, reconnTimer: null };
  el.addEventListener('mousedown', () => {
    if (splitMode && active !== name) {
      splitSecondary = active;
      active = name;
      renderTermLayout();
    }
  });
  open.set(name, entry);
  activate(name);
  connect(name, entry);
  term.onData((d) => entry.ws?.readyState === 1 && entry.ws.send(JSON.stringify({ t: 'i', d: applyMods(d) })));
  term.onResize(({ cols, rows }) => entry.ws?.readyState === 1 && entry.ws.send(JSON.stringify({ t: 'r', c: cols, r: rows })));
}

function connect(name, entry) {
  clearTimeout(entry.reconnTimer); entry.reconnTimer = null;
  entry.paused = false;
  try { entry.fit.fit(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term?session=${encodeURIComponent(name)}&cols=${entry.term.cols}&rows=${entry.term.rows}`);
  entry.ws = ws;
  const setDot = (cls, title) => { entry.dot.className = 'dot ' + cls; entry.dot.title = title; };
  ws.onopen = () => { entry.retries = 0; setDot('on', 'connected'); };
  ws.onmessage = (ev) => {
    const d = typeof ev.data === 'string' ? ev.data : '';
    entry.bytes += d.length;
    entry.term.write(d);
    setDot('on', `connected · ${entry.bytes} bytes received`);
  };
  ws.onerror = () => setDot('off', 'connection error');
  ws.onclose = (ev) => {
    setDot('off', `disconnected (code ${ev.code})`);
    if (entry.closed || entry.paused) return;
    const delay = Math.min(15000, 1500 * Math.pow(2, entry.retries));
    entry.retries = Math.min(entry.retries + 1, 5);
    entry.term.write('\r\n\x1b[33m[disconnected — reconnecting…]\x1b[0m\r\n');
    entry.reconnTimer = setTimeout(async () => {
      if (entry.closed || entry.paused) return;
      try { await loadSessions(); } catch { return; }
      if (entry.closed || entry.paused) return;
      if (sessions.some((s) => s.name === name)) connect(name, entry);
      else entry.term.write('\x1b[31m[session ended]\x1b[0m\r\n');
    }, delay);
  };
}

// Type text into the active terminal (bracketed paste when the program supports it).
function sendToActive(text, enter) {
  const e = open.get(active);
  if (!e) { showDialog('No terminal open', 'Open the session first, then paste.'); return false; }
  if (text) e.term.paste(text);
  if (enter) setTimeout(() => e.ws?.readyState === 1 && e.ws.send(JSON.stringify({ t: 'i', d: '\r' })), 50);
  e.term.focus();
  return true;
}
async function pasteDialog() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}   // only works on https/localhost
  if (!text) text = (await m3Prompt('Paste into terminal', 'Enter or paste text to send to the active terminal:', '', { okLabel: 'Send' })) || '';
  if (text) sendToActive(text, false);
}

let splitMode = false;
let splitSecondary = null;

function renderTermLayout() {
  const container = $('#terms');
  const validSec = splitMode && splitSecondary && open.has(splitSecondary) && splitSecondary !== active ? splitSecondary : null;
  if (splitMode && !validSec && open.size >= 2) {
    const other = [...open.keys()].find((k) => k !== active);
    if (other) splitSecondary = other;
  }
  const showSplit = splitMode && splitSecondary && open.has(splitSecondary) && splitSecondary !== active && !isMobile();
  container.classList.toggle('split', !!showSplit);
  $('#splitBtn')?.classList.toggle('active', splitMode);

  for (const [n, e] of open) {
    const isPrim = n === active;
    const isSec = showSplit && n === splitSecondary;
    e.el.classList.toggle('hidden', !isPrim && !isSec);
    e.el.classList.toggle('split-focused', showSplit && isPrim);
    e.el.classList.toggle('split-secondary', isSec);
    e.tab.classList.toggle('active', isPrim);
    e.tab.classList.toggle('split-peer', isSec);
  }
  $('#empty').classList.toggle('hidden', open.size > 0);
  requestAnimationFrame(() => {
    const p = open.get(active);
    const s = showSplit ? open.get(splitSecondary) : null;
    try { p?.fit.fit(); } catch {}
    try { s?.fit.fit(); } catch {}
    p?.term.focus();
  });
}

function toggleSplit() {
  if (open.size < 2 && !splitMode) {
    showDialog('Split view', 'Open at least 2 terminal sessions first to view them side-by-side.');
    return;
  }
  splitMode = !splitMode;
  if (splitMode && (!splitSecondary || splitSecondary === active || !open.has(splitSecondary))) {
    splitSecondary = [...open.keys()].find((k) => k !== active) || null;
  }
  renderTermLayout();
}

function setSplitPair(first, second) {
  active = first;
  splitSecondary = second;
  splitMode = !!(first && second && first !== second);
  renderTermLayout();
}

function activate(name) {
  if (splitMode && active && active !== name && open.has(active)) {
    splitSecondary = active;
  }
  active = name;
  renderTermLayout();
}

function closeTab(name) {
  const e = open.get(name); if (!e) return;
  clearTimeout(e.reconnTimer); e.reconnTimer = null;
  e.closed = true; e.ws?.close(); e.term.dispose(); e.el.remove(); e.tab.remove(); open.delete(name);
  if (splitSecondary === name) splitSecondary = null;
  if (active === name) {
    const next = [...open.keys()].pop();
    if (next) { active = next; } else { active = null; splitMode = false; }
  }
  if (open.size < 2) splitMode = false;
  renderTermLayout();
}

// Size the app to the *visible* viewport so the on-screen keyboard never covers the terminal.
let fitTimer = 0;
function refitSoon() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const e = open.get(active); if (e) try { e.fit.fit(); } catch {}
    if (splitMode && splitSecondary) { const s = open.get(splitSecondary); if (s) try { s.fit.fit(); } catch {} }
  }, 60);
}
let vpWidth = 0, vpMaxH = 0;
function syncViewport() {
  const vv = window.visualViewport;
  const hgt = vv ? vv.height : window.innerHeight;
  const root = document.documentElement;
  root.style.setProperty('--app-h', `${Math.round(hgt)}px`);
  // Keyboard is up when the visible height drops well below the tallest we've seen at this width
  // (works whether the browser resizes the layout viewport or only the visual one).
  const w = Math.round(window.innerWidth);
  if (w !== vpWidth) { vpWidth = w; vpMaxH = 0; }
  vpMaxH = Math.max(vpMaxH, hgt, window.innerHeight);
  const kb = window.matchMedia('(pointer: coarse)').matches && vpMaxH - hgt > 150;
  root.classList.toggle('kb-open', kb);
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);   // iOS pans the page when the keyboard opens
  refitSoon();
}
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
document.addEventListener('focusout', () => setTimeout(syncViewport, 120));
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncViewport(); });
syncViewport();

// -------------------------------------------------------------- wiring ----
$('#pasteBtn').addEventListener('click', pasteDialog);
$('#fontDown').addEventListener('click', () => setFontSize(termFontSize - 1));
$('#fontUp').addEventListener('click', () => setFontSize(termFontSize + 1));
initKeybar();
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (document.querySelector('dialog[open]')) return;
  const idx = Number(e.key) - 1;
  if (idx >= 0 && idx < 9) {
    const names = [...open.keys()];
    if (names[idx]) { e.preventDefault(); activate(names[idx]); }
  }
});
$('#refreshStatus').addEventListener('click', (e) => busy(e.target, async () => { await loadStatus(); renderLocal(); if (status.github.connected) loadGh(); }));
$('#refreshLocal').addEventListener('click', (e) => busy(e.target, loadLocal));
$('#refreshSessions').addEventListener('click', (e) => busy(e.target, loadSessions));
$('#loadGh').addEventListener('click', (e) => busy(e.target, () => loadGh()));
$('#ghFilter').addEventListener('input', renderGh);
$('#openSide').addEventListener('click', openMobileSheet);
$('#closeSide').addEventListener('click', closeMobileSheet);
$('#sideScrim').addEventListener('click', closeMobileSheet);
$('#newRepoBtn').addEventListener('click', (e) => busy(e.target, async () => {
  const name = await m3Prompt('New repository', 'Repository name (letters, digits, . _ -):', '', { placeholder: 'my-project', okLabel: 'Next' });
  if (!name) return;
  const github = status.github.connected && await m3Confirm('Create on GitHub?', `Also create a private GitHub repository "${name.trim()}" and set it as origin?`, { okLabel: 'Create on GitHub' });
  await api('POST', '/api/repos/create', { name: name.trim(), github });
  await loadLocal();
}));
try { $('#yolo').checked = localStorage.getItem('yolo') === '1'; } catch {}
$('#yolo').addEventListener('change', () => { try { localStorage.setItem('yolo', $('#yolo').checked ? '1' : '0'); } catch {} });

// --------------------------------------------------------------- ollama ----
let ollamaState = {};
let pullTimer = null;
const gb = (n) => (n / 1e9).toFixed(1) + ' GB';
const kctx = (n) => (n >= 1024 ? Math.round(n / 1024) + 'k' : String(n));

let testState = { results: {}, queue: [] }, testTimer = null;
let labMode = 'coding';
let labSelected = null; // { model, agent }
let labCliSelection = new Set(OLLAMA_CLIS_ORDER);

async function loadTests() {
  testState = await api('GET', '/api/ollama/tests');
  clearTimeout(testTimer);
  if (testState.running || testState.queue.length) {
    testTimer = setTimeout(() => loadTests().then(() => { renderOllamaModels(); renderLab(); }).catch(() => {}), 2500);
  }
  return testState;
}
const TEST_ICON = { pass: '✓', partial: '≈', loop: '↻', timeout: '⏱', no_tools: '✗', no_edit: '✗', wrong: '✗', error: '✗' };
const verdictClass = (v) => (v === 'pass' ? 'live' : v === 'partial' ? 'warn' : 'bad');

function testBadges(name) {
  const r = testState.results?.[name] || {}, run = testState.running;
  return OLLAMA_CLIS_ORDER.map((k) => {
    const l = AGENT_SHORT[k] || k;
    if (run?.model === name && run.agent === k) return h('span', { class: 'badge warn', title: `Testing ${AGENT_LABEL[k]} now` }, `${l} …`);
    if (testState.queue?.some((q) => q.model === name && q.agent === k)) return h('span', { class: 'badge', title: `${AGENT_LABEL[k]} queued` }, `${l} queued`);
    const t = r[k]; if (!t) return null;
    const cls = verdictClass(t.verdict);
    return h('span', {
      class: 'badge ' + cls,
      style: 'cursor:pointer',
      title: `${AGENT_LABEL[k]} (${t.mode || 'coding'}): ${t.text} — click to inspect in Lab`,
      onclick: () => openOllamaLab({ model: name, agent: k }),
    }, `${l} ${TEST_ICON[t.verdict] || '?'}${t.verdict === 'pass' ? ' ' + t.secs + 's' : ' ' + t.verdict.replace('_', ' ')}`);
  });
}

function testPanel(m) {
  const r = testState.results?.[m.name] || {}, run = testState.running?.model === m.name ? testState.running : null;
  const busyHere = run || testState.queue?.some((q) => q.model === m.name);
  const testedCount = OLLAMA_CLIS_ORDER.filter((k) => r[k]).length;
  return h('div', { class: 'olm-test' },
    h('div', { class: 'row' },
      h('button', { style: 'font-size:11px;padding:3px 8px', disabled: !!busyHere,
        title: 'Tests this model across all 6 Ollama-capable CLIs (Pi, OpenCode, Claude, Codex, Qwen, DSH) in throwaway repos.',
        onclick: (e) => busy(e.target, async () => { await api('POST', '/api/ollama/tests', { model: m.name, mode: labMode }); await loadTests(); renderOllamaModels(); renderLab(); }) },
        busyHere ? 'Testing…' : testedCount ? 'Re-test all 6 CLIs' : 'Test all 6 CLIs'),
      h('button', { style: 'font-size:11px;padding:3px 8px', class: 'tonal',
        onclick: () => openOllamaLab({ model: m.name, agent: OLLAMA_CLIS_ORDER.find((k) => r[k]) || 'pi' }) }, 'Lab matrix…'),
      busyHere && h('button', { style: 'font-size:11px;padding:3px 8px', onclick: (e) => busy(e.target, async () => { await api('POST', '/api/ollama/tests/cancel'); await loadTests(); renderOllamaModels(); renderLab(); }) }, 'Stop')),
    ...OLLAMA_CLIS_ORDER.map((k) => r[k] && h('div', { class: 'small' },
      h('b', {}, `${AGENT_SHORT[k]}: `), r[k].text, h('span', { class: 'muted' }, ` · ${ago(r[k].at)}`),
      r[k].verdict !== 'pass' && r[k].diff ? keepOpen(`oltd:${m.name}:${k}`, h('summary', {}, 'what it changed'), h('pre', { class: 'olm-live' }, r[k].diff)) : null)),
    run && h('div', { class: 'small muted' }, `${AGENT_LABEL[run.agent] || run.agent} running for ${Math.round((Date.now() - run.startedAt) / 1000)}s (max ${Math.round((testState.timeoutSeconds || 300) / 60)} min)…`),
    run && run.live?.length ? h('pre', { class: 'olm-live' }, run.live.slice(-6).join('\n')) : null);
}

function runtimeWarningText(s) {
  const running = s.running || [];
  if (!running.length) return '';
  const small = running.filter((r) => r.contextLength && r.contextLength < 16384);
  if (small.length) {
    return `⚠ Ollama currently loaded ${small.map((r) => `${r.name} at ${kctx(r.contextLength)} ctx`).join(', ')} (server default). CLIs like Codex/Qwen/OpenCode send 6k–10k prompt tokens; set OLLAMA_CONTEXT_LENGTH=32768 on your Ollama PC or create a 32k variant copy for best tool calling.`;
  }
  return '';
}

async function loadOllama() {
  await loadTests().catch(() => {});
  const s = ollamaState = await api('GET', '/api/ollama');
  if (document.activeElement !== $('#ollamaUrl')) $('#ollamaUrl').value = s.url || '';
  if (document.activeElement !== $('#serverCtx')) $('#serverCtx').value = s.serverCtx;
  const st = $('#ollamaStatus'); st.replaceChildren(); st.className = 'small';
  if (!s.url) {
    st.classList.add('muted');
    st.append('Enter the address of the PC running Ollama. On that PC set ', h('code', {}, 'OLLAMA_HOST=0.0.0.0'), ', restart Ollama and allow port 11434 through its firewall.');
  } else if (s.connected) {
    st.append(h('span', { class: 'badge live' }, 'connected'), ` Ollama ${s.version} · ${s.models.length} model(s)`);
  } else {
    st.append(h('span', { class: 'err' }, s.error || 'not reachable'));
  }
  const rt = $('#ollamaRuntimeInfo');
  if (rt) {
    const warn = s.connected ? runtimeWarningText(s) : '';
    const loaded = s.connected && s.running?.length ? s.running.map((r) => `${r.name}${r.contextLength ? ` (${kctx(r.contextLength)} ctx)` : ''}`).join(', ') : '';
    rt.replaceChildren();
    if (warn) {
      rt.className = 'usage limited';
      rt.textContent = warn;
    } else if (loaded) {
      rt.className = 'small muted';
      rt.textContent = `Loaded in Ollama: ${loaded}`;
    } else {
      rt.className = 'small hidden';
    }
  }
  $('#ollamaBody').classList.toggle('hidden', !s.connected);
  renderOllamaModels(); renderPulls(); renderLaunchModels(); renderLab();
  schedulePullPoll(s.pulls);
}

function schedulePullPoll(pulls) {
  clearTimeout(pullTimer); pullTimer = null;
  const anyPulling = Object.values(pulls || {}).some((p) => !p.done);
  if (anyPulling) pullTimer = setTimeout(() => pollPulls().catch(() => {}), 2000);
}

async function pollPulls() {
  const { pulls } = await api('GET', '/api/ollama/pulls');
  const prev = ollamaState.pulls || {};
  const newlyDone = Object.entries(pulls || {}).some(([k, p]) => p.done && !prev[k]?.done);
  ollamaState.pulls = pulls;
  renderPulls();
  if (newlyDone) {
    await loadOllama();
  } else {
    schedulePullPoll(pulls);
  }
}

function renderOllamaModels() {
  const s = ollamaState, box = $('#ollamaModels');
  const prev = box.querySelector('.olm') ? new Set([...box.querySelectorAll('.olm:checked')].map((c) => c.value)) : null; // keep unsaved ticks on re-render
  box.replaceChildren();
  if (!s.connected) return;
  const configured = new Set(OLLAMA_CLIS_ORDER.flatMap((k) => s.applied?.[k] || []));
  if (!s.models.length) box.append(h('p', { class: 'muted small' }, 'No models on this Ollama server yet. Pull one below.'));
  for (const m of s.models) {
    const ctx = m.numCtx || s.serverCtx;
    const ctxCls = ctx >= 32768 ? 'live' : ctx >= 16384 ? '' : 'warn';
    const canGrow = (m.ctxMax || 131072) > ctx && ctx < 32768;
    const target = Math.min(32768, m.ctxMax || 32768);
    const id = 'olm-' + m.name.replace(/[^A-Za-z0-9]/g, '_');
    const where = OLLAMA_CLIS_ORDER.filter((k) => (s.applied?.[k] || []).includes(m.name)).map((k) => AGENT_SHORT[k]);
    box.append(h('div', { class: 'item check' },
      h('input', { type: 'checkbox', id, class: 'olm', value: m.name, checked: prev ? prev.has(m.name) : configured.has(m.name) || (!configured.size && m.tools && ctx >= 16384) }),
      h('div', { class: 'olm-body' },
        h('div', { class: 'top' },
          h('label', { for: id, class: 'name', title: m.name }, m.name),
          h('span', { class: 'spacer' }),
          h('button', { class: 'icon', title: `Delete ${m.name} from Ollama`, onclick: (e) => busy(e.target, async () => {
            if (!(await m3Confirm(`Delete ${m.name}?`, `Delete ${m.name} from the Ollama server? This frees ${gb(m.size)} on that PC.`, { okLabel: 'Delete', danger: true }))) return;
            await api('DELETE', '/api/ollama/models', { model: m.name }); await loadOllama();
          }) }, '✕')),
        h('div', { class: 'top badges' },
          m.params && h('span', { class: 'badge' }, m.params),
          h('span', { class: 'badge' }, gb(m.size)),
          h('span', { class: 'badge ' + ctxCls, title: m.numCtx ? 'num_ctx set on this model' : 'server default — no num_ctx on this model' }, `ctx ${kctx(ctx)}${m.numCtx ? '' : '*'}`),
          m.tools ? h('span', { class: 'badge live' }, 'tools') : h('span', { class: 'badge bad', title: 'Coding agents need tool calling; this model will likely not work' }, 'no tools'),
          m.thinking && h('span', { class: 'badge' }, 'thinking'),
          m.vision && h('span', { class: 'badge' }, 'vision'),
          m.cloud && h('span', { class: 'badge cloud' }, 'cloud'),
          where.length ? h('span', { class: 'badge ok', title: `Configured in ${where.join(', ')}` }, `✓ ${where.join(' · ')}`) : null,
          ...testBadges(m.name)),
        keepOpen(`olm:${m.name}`, h('summary', {}, canGrow ? 'details · context too small' : 'details'),
          m.usage && h('div', { class: 'usage ' + m.usage.level }, m.usage.text),
          h('div', { class: 'small muted' }, 'Configured in: ', where.length ? where.join(', ') : 'not yet — tick it and click Apply'),
          m.tools && testPanel(m),
          canGrow && h('div', { class: 'small' },
            h('button', { style: 'font-size:11px;padding:2px 6px', title: `Creates a copy of this model with num_ctx ${target}. Uses more memory on the Ollama PC.`,
              onclick: (e) => busy(e.target, async () => {
                const r = await api('POST', '/api/ollama/variant', { model: m.name, num_ctx: target });
                await loadOllama();
                const cb = [...document.querySelectorAll('.olm')].find((c) => c.value === r.name); if (cb) cb.checked = true;
              }) }, `Make agent-ready copy (${kctx(target)} ctx)`),
            h('span', { class: 'muted' }, ' — small context breaks tool calls'))))));
  }
  $('#modelsCount').textContent = `Models on this server (${s.models.length})`;
  const def = $('#ollamaDefault'), cur = def.value;
  def.replaceChildren(h('option', { value: '' }, 'default: unchanged'), ...s.models.map((m) => h('option', { value: m.name }, `default: ${m.name}`)));
  def.value = s.models.some((m) => m.name === cur) ? cur : '';
  const a = s.applied || {};
  $('#appliedInfo').textContent = OLLAMA_CLIS_ORDER
    .map((k) => {
      const list = a[k] || [];
      return `${AGENT_SHORT[k]}: ${list.length || '0'}`;
    }).join(' · ');
}

function renderPulls() {
  const box = $('#pulls'); box.replaceChildren();
  let activeCount = 0;
  for (const [name, p] of Object.entries(ollamaState.pulls || {})) {
    if (!p.done) activeCount++;
    if (p.done && p.status === 'success') continue;
    const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' }, h('span', { class: 'name' }, name), h('span', { class: 'spacer' }), h('span', { class: 'meta' }, p.error ? 'failed' : `${p.status} ${p.total ? pct + '%' : ''}`)),
      p.error ? h('div', { class: 'err small' }, p.error) : h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` }))));
  }
  setRailBadge('#railBadgePulls', activeCount);
}

function renderLaunchModels() {
  const sel = $('#launchModel'), cur = sel.value;
  const a = ollamaState.applied || {};
  const ollamaNames = [...new Set(OLLAMA_CLIS_ORDER.flatMap((k) => a[k] || []))].sort();
  const customNames = [...new Set([...(a.custom?.opencode || []), ...(a.custom?.pi || [])])].sort();
  const all = [...ollamaNames, ...customNames];
  sel.replaceChildren(
    h('option', { value: '' }, 'agent default'),
    ...ollamaNames.map((n) => h('option', { value: n }, `ollama · ${n}`)),
    ...customNames.map((n) => h('option', { value: n }, n)),
  );
  let saved = cur; try { saved ||= localStorage.getItem('launchModel') || ''; } catch {}
  sel.value = all.includes(saved) ? saved : '';
}

// ----------------------------------------- Ollama × CLI Compatibility Lab ----
function openOllamaLab(initialSel) {
  if (initialSel) labSelected = initialSel;
  closeMobileSheet();
  const dlg = $('#ollamaLabDlg');
  if (!dlg.open) dlg.showModal();
  loadTests().then(renderLab).catch(() => renderLab());
}

function renderLabDiff(diffText) {
  const box = h('div', { class: 'diff-view', style: 'max-height:220px' });
  for (const line of String(diffText || '').split('\n')) {
    let cls = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) cls += ' diff-meta';
    else if (line.startsWith('@@')) cls += ' diff-hunk';
    else if (line.startsWith('+')) cls += ' diff-add';
    else if (line.startsWith('-')) cls += ' diff-del';
    box.append(h('div', { class: cls }, line || ' '));
  }
  return box;
}

function renderLabDetail() {
  const box = $('#labDetailBox');
  if (!box) return;
  if (!labSelected) { box.classList.add('hidden'); return; }
  const { model, agent } = labSelected;
  const r = testState.results?.[model]?.[agent];
  const isRunning = testState.running?.model === model && testState.running?.agent === agent;
  const isQueued = testState.queue?.some((q) => q.model === model && q.agent === agent);
  box.classList.remove('hidden');
  box.replaceChildren();

  const cliMeta = testState.agents?.[agent] || {};
  box.append(
    h('div', { class: 'row wrap', style: 'justify-content:space-between' },
      h('div', { class: 'row wrap' },
        h('b', { style: 'font-size:14px' }, model),
        h('span', { class: 'badge size' }, AGENT_LABEL[agent] || agent),
        cliMeta.protocol && h('span', { class: 'badge' }, cliMeta.protocol),
        r && h('span', { class: 'badge ' + verdictClass(r.verdict) }, `${TEST_ICON[r.verdict] || '?'} ${r.verdict.replace('_', ' ')}`),
        r?.mode && h('span', { class: 'badge' }, r.mode === 'tool_smoke' ? 'tool smoke' : 'coding edit')),
      h('div', { class: 'row tight' },
        h('button', {
          class: 'primary', style: 'font-size:12px;padding:4px 12px', disabled: isRunning || isQueued,
          onclick: (e) => busy(e.target, async () => {
            await api('POST', '/api/ollama/tests', { model, agents: [agent], mode: labMode });
            await loadTests(); renderOllamaModels(); renderLab();
          }),
        }, isRunning ? 'Running…' : isQueued ? 'Queued' : (r ? 'Re-test' : 'Run test')),
        r && h('button', {
          style: 'font-size:12px;padding:4px 10px',
          onclick: (e) => busy(e.target, async () => {
            await api('DELETE', '/api/ollama/tests', { model, agent });
            await loadTests(); renderOllamaModels(); renderLab();
          }),
        }, 'Clear'))));

  if (isRunning) {
    const secs = Math.round((Date.now() - testState.running.startedAt) / 1000);
    box.append(h('div', { class: 'small muted' }, `Running ${testState.running.mode || 'coding'} test for ${secs}s…`));
    if (testState.running.live?.length) box.append(h('pre', { class: 'olm-live', style: 'max-height:160px' }, testState.running.live.join('\n')));
    return;
  }
  if (!r) {
    box.append(h('div', { class: 'small muted' }, 'Not tested yet. Click “Run test” above to verify tool calls and loop safety on this model × CLI pair.'));
    return;
  }

  box.append(
    h('div', { class: 'small' }, r.text),
    h('div', { class: 'row wrap small muted' },
      h('span', { class: 'badge' }, `${r.secs ?? 0}s`),
      h('span', { class: 'badge' }, `${r.tools ?? 0} tool call${r.tools === 1 ? '' : 's'}`),
      r.maxPromptTokens > 0 && h('span', { class: 'badge' }, `peak ${r.maxPromptTokens.toLocaleString()} prompt tok`),
      h('span', {}, `tested ${ago(r.at)}`)));

  if (r.loop) {
    box.append(h('div', { class: 'usage none' }, `⛔ Loop guard triggered: "${r.loop.call}" repeated ${r.loop.times}×${r.loop.kind ? ` (${r.loop.kind})` : ''}. Stopped cleanly to prevent infinite looping.`));
  }
  if (r.errors?.length) {
    box.append(h('div', { class: 'usage none' }, `Errors: ${r.errors.join(' | ')}`));
  }
  if (r.calls?.length) {
    box.append(
      h('div', { class: 'watch-group-title', style: 'margin-top:4px' }, `Tool call trace (${r.calls.length})`),
      h('ol', { class: 'lab-trace' }, ...r.calls.map((c) => h('li', {}, c))));
  }
  if (r.lastText) {
    box.append(
      h('div', { class: 'watch-group-title', style: 'margin-top:4px' }, 'Final assistant reply'),
      h('pre', { class: 'olm-live', style: 'max-height:110px' }, r.lastText));
  }
  if (r.diff) {
    box.append(
      h('div', { class: 'watch-group-title', style: 'margin-top:4px' }, 'Git diff'),
      renderLabDiff(r.diff));
  }
}

function renderLab() {
  const dlg = $('#ollamaLabDlg');
  if (!dlg || !dlg.open) return;

  // Mode segmented buttons
  for (const b of document.querySelectorAll('#labModePicker button')) {
    b.classList.toggle('active', b.dataset.mode === labMode);
  }

  // CLI filter chips
  const chips = $('#labCliChips');
  chips.replaceChildren(...OLLAMA_CLIS_ORDER.map((k) => {
    const installed = status.agents?.[k]?.installed !== false;
    const cb = h('input', {
      type: 'checkbox', checked: labCliSelection.has(k), disabled: !installed,
      onchange: (e) => { if (e.target.checked) labCliSelection.add(k); else labCliSelection.delete(k); },
    });
    return h('label', { class: 'chip-check', title: `${AGENT_LABEL[k]} · ${testState.agents?.[k]?.protocol || ''}${installed ? '' : ' (not installed)'}` },
      cb, h('span', {}, AGENT_SHORT[k]));
  }));

  // Unsupported CLIs note
  const unsup = testState.unsupportedAgents || ollamaState.unsupportedClis || {};
  const unsupParts = Object.values(unsup).map((u) => `${u.label} (${u.reason})`);
  $('#labUnsupportedNote').textContent = unsupParts.length ? `Not Ollama-compatible: ${unsupParts.join(' · ')}` : '';

  // Runtime context warning
  const warn = runtimeWarningText(ollamaState);
  const warnEl = $('#labRuntimeWarn');
  warnEl.textContent = warn;
  warnEl.classList.toggle('hidden', !warn);

  // Live run banner + Stop button
  const running = testState.running;
  const qLen = testState.queue?.length || 0;
  $('#labStop').classList.toggle('hidden', !running && !qLen);
  const liveBox = $('#labLiveBox');
  if (running || qLen) {
    liveBox.classList.remove('hidden');
    const secs = running ? Math.round((Date.now() - running.startedAt) / 1000) : 0;
    liveBox.replaceChildren(
      h('div', { class: 'row wrap', style: 'justify-content:space-between' },
        h('div', { class: 'row wrap' },
          h('span', { class: 'badge warn' }, '● Running'),
          running && h('b', {}, `${running.model} × ${AGENT_LABEL[running.agent] || running.agent}`),
          running && h('span', { class: 'badge' }, running.mode === 'tool_smoke' ? 'tool smoke' : 'coding edit'),
          running && h('span', { class: 'small muted' }, `${secs}s elapsed`)),
        qLen > 0 && h('span', { class: 'badge' }, `+${qLen} queued`)),
      running?.live?.length
        ? h('pre', { class: 'olm-live', style: 'max-height:110px' }, running.live.slice(-8).join('\n'))
        : h('div', { class: 'small muted' }, 'Waiting for model response / tool calls…'));
  } else {
    liveBox.classList.add('hidden');
  }

  // Matrix table
  const wrap = $('#labMatrixWrap');
  const models = ollamaState.models || [];
  if (!models.length) {
    wrap.replaceChildren(h('p', { class: 'small muted' }, 'No models found on the connected Ollama server.'));
    renderLabDetail();
    return;
  }

  const tbody = h('tbody');
  for (const m of models) {
    const rMap = testState.results?.[m.name] || {};
    const ctx = m.numCtx || ollamaState.serverCtx;
    const row = h('tr', {},
      h('td', { class: 'lab-model-col' },
        h('div', { class: 'lab-model-name', title: m.name }, m.name),
        h('div', { class: 'row wrap', style: 'gap:4px;margin-top:3px' },
          m.params && h('span', { class: 'badge' }, m.params),
          h('span', { class: 'badge' }, gb(m.size)),
          h('span', { class: 'badge ' + (ctx >= 32768 ? 'live' : ctx >= 16384 ? '' : 'warn') }, `ctx ${kctx(ctx)}`),
          m.tools ? h('span', { class: 'badge live' }, 'tools') : h('span', { class: 'badge bad' }, 'no tools'),
          m.thinking && h('span', { class: 'badge' }, 'thinking'))),
      ...OLLAMA_CLIS_ORDER.map((cliKey) => {
        const isRun = running?.model === m.name && running.agent === cliKey;
        const isQ = testState.queue?.some((q) => q.model === m.name && q.agent === cliKey);
        const res = rMap[cliKey];
        const isSel = labSelected?.model === m.name && labSelected?.agent === cliKey;
        let pillCls = 'lab-pill idle', pillTxt = '▶ Test', tip = `Click to run ${labMode} test for ${m.name} on ${AGENT_LABEL[cliKey]}`;
        if (isRun) {
          pillCls = 'lab-pill running';
          pillTxt = `● ${Math.round((Date.now() - running.startedAt) / 1000)}s`;
          tip = 'Currently testing — click to view live log';
        } else if (isQ) {
          pillCls = 'lab-pill queued';
          pillTxt = 'queued';
          tip = 'Queued for testing';
        } else if (res) {
          pillCls = `lab-pill ${verdictClass(res.verdict)}`;
          pillTxt = res.verdict === 'pass' ? `✓ ${res.secs}s (${res.tools}t)` : `${TEST_ICON[res.verdict] || '?'} ${res.verdict.replace('_', ' ')}`;
          tip = `${AGENT_LABEL[cliKey]} (${res.mode || 'coding'}): ${res.text}`;
        }
        return h('td', { class: 'lab-cell' + (isSel ? ' selected' : '') },
          h('button', {
            type: 'button', class: pillCls, title: tip,
            onclick: (e) => {
              labSelected = { model: m.name, agent: cliKey };
              if (!res && !isRun && !isQ && m.tools) {
                busy(e.target, async () => {
                  await api('POST', '/api/ollama/tests', { model: m.name, agents: [cliKey], mode: labMode });
                  await loadTests(); renderOllamaModels(); renderLab();
                });
              } else {
                renderLab();
              }
            },
          }, pillTxt));
      }),
      h('td', { class: 'lab-act-col' },
        h('button', {
          type: 'button', style: 'font-size:11px;padding:4px 9px', disabled: !m.tools,
          title: `Queue selected CLIs for ${m.name}`,
          onclick: (e) => busy(e.target, async () => {
            const agents = [...labCliSelection];
            if (!agents.length) throw new Error('Select at least one CLI above.');
            await api('POST', '/api/ollama/tests', { model: m.name, agents, mode: labMode });
            await loadTests(); renderOllamaModels(); renderLab();
          }),
        }, 'Test row')));
    tbody.append(row);
  }

  const table = h('table', { class: 'lab-table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Ollama Model'),
        ...OLLAMA_CLIS_ORDER.map((k) => h('th', { title: testState.agents?.[k]?.protocol || '' }, AGENT_SHORT[k])),
        h('th', {}, ''))),
    tbody);
  wrap.replaceChildren(table);
  renderLabDetail();
}

$('#openOllamaLab')?.addEventListener('click', () => openOllamaLab(null));
$('#labClose')?.addEventListener('click', () => $('#ollamaLabDlg').close());
$('#labRefresh')?.addEventListener('click', (e) => busy(e.target, loadOllama));
for (const b of document.querySelectorAll('#labModePicker button')) {
  b.addEventListener('click', () => { labMode = b.dataset.mode; renderLab(); });
}
$('#labRunAll')?.addEventListener('click', (e) => busy(e.target, async () => {
  const models = (ollamaState.models || []).filter((m) => m.tools).map((m) => m.name);
  const agents = [...labCliSelection];
  if (!models.length) throw new Error('No tool-capable models on Ollama.');
  if (!agents.length) throw new Error('Select at least one CLI to test.');
  await api('POST', '/api/ollama/tests', { models, agents, mode: labMode });
  await loadTests(); renderOllamaModels(); renderLab();
}));
$('#labStop')?.addEventListener('click', (e) => busy(e.target, async () => {
  await api('POST', '/api/ollama/tests/cancel');
  await loadTests(); renderOllamaModels(); renderLab();
}));
$('#labClear')?.addEventListener('click', (e) => busy(e.target, async () => {
  if (!(await m3Confirm('Clear test results', 'Clear all saved Ollama × CLI test results?', { okLabel: 'Clear', danger: true }))) return;
  await api('DELETE', '/api/ollama/tests');
  labSelected = null;
  await loadTests(); renderOllamaModels(); renderLab();
}));
$('#labApplyPassing')?.addEventListener('click', (e) => busy(e.target, async () => {
  const installed = new Set((ollamaState.models || []).map((m) => m.name));
  const perCli = {};
  for (const [model, map] of Object.entries(testState.results || {})) {
    if (!installed.has(model)) continue;
    for (const cli of OLLAMA_CLIS_ORDER) {
      if (map[cli]?.verdict === 'pass') (perCli[cli] ||= []).push(model);
    }
  }
  const clis = Object.keys(perCli);
  if (!clis.length) throw new Error('No passing test results yet. Run tests first.');
  let appliedRes = null;
  for (const cli of clis) {
    appliedRes = await api('POST', '/api/ollama/apply', { models: perCli[cli], targets: [cli] });
  }
  if (appliedRes?.applied) ollamaState.applied = appliedRes.applied;
  renderOllamaModels(); renderLaunchModels(); renderLab();
  showDialog('Passing models applied', clis.map((c) => `${AGENT_LABEL[c]}: ${perCli[c].join(', ')}`).join('\n'));
}));

$('#ollamaUrlForm').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || e.target, async () => {
  $('#ollamaStatus').textContent = 'Connecting…';
  try { await api('POST', '/api/ollama/url', { url: $('#ollamaUrl').value }); }
  finally { await loadOllama(); }
}); });
$('#ctxForm').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || e.target, async () => {
  await api('POST', '/api/ollama/server-ctx', { serverCtx: Number($('#serverCtx').value) }); await loadOllama();
}); });
$('#pullForm').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || e.target, async () => {
  const model = $('#pullName').value.trim(); if (!model) return;
  await api('POST', '/api/ollama/pull', { model }); $('#pullName').value = '';
  setTimeout(() => pollPulls().catch(() => {}), 300);
}); });
$('#applyOllama').addEventListener('click', (e) => busy(e.target, async () => {
  const models = [...document.querySelectorAll('.olm:checked')].map((c) => c.value);
  const tgtMap = [
    ['pi', '#tgtPi'], ['opencode', '#tgtOpencode'], ['claude', '#tgtClaude'],
    ['codex', '#tgtCodex'], ['qwen', '#tgtQwen'], ['dsh', '#tgtDsh'],
  ];
  const targets = tgtMap.filter(([, sel]) => $(sel)?.checked).map(([k]) => k);
  let def = $('#ollamaDefault').value;
  if (def && !models.includes(def)) throw new Error('The default model must also be checked.');
  const r = await api('POST', '/api/ollama/apply', { models, targets, default: def || undefined });
  ollamaState.applied = r.applied; renderOllamaModels(); renderLaunchModels();
  showDialog('Local models applied', `${models.length} model(s) configured for ${targets.map((t) => AGENT_LABEL[t] || t).join(', ')}.\n\n` +
    `Start any of those CLIs from a repo — pick the model in "Local model (Ollama / custom)". Already-running sessions need a restart to see the change.`);
}));
$('#refreshOllama').addEventListener('click', (e) => busy(e.target, loadOllama));
$('#launchModel').addEventListener('change', () => { try { localStorage.setItem('launchModel', $('#launchModel').value); } catch {} });

// ------------------------------------------------------ model catalog ----
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

$('#browseModels').addEventListener('click', () => { $('#catalog').showModal(); if (!$('#catList').childElementCount) loadCatalog(false); });
$('#catClose').addEventListener('click', () => $('#catalog').close());
$('#catForm').addEventListener('submit', (e) => { e.preventDefault(); loadCatalog(false); });
$('#catC').addEventListener('change', () => loadCatalog(false));
$('#catMore').addEventListener('click', (e) => busy(e.target, async () => { catPage++; await loadCatalog(true); }));
$('#catalog').addEventListener('close', () => loadOllama().catch(() => {}));

// ------------------------------------------------- browser-open bridge ----
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

// ---- M3 Navigation Rail & Collapsible Side Pane ----
const PANE_TITLES = {
  workspace: 'Workspace',
  sessions: 'Sessions',
  ollama: 'Local Models',
  automations: 'Automations',
  github: 'GitHub',
  system: 'System',
};
let activePane = 'workspace';
const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 860px)').matches;
function openMobileSheet() { $('#sidebar').classList.add('open'); $('#sideScrim')?.classList.add('open'); }
function closeMobileSheet() { $('#sidebar').classList.remove('open'); $('#sideScrim')?.classList.remove('open'); }
// Swipe the drawer left to close it.
(function initSheetSwipe() {
  const side = $('#sidebar');
  let x0 = 0, y0 = 0, dx = 0, tracking = false, horiz = null;
  side.addEventListener('touchstart', (ev) => {
    if (!isMobile() || !side.classList.contains('open') || ev.touches.length !== 1) return;
    if (ev.target.closest('input, textarea, select, .tab-list, .models-box .list')) return;
    x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; dx = 0; tracking = true; horiz = null;
  }, { passive: true });
  side.addEventListener('touchmove', (ev) => {
    if (!tracking) return;
    const mx = ev.touches[0].clientX - x0, my = ev.touches[0].clientY - y0;
    if (horiz === null && Math.hypot(mx, my) > 10) horiz = Math.abs(mx) > Math.abs(my) * 1.3 && mx < 0;
    if (!horiz) { if (horiz === false) tracking = false; return; }
    dx = Math.min(0, mx);
    side.classList.add('dragging');
    side.style.transform = `translateX(${dx}px)`;
  }, { passive: true });
  const end = () => {
    if (!tracking) return;
    tracking = false;
    side.classList.remove('dragging');
    side.style.transform = '';
    if (horiz && dx < -Math.min(110, side.offsetWidth * 0.3)) closeMobileSheet();
  };
  side.addEventListener('touchend', end);
  side.addEventListener('touchcancel', end);
})();
function refitActive() {
  const cur = open.get(active);
  if (cur) setTimeout(() => { try { cur.fit.fit(); } catch {} }, 360);
}
function setPaneCollapsed(collapsed) {
  $('#app').classList.toggle('pane-collapsed', collapsed);
  try { localStorage.setItem('paneCollapsed', collapsed ? '1' : '0'); } catch {}
  refitActive();
}
function selectPane(pane, fromUser) {
  if (!PANE_TITLES[pane]) pane = 'workspace';
  const same = pane === activePane;
  activePane = pane;
  try { localStorage.setItem('activePane', pane); } catch {}
  $('#paneSubtitle').textContent = PANE_TITLES[pane];
  for (const b of document.querySelectorAll('#navRail .rail-btn')) b.classList.toggle('active', b.dataset.pane === pane);
  for (const p of document.querySelectorAll('#sidebar .pane')) p.classList.toggle('active', p.dataset.pane === pane);
  if (fromUser) {
    if (isMobile()) {
      if (same && $('#sidebar').classList.contains('open')) closeMobileSheet();
      else openMobileSheet();
    } else {
      const collapsed = $('#app').classList.contains('pane-collapsed');
      if (same) setPaneCollapsed(!collapsed);
      else if (collapsed) setPaneCollapsed(false);
    }
  }
}
function initNavRail() {
  for (const b of document.querySelectorAll('#navRail .rail-btn')) {
    b.addEventListener('click', () => selectPane(b.dataset.pane, true));
  }
  $('#collapseSide')?.addEventListener('click', () => setPaneCollapsed(true));
  $('#railToggle')?.addEventListener('click', () => setPaneCollapsed(!$('#app').classList.contains('pane-collapsed')));
  try {
    const savedPane = localStorage.getItem('activePane');
    if (savedPane && PANE_TITLES[savedPane]) selectPane(savedPane, false);
    if (!isMobile() && localStorage.getItem('paneCollapsed') === '1') $('#app').classList.add('pane-collapsed');
  } catch {}
  const mb = $('#modelsBox');
  if (mb) {
    try { if (localStorage.getItem('modelsBox') === 'closed') mb.open = false; } catch {}
    mb.addEventListener('toggle', () => { try { localStorage.setItem('modelsBox', mb.open ? 'open' : 'closed'); } catch {} });
  }
}
initTheme();
initNavRail();

async function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  await loadStatus();
  await Promise.all([loadLocal(), loadSessions(), loadOllama().catch(() => {}), typeof loadAuto === 'function' ? loadAuto().catch(() => {}) : null]);
  if (typeof loadTools === 'function') {
    // Check every CLI for updates on each page load (asks npm for the latest versions, skipping the server cache).
    loadTools(true).then((d) => {
      const outdated = (d?.tools || []).filter((t) => t.outdated);
      if (outdated.length && !d.updating && typeof showNoticeToast === 'function') {
        showNoticeToast(`${outdated.length} CLI update${outdated.length > 1 ? 's' : ''} available`,
          `${outdated.map((t) => `${t.label} ${t.version} → ${t.latest}`).join(' · ')}. Update them under System.`);
      }
    }).catch(() => {});
    loadNotify().catch(() => {});
  }
  if (typeof initFeatures === 'function') initFeatures();
  if (status.github.connected) loadGh();
  for (const [name, e] of open) {
    if (e.paused && !e.closed && sessions.some((s) => s.name === name)) connect(name, e);
  }
  clearInterval(sessionsTimer);
  clearInterval(openUrlsTimer);
  sessionsTimer = setInterval(() => loadSessions().catch(() => {}), 15000);
  openUrlsTimer = setInterval(() => pollOpenUrls().catch(() => {}), 2000);
}

(async () => {
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({}));
  if (me.authed) start(); else showLogin();
})();
