// App status, local repositories (worktrees, git buttons), GitHub repositories and the Sessions list.
import { OLLAMA_CLIS_ORDER } from './agentinfo.js';
import { state } from './state.js';
import { $, api, busy, h, m3Confirm, m3Prompt, setRailBadge, showDialog } from './core.js';
import { attach, closeTab, launch } from './terminals.js';
import { ollamaState } from './ollama.js';
import { toggleWatchRepo, watchedRepoSet } from './automations.js';
import { openDiffViewer } from './diff.js';
import { openFileBrowser } from './files.js';
import { openArena } from './arena.js';
import { openRepoIssues } from './issues.js';

let status = { agents: {}, github: {}, logins: {} };

let localRepos = [];
let sessions = [];
const open = new Map(); // session name -> { term, fit, ws, el, tab }

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
  try { state.ghRepos = (await api('GET', '/api/repos/github')).repos; renderGh(); }
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
  const list = state.ghRepos.filter((r) => !q || r.full_name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
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

export { status, localRepos, sessions, open, loadStatus, loadLocal, keepOpen, renderLocal, loadGh, renderGh, loadSessions };
