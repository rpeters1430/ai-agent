// Automations tab: watched repositories, label profiles, rules, the job list and its live view.
import { state } from './state.js';
import { $, api, busy, h, m3Confirm, m3Prompt, setRailBadge, showDialog } from './core.js';
import { localRepos, renderGh, sessions } from './workspace.js';
import { attach, launch } from './terminals.js';
import { ollamaState } from './ollama.js';
import { closeMobileSheet } from './nav.js';

// Automations UI (uses h, api, busy, showDialog, attach, launch, ghRepos, localRepos, ollamaState, renderGh from app.js)

let autoState = { rules: [], watchedRepos: [], watch: {}, models: {}, jobs: [], agents: {}, settings: {}, poll: {} };
let autoTimer = null;
let editingRule = null;
let draftWatchProfiles = [];

const PRESETS = {
  fix_label:    { trigger: 'label', action: 'fix', label: 'agent-fix' },
  mention:      { trigger: 'mention', keyword: '@agent' },
  review_label: { trigger: 'label', action: 'review', label: 'agent-review' },
  new_pr:       { trigger: 'new_pr' },
  ci_failure:   { trigger: 'ci_failure' },
  schedule:     { trigger: 'schedule', everyHours: 24, cron: '' },
};
const presetOf = (r) => (r.trigger === 'label' ? (r.action === 'review' ? 'review_label' : 'fix_label') : r.trigger);

const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`; return new Date(t).toLocaleDateString();
};
const JOB_BADGE = { queued: '', running: 'live', succeeded: 'ok', failed: 'bad', cancelled: 'warn', interrupted: 'warn' };
const jobTitle = (j) => ({ fix_issue: `Fix #${j.number}`, pr_task: `PR #${j.number}`, review: `Review #${j.number}`, task: 'Task' }[j.kind] || j.kind)
  + (j.title ? ` · ${j.title}` : j.kind === 'task' ? ` · ${j.ruleName}` : '');
const agentName = (k) => autoState.agents[k]?.label || k;
const supportsLocalModel = (k) => ['pi', 'opencode', 'claude', 'codex', 'qwen', 'cline'].includes(k);

function appliedModels(agentKey) {
  if (!supportsLocalModel(agentKey)) return [];
  const a = autoState.models?.[agentKey] || [];
  const ac = autoState.models?.custom?.[agentKey] || [];
  const b = (typeof ollamaState !== 'undefined' && ollamaState.applied?.[agentKey]) || [];
  const bc = (typeof ollamaState !== 'undefined' && ollamaState.applied?.custom?.[agentKey]) || [];
  return [...new Set([...a, ...b, ...ac, ...bc])];
}

function watchedRepoSet() {
  return new Set((autoState.watchedRepos || []).map((w) => w.repo.toLowerCase()));
}

async function toggleWatchRepo(fullName, isWatched) {
  if (isWatched) {
    if (!(await m3Confirm('Stop watching repository', `Stop watching ${fullName} for issues & PRs? Past runs stay in the list.`, { okLabel: 'Unwatch', danger: true }))) return;
    const [owner, name] = fullName.split('/');
    await api('DELETE', `/api/automations/watched-repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  } else {
    const r = await api('POST', '/api/automations/watched-repos', { repo: fullName });
    if (r.warnings?.length) showDialog('Watching, with warnings', r.warnings.join('\n'));
  }
  await loadAuto();
}

function describeRule(r) {
  const who = `${agentName(r.agent)}${r.model ? ` (${r.model})` : ''}`;
  const rev = r.autoReview
    ? ` → auto-review (${r.reviewAgent ? `${agentName(r.reviewAgent)}${r.reviewModel ? ` (${r.reviewModel})` : ''}` : 'same agent'}${r.autoFixRounds ? `, up to ${r.autoFixRounds} fix round${r.autoFixRounds > 1 ? 's' : ''}` : ''})`
    : '';
  return {
    label: r.action === 'review' ? `Add label “${r.label}” to a PR → ${who} posts a review`
      : `Add label “${r.label}” to an issue → ${who} opens a PR (on a PR: pushes fixes)${rev}`,
    mention: `Comment “${r.keyword} …” on an issue or PR → ${who} does what it asks${rev}`,
    new_pr: `New pull request${r.rereview ? ' or new commits' : ''} → ${who} posts a review`,
    ci_failure: `Failing CI checks on open PRs → ${who} diagnoses & pushes a fix${rev}`,
    schedule: `${r.cron ? `Cron (${r.cron})` : `Every ${r.everyHours}h`} → ${who} runs the task, opens a PR if it changes code`,
  }[r.trigger];
}

function describeWatch(w) {
  const worker = w.agent ? `${agentName(w.agent)}${w.model ? ` (${w.model})` : ''}` : 'unconfigured';
  const reviewer = w.reviewAgent ? `${agentName(w.reviewAgent)}${w.reviewModel ? ` (${w.reviewModel})` : ''}` : 'same agent';
  const parts = [`Worker: ${worker}`];
  if (w.reviewAgent) parts.push(`Reviewer: ${reviewer}`);
  const triggers = [];
  if (w.fixEnabled) {
    const revPart = w.autoReviewAfterFix
      ? ` + auto-review${w.autoFixRounds ? ` (up to ${w.autoFixRounds} fix round${w.autoFixRounds > 1 ? 's' : ''})` : ''}`
      : '';
    triggers.push(`“${w.fixLabel || 'agent-fix'}” → work${revPart}`);
  }
  if (w.reviewLabelEnabled) triggers.push(`“${w.reviewLabel || 'agent-review'}” → review PR`);
  for (const p of (w.profiles || []).filter((x) => x.enabled !== false && x.label)) {
    const who = `${agentName(p.agent)}${p.model ? ` (${p.model})` : ''}`;
    const act = p.action === 'review' ? `review PR (${who})` : `${who}${p.autoReview ? ' + auto-review' : ''}`;
    triggers.push(`“${p.label}” → ${act}`);
  }
  if (w.reviewNewPrs) triggers.push(`new PRs${w.rereviewOnPush ? ' & commits' : ''} → review`);
  if (w.autoFixCi) triggers.push('failing CI → auto-fix');
  if (w.mentionEnabled) triggers.push(`“${w.keyword || '@agent'}” comments`);
  parts.push(triggers.length ? triggers.join(' · ') : 'no triggers enabled');
  return parts.join(' · ');
}

async function loadAutoStats() {
  const box = $('#autoStats');
  if (!box) return;
  try {
    const st = await api('GET', '/api/automations/stats');
    if (!st.total) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
    box.replaceChildren(
      h('span', { class: 'badge' }, `${st.total} runs`),
      st.passRate != null && h('span', { class: 'badge ' + (st.passRate >= 70 ? 'live' : 'warn') }, `${st.passRate}% pass`),
      st.avgSecs > 0 && h('span', { class: 'badge' }, `avg ${st.avgSecs}s`),
      st.totalTools > 0 && h('span', { class: 'badge' }, `${st.totalTools} tool calls`),
      st.totalTokens > 0 && h('span', { class: 'badge' }, `${fmtTok(st.totalTokens)} tokens`),
    );
  } catch {}
}

async function loadAuto() {
  autoState = await api('GET', '/api/automations');
  renderAutoSummary();
  if ($('#autoDlg').open) { renderAutoDialog(); loadAutoStats(); }
  if (typeof renderGh === 'function' && state.ghRepos.length) renderGh();
}

function jobActions(j, small) {
  const live = j.status === 'running' && j.session && sessions.some((s) => s.name === j.session);
  return h('div', { class: 'actions' },
    live && h('button', { class: 'agent', onclick: () => { $('#autoDlg').close(); attach(j.session, `Auto · ${jobTitle(j)}`); } }, 'Watch live'),
    j.resultUrl && h('a', { class: 'btn', href: j.resultUrl, target: '_blank', rel: 'noopener noreferrer' }, j.result?.startsWith('opened PR') ? 'Open PR' : 'Open result'),
    !small && j.url && j.url !== j.resultUrl && h('a', { class: 'btn', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, `#${j.number}`),
    !small && (j.status !== 'queued') && h('button', { onclick: (e) => busy(e.target, () => showJobLog(j)) }, 'Log'),
    !small && j.wt && j.local && j.status !== 'running' && localRepos.some((r) => r.name === j.local && (r.worktrees || []).some((w) => w.name === j.wt))
      && h('button', { title: 'Open the agent interactively in this job\'s worktree', onclick: (e) => busy(e.target, async () => { $('#autoDlg').close(); await launch({ agent: j.agent, repo: j.local, wt: j.wt, model: j.model || undefined }); }) }, 'Continue here'),
    (j.status === 'queued' || j.status === 'running') && h('button', { onclick: (e) => busy(e.target, async () => {
      if (!(await m3Confirm('Stop automation run', 'Stop this automation run? The worktree will be kept.', { okLabel: 'Stop run', danger: true }))) return;
      await api('POST', `/api/automations/jobs/${j.id}/cancel`); await loadAuto();
    }) }, 'Cancel'),
    !small && ['failed', 'cancelled', 'interrupted', 'succeeded'].includes(j.status) && h('button', { onclick: (e) => busy(e.target, async () => {
      await api('POST', `/api/automations/jobs/${j.id}/retry`); await loadAuto();
    }) }, 'Run again'));
}

function jobItem(j, small) {
  const who = `${agentName(j.agent)}${j.model ? ` (${j.model})` : ''}`;
  return h('div', { class: 'item job' },
    h('div', { class: 'top' },
      h('span', { class: `badge ${JOB_BADGE[j.status] || ''}` }, j.status),
      h('span', { class: 'name', title: jobTitle(j) }, jobTitle(j))),
    h('div', { class: 'meta' }, `${j.repo} · ${who} · ${j.trigger || ''} · ${ago(j.endedAt || j.startedAt || j.createdAt)}`),
    j.step && h('div', { class: 'small' }, `⏳ ${j.step}…`),
    j.result && h('div', { class: 'small' }, `✓ ${j.result}`),
    j.error && h('div', { class: 'small err' }, j.error),
    !small && j.note && h('div', { class: 'small muted' }, j.note),
    !small && j.resultText && j.status === 'succeeded' && h('div', { class: 'result' }, j.resultText),
    jobActions(j, small));
}

function renderAutoSummary() {
  const s = autoState;
  const watched = s.watchedRepos || [];
  const watchedOn = watched.filter((w) => w.enabled).length;
  const rulesOn = s.rules.filter((r) => r.enabled).length;
  const runningN = s.jobs.filter((j) => j.status === 'running').length;
  const queuedN = s.jobs.filter((j) => j.status === 'queued').length;
  const box = $('#autoSummary');
  if (!watched.length && !s.rules.length) {
    box.textContent = 'Watch repos to auto-work & review tagged issues and review PRs on GitHub.';
  } else {
    box.textContent = [
      watched.length && `${watchedOn} of ${watched.length} repo${watched.length > 1 ? 's' : ''} watched`,
      s.rules.length && `${rulesOn} of ${s.rules.length} rule${s.rules.length > 1 ? 's' : ''} on`,
      runningN && `${runningN} running`,
      queuedN && `${queuedN} queued`,
      s.settings.paused ? 'paused' : `checked ${ago(s.poll.last)}`,
    ].filter(Boolean).join(' · ');
  }
  if (s.poll.error) box.append(h('div', { class: 'err' }, s.poll.error));
  $('#autoRecent').replaceChildren(...s.jobs.slice(0, 3).map((j) => jobItem(j, true)));
  if (typeof setRailBadge === 'function') setRailBadge('#railBadgeAuto', runningN + queuedN);
}

function fillRepoDatalist() {
  const seen = new Set();
  const names = [];
  for (const r of state.ghRepos || []) {
    if (r.full_name && !seen.has(r.full_name.toLowerCase())) { seen.add(r.full_name.toLowerCase()); names.push(r.full_name); }
  }
  for (const r of localRepos || []) {
    const m = (r.remote || '').match(/github\.com[:/]+(.+?)(?:\.git)?\/?$/i);
    if (m && !seen.has(m[1].toLowerCase())) { seen.add(m[1].toLowerCase()); names.push(m[1]); }
  }
  $('#autoRepos').replaceChildren(...names.map((n) => h('option', { value: n })));
}

function renderAutoDialog() {
  const s = autoState, f = $('#autoSettings');
  if (!f.contains(document.activeElement)) {
    f.pollSeconds.value = s.settings.pollSeconds; f.maxConcurrent.value = s.settings.maxConcurrent;
    f.timeoutMinutes.value = s.settings.timeoutMinutes; f.loopLimit.value = s.settings.loopLimit ?? 4; f.paused.checked = !!s.settings.paused;
  }
  $('#autoPoll').replaceChildren(s.settings.paused ? 'Paused — GitHub is not being checked (Run now still works).' : `Last check ${ago(s.poll.last)}.`,
    s.poll.error ? h('span', { class: 'err' }, ' ' + s.poll.error) : '');

  // Watched repositories summary & list
  const wcfg = s.watch || {};
  $('#watchSummary').textContent = describeWatch(wcfg);

  const watchedBox = $('#autoWatched');
  watchedBox.replaceChildren();
  const watched = s.watchedRepos || [];
  const activeProfiles = (wcfg.profiles || []).filter((p) => p.enabled !== false && p.label);
  if (!watched.length) {
    watchedBox.append(h('p', { class: 'small muted' }, 'No watched repositories yet. Add one above (or click “Watch” on any repo in the GitHub tab).'));
  }
  for (const w of watched) {
    const [owner, name] = w.repo.split('/');
    watchedBox.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: `badge ${w.enabled ? 'live' : ''}` }, w.enabled ? 'watching' : 'paused'),
        h('span', { class: 'name', title: w.repo }, w.repo),
        h('span', { class: 'spacer' }),
        w.lastPoll ? h('span', { class: 'meta' }, `checked ${ago(w.lastPoll)}`) : null),
      w.lastError && h('div', { class: 'small err' }, w.lastError),
      h('div', { class: 'actions' },
        h('button', { onclick: (e) => busy(e.target, async () => { await api('POST', '/api/automations/watched-repos', { repo: w.repo, enabled: !w.enabled }); await loadAuto(); }) }, w.enabled ? 'Pause' : 'Resume'),
        h('button', { class: 'agent', onclick: (e) => busy(e.target, () => runWatchedNow(w, 'fix')) }, 'Work issue / PR'),
        h('button', { onclick: (e) => busy(e.target, () => runWatchedNow(w, 'review')) }, 'Review PR'),
        ...activeProfiles.slice(0, 4).map((p) => h('button', {
          class: 'agent',
          title: `Run profile “${p.label}” (${agentName(p.agent)}${p.model ? ` · ${p.model}` : ''})`,
          onclick: (e) => busy(e.target, () => runWatchedNow(w, p.action, p)),
        }, p.label)),
        h('button', { onclick: (e) => busy(e.target, async () => {
          if (!(await m3Confirm('Stop watching', `Stop watching ${w.repo}? Past runs stay in the list.`, { okLabel: 'Unwatch', danger: true }))) return;
          await api('DELETE', `/api/automations/watched-repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
          await loadAuto();
        }) }, 'Unwatch'))));
  }

  // Custom & scheduled rules
  const rules = $('#autoRules'); rules.replaceChildren();
  if (!s.rules.length) rules.append(h('p', { class: 'small muted' }, 'No custom rules. Use Watched repositories above for issues & PRs, or add a scheduled task / custom override here.'));
  for (const r of s.rules) {
    rules.append(h('div', { class: 'item' },
      h('div', { class: 'top' },
        h('span', { class: `badge ${r.enabled ? 'live' : ''}` }, r.enabled ? 'on' : 'off'),
        h('span', { class: 'name', title: r.name }, r.name),
        h('span', { class: 'spacer' }),
        h('span', { class: 'meta' }, r.repo)),
      h('div', { class: 'small muted' }, describeRule(r)),
      r.instructions && r.trigger !== 'schedule' && h('div', { class: 'small muted' }, `+ ${r.instructions.split('\n')[0].slice(0, 90)}`),
      r.trigger === 'schedule' && h('div', { class: 'small muted' }, `Task: ${r.instructions.split('\n')[0].slice(0, 90)} · last run ${ago(r.lastRun)}`),
      r.lastError && h('div', { class: 'small err' }, r.lastError),
      h('div', { class: 'actions' },
        h('button', { onclick: (e) => busy(e.target, async () => { await api('POST', '/api/automations/rules', { ...r, enabled: !r.enabled }); await loadAuto(); }) }, r.enabled ? 'Turn off' : 'Turn on'),
        h('button', { class: 'agent', onclick: (e) => busy(e.target, () => runRuleNow(r)) }, 'Run now'),
        h('button', { onclick: () => openRuleForm(r) }, 'Edit'),
        h('button', { onclick: (e) => busy(e.target, async () => {
          if (!(await m3Confirm('Delete rule', `Delete the rule “${r.name}”? Past runs stay in the list.`, { okLabel: 'Delete', danger: true }))) return;
          await api('DELETE', `/api/automations/rules/${r.id}`); await loadAuto();
        }) }, 'Delete'))));
  }

  const jobsBox = $('#autoJobs'); jobsBox.replaceChildren();
  if (!s.jobs.length) jobsBox.append(h('p', { class: 'small muted' }, 'Nothing has run yet.'));
  for (const j of s.jobs) jobsBox.append(jobItem(j, false));
}

async function runWatchedNow(w, action, profile) {
  const what = action === 'review' ? 'pull request' : 'issue or pull request';
  const title = profile
    ? `${profile.label} (${agentName(profile.agent)}${profile.model ? ` · ${profile.model}` : ''}) · ${w.repo}`
    : (action === 'review' ? `Review PR · ${w.repo}` : `Work on ${w.repo}`);
  const n = await m3Prompt(title, `Enter the ${what} number:`, '', { placeholder: 'e.g. 42', okLabel: 'Run' });
  if (!n) return;
  const [owner, name] = w.repo.split('/');
  await api('POST', `/api/automations/watched-repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/run`, {
    action,
    number: Number(n.replace('#', '').trim()),
    ...(profile ? { profileId: profile.id } : {}),
  });
  await loadAuto();
}

async function runRuleNow(r) {
  let body = {};
  if (r.trigger !== 'schedule') {
    const what = r.trigger === 'new_pr' || r.action === 'review' ? 'pull request' : 'issue or pull request';
    const n = await m3Prompt(`Run “${r.name}”`, `Enter the ${what} number:`, '', { placeholder: 'e.g. 42', okLabel: 'Continue' });
    if (!n) return;
    body.number = Number(n.replace('#', '').trim());
    if (r.trigger === 'mention') {
      const ins = await m3Prompt(`Run “${r.name}”`, 'What should the agent do? (like the text of a comment)', '', { placeholder: 'Add tests for the parser…', okLabel: 'Run' });
      if (ins === null) return;
      body.instructions = ins;
    }
  }
  await api('POST', `/api/automations/rules/${r.id}/run`, body);
  await loadAuto();
}

async function showJobLog(j) {
  const d = await api('GET', `/api/automations/jobs/${j.id}/log`);
  const parts = [];
  if (j.error) parts.push(`ERROR: ${j.error}`);
  if (d.output) parts.push(`===== Agent's summary =====\n${d.output}`);
  parts.push(`===== Output =====\n${d.log.slice(-60000) || '(empty)'}`);
  parts.push(`===== Prompt sent to the agent =====\n${d.prompt}`);
  showDialog(jobTitle(j), parts.join('\n\n'));
}

function fillAgentSelect(sel, selected, allowSameAsWorker) {
  const agents = Object.entries(autoState.agents).filter(([, a]) => a.installed);
  const opts = [];
  if (allowSameAsWorker) opts.push(h('option', { value: '' }, 'Same as worker'));
  for (const [k, a] of agents) opts.push(h('option', { value: k }, a.label));
  sel.replaceChildren(...opts);
  if (allowSameAsWorker) {
    sel.value = selected && agents.some(([k]) => k === selected) ? selected : '';
  } else {
    sel.value = selected && agents.some(([k]) => k === selected)
      ? selected
      : (agents.find(([k]) => k === 'claude') || agents[0] || [])[0] || '';
  }
}

function fillModelSelect(sel, agentKey, cur) {
  const list = appliedModels(agentKey);
  const opts = [h('option', { value: '' }, 'agent default'), ...list.map((m) => h('option', { value: m }, `ollama · ${m}`))];
  if (cur && !list.includes(cur)) opts.push(h('option', { value: cur }, `ollama · ${cur}`));
  if (!list.length && supportsLocalModel(agentKey)) {
    opts.push(h('option', { value: '', disabled: true }, '— apply local models in Models tab —'));
  }
  sel.replaceChildren(...opts);
  sel.value = cur || '';
}

function nextUnusedLabel(candidates) {
  const f = $('#watchForm');
  const used = new Set([
    f.fixLabel.value.trim().toLowerCase(),
    f.reviewLabel.value.trim().toLowerCase(),
    ...draftWatchProfiles.map((p) => String(p.label || '').trim().toLowerCase()),
  ].filter(Boolean));
  for (const c of candidates) if (!used.has(c.toLowerCase())) return c;
  let i = 2;
  while (used.has(`${candidates[0]}-${i}`.toLowerCase())) i++;
  return `${candidates[0]}-${i}`;
}

function renderWatchProfiles() {
  const box = $('#watchProfiles');
  box.replaceChildren();
  if (!draftWatchProfiles.length) {
    box.append(h('p', { class: 'small muted', style: 'margin:0' }, 'No extra label profiles yet. Click “＋ OpenCode / local LLM label” below to add one.'));
    return;
  }
  draftWatchProfiles.forEach((p, idx) => {
    const agentSel = h('select', { onchange: (e) => {
      p.agent = e.target.value;
      if (!supportsLocalModel(p.agent)) p.model = '';
      renderWatchProfiles(); syncWatchForm();
    } });
    fillAgentSelect(agentSel, p.agent, false);
    p.agent = agentSel.value;

    const modelSel = h('select', { onchange: (e) => { p.model = e.target.value; syncWatchForm(); } });
    fillModelSelect(modelSel, p.agent, p.model || '');

    const revAgentSel = h('select', { onchange: (e) => {
      p.reviewAgent = e.target.value;
      if (!supportsLocalModel(p.reviewAgent)) p.reviewModel = '';
      renderWatchProfiles(); syncWatchForm();
    } });
    fillAgentSelect(revAgentSel, p.reviewAgent || '', true);

    const revModelSel = h('select', { onchange: (e) => { p.reviewModel = e.target.value; syncWatchForm(); } });
    fillModelSelect(revModelSel, p.reviewAgent, p.reviewModel || '');

    const roundsSel = h('select', { onchange: (e) => { p.autoFixRounds = Number(e.target.value) || 0; syncWatchForm(); } },
      h('option', { value: '0' }, 'Off (review once)'),
      h('option', { value: '1' }, 'Up to 1 round'),
      h('option', { value: '2' }, 'Up to 2 rounds'),
      h('option', { value: '3' }, 'Up to 3 rounds'));
    roundsSel.value = String(p.autoFixRounds || 0);

    const actionSel = h('select', { onchange: (e) => { p.action = e.target.value; renderWatchProfiles(); syncWatchForm(); } },
      h('option', { value: 'fix' }, 'Work issue / PR'),
      h('option', { value: 'review' }, 'Review PR only'));
    actionSel.value = p.action === 'review' ? 'review' : 'fix';

    box.append(h('div', { class: 'watch-profile' },
      h('div', { class: 'row wrap' },
        h('label', { class: 'inline-switch', title: 'Enable or pause this label profile' },
          h('input', { type: 'checkbox', class: 'm3-switch sm', checked: p.enabled !== false, onchange: (e) => { p.enabled = e.target.checked; syncWatchForm(); } }),
          'On'),
        h('label', {}, 'Label',
          h('input', { type: 'text', value: p.label || '', placeholder: 'opencode-fix', autocomplete: 'off', required: true, oninput: (e) => { p.label = e.target.value; syncWatchForm(); } })),
        h('label', {}, 'Action', actionSel),
        h('button', { type: 'button', class: 'icon', title: 'Remove label profile', onclick: () => { draftWatchProfiles.splice(idx, 1); renderWatchProfiles(); syncWatchForm(); } }, '✕')),
      h('div', { class: 'row wrap' },
        h('label', {}, 'Agent', agentSel),
        supportsLocalModel(p.agent) && h('label', {}, 'Local model', modelSel)),
      p.action !== 'review' && h('div', { class: 'row wrap' },
        h('label', { class: 'inline-switch' },
          h('input', { type: 'checkbox', class: 'm3-switch sm', checked: p.autoReview !== false, onchange: (e) => { p.autoReview = e.target.checked; renderWatchProfiles(); syncWatchForm(); } }),
          'Auto-review PR after working')),
      p.action !== 'review' && p.autoReview !== false && h('div', { class: 'row wrap' },
        h('label', {}, 'Reviewer agent', revAgentSel),
        p.reviewAgent && supportsLocalModel(p.reviewAgent) && h('label', {}, 'Reviewer model', revModelSel),
        h('label', {}, 'Auto-fix rounds', roundsSel))));
  });
}

function syncWatchForm() {
  const f = $('#watchForm');
  const show = (key, on) => f.querySelectorAll(`[data-wfor="${key}"]`).forEach((el) => el.classList.toggle('hidden', !on));
  show('model', supportsLocalModel(f.agent.value));
  show('reviewModel', !!f.reviewAgent.value && supportsLocalModel(f.reviewAgent.value));
  show('fix', f.fixEnabled.checked);
  show('autofix', f.fixEnabled.checked && f.autoReviewAfterFix.checked);
  show('reviewLabel', f.reviewLabelEnabled.checked);
  show('newPr', f.reviewNewPrs.checked);
  show('mention', f.mentionEnabled.checked);
  show('outside', f.reviewNewPrs.checked || f.mentionEnabled.checked);

  const hints = [];
  if (f.fixEnabled.checked) {
    const lbl = f.fixLabel.value.trim() || 'agent-fix';
    if (f.autoReviewAfterFix.checked) {
      const rounds = Number(f.autoFixRounds.value) || 0;
      hints.push(`Add “${lbl}” to an issue: worker opens a PR, then reviewer automatically reviews it${rounds ? ` and auto-fixes findings up to ${rounds} round${rounds > 1 ? 's' : ''}` : ''}.`);
    } else {
      hints.push(`Add “${lbl}” to an issue to open a PR, or to a PR to address review comments.`);
    }
  }
  const activeExtra = draftWatchProfiles.filter((p) => p.enabled !== false && p.label.trim());
  if (activeExtra.length) {
    hints.push(`Extra labels auto-created on watched repos: ${activeExtra.map((p) => `“${p.label.trim()}” (${agentName(p.agent)}${p.model ? ` · ${p.model}` : ''})`).join(', ')}.`);
  }
  if (f.reviewNewPrs.checked) hints.push('New non-draft PRs get reviewed automatically (PRs already queued for auto-review are not double-reviewed).');
  if (f.reviewLabelEnabled.checked) hints.push(`Add “${f.reviewLabel.value.trim() || 'agent-review'}” to any PR to request a review on demand.`);
  $('#watchHint').textContent = hints.join(' ') || 'Turn on at least one trigger above, then add repositories below.';
}

function openWatchForm() {
  const f = $('#watchForm');
  const w = autoState.watch || {};
  fillAgentSelect(f.agent, w.agent, false);
  fillModelSelect(f.model, f.agent.value, w.model || '');
  fillAgentSelect(f.reviewAgent, w.reviewAgent || '', true);
  fillModelSelect(f.reviewModel, f.reviewAgent.value, w.reviewModel || '');
  f.fixEnabled.checked = w.fixEnabled !== false;
  f.fixLabel.value = w.fixLabel || 'agent-fix';
  f.autoReviewAfterFix.checked = w.autoReviewAfterFix !== false;
  f.autoFixRounds.value = String(w.autoFixRounds || 0);
  f.draft.checked = w.draft !== false;
  f.reviewLabelEnabled.checked = w.reviewLabelEnabled !== false;
  f.reviewLabel.value = w.reviewLabel || 'agent-review';
  f.reviewNewPrs.checked = w.reviewNewPrs !== false;
  f.rereviewOnPush.checked = !!w.rereviewOnPush;
  f.autoFixCi.checked = !!w.autoFixCi;
  f.mentionEnabled.checked = !!w.mentionEnabled;
  f.keyword.value = w.keyword || '@agent';
  f.allowOutside.checked = !!w.allowOutside;
  f.instructions.value = w.instructions || '';
  draftWatchProfiles = (w.profiles || []).map((p) => ({ ...p }));
  renderWatchProfiles();
  syncWatchForm();
  f.classList.remove('hidden');
}

function syncForm() {
  const f = $('#autoForm'), p = PRESETS[f.preset.value];
  const show = (key, on) => f.querySelectorAll(`[data-for="${key}"]`).forEach((el) => el.classList.toggle('hidden', !on));
  const canAutoReview = (p.trigger === 'label' && p.action === 'fix') || p.trigger === 'mention' || p.trigger === 'ci_failure';
  show('label', p.trigger === 'label'); show('mention', p.trigger === 'mention'); show('schedule', p.trigger === 'schedule');
  show('notschedule', p.trigger !== 'schedule'); show('new_pr', p.trigger === 'new_pr');
  show('pr', p.trigger === 'schedule' || (p.trigger === 'label' && p.action === 'fix') || p.trigger === 'mention');
  show('outside', p.trigger === 'mention' || p.trigger === 'new_pr' || p.trigger === 'ci_failure');
  show('model', supportsLocalModel(f.agent.value));
  show('autoreview', canAutoReview);
  show('autoreview_cfg', canAutoReview && f.autoReview.checked);
  show('reviewModel', canAutoReview && f.autoReview.checked && !!f.reviewAgent.value && supportsLocalModel(f.reviewAgent.value));
  $('#autoHint').textContent = {
    fix_label: 'Agent Hub creates the label in the repo. Add it to an issue: the agent works on a new branch and opens a PR that closes the issue (and optionally auto-reviews it). Add it to a PR: the agent addresses the review comments and pushes to that PR. The label is removed when the run starts, so add it again to re-run.',
    mention: 'Write e.g. “@agent please add tests for this” in an issue or PR comment. On an issue it opens a PR (or replies if no code change is needed); on a PR it pushes to the PR branch. Only comments from you and repo collaborators count, unless you tick the box below.',
    review_label: 'Add the label to a pull request and the agent posts a review comment (file:line findings). It never pushes code.',
    new_pr: 'Every new non-draft PR (opened after you save this rule) gets a review comment. Outside contributors\' PRs are skipped unless you allow them: their code and text are untrusted and the agent runs without permission prompts.',
    ci_failure: 'Watches open PRs (same repo, not forks) for failed GitHub Actions check runs and pushes a fix to the PR branch.',
    schedule: 'Runs on the default branch. Use either "Every N hours" or a 5-field cron expression (e.g. "0 2 * * 1-5" for weekdays at 2am). Opens a PR if code changes.',
  }[f.preset.value];
}

async function openRuleForm(rule) {
  editingRule = rule || null;
  const f = $('#autoForm');
  f.reset();
  if (!state.ghRepos.length) { try { state.ghRepos = (await api('GET', '/api/repos/github')).repos; } catch {} }
  fillRepoDatalist();
  const p = rule ? presetOf(rule) : 'fix_label';
  f.preset.value = p;
  const v = { ...PRESETS[p], ...(rule || {}) };
  f.repo.value = v.repo || '';
  f.label.value = v.label || PRESETS.fix_label.label;
  f.keyword.value = v.keyword || '@agent';
  f.everyHours.value = v.everyHours || 24;
  f.cron.value = v.cron || '';
  f.instructions.value = v.instructions || '';
  f.draft.checked = v.draft !== false; f.rereview.checked = !!v.rereview; f.allowOutside.checked = !!v.allowOutside;
  f.autoReview.checked = !!v.autoReview;
  f.autoFixRounds.value = String(v.autoFixRounds || 0);
  f.name.value = rule?.name || '';
  fillAgentSelect(f.agent, rule?.agent, false);
  fillModelSelect(f.model, f.agent.value, rule?.model || '');
  fillAgentSelect(f.reviewAgent, rule?.reviewAgent || '', true);
  fillModelSelect(f.reviewModel, f.reviewAgent.value, rule?.reviewModel || '');
  syncForm();
  f.classList.remove('hidden');
  f.querySelector('button[type=submit]').textContent = rule ? 'Save changes' : 'Create rule';
  f.repo.focus();
}

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  $('#addOpencodeProfile').addEventListener('click', () => {
    const preferredAgent = autoState.agents.opencode?.installed ? 'opencode' : (autoState.agents.pi?.installed ? 'pi' : Object.keys(autoState.agents)[0] || 'opencode');
    const localModels = appliedModels(preferredAgent);
    draftWatchProfiles.push({
      id: '',
      label: nextUnusedLabel(['opencode-fix', 'local-fix', 'llm-fix']),
      action: 'fix',
      agent: preferredAgent,
      model: localModels[0] || '',
      autoReview: true,
      reviewAgent: '',
      reviewModel: '',
      autoFixRounds: 0,
      enabled: true,
    });
    renderWatchProfiles();
    syncWatchForm();
  });

  $('#addCustomProfile').addEventListener('click', () => {
    const installed = Object.entries(autoState.agents).filter(([, a]) => a.installed).map(([k]) => k);
    const pick = installed.find((k) => k !== $('#watchForm').agent.value) || installed[0] || 'claude';
    draftWatchProfiles.push({
      id: '',
      label: nextUnusedLabel([`${pick}-fix`, 'custom-fix']),
      action: 'fix',
      agent: pick,
      model: appliedModels(pick)[0] || '',
      autoReview: true,
      reviewAgent: '',
      reviewModel: '',
      autoFixRounds: 0,
      enabled: true,
    });
    renderWatchProfiles();
    syncWatchForm();
  });

  $('#watchCfgToggle').addEventListener('click', () => {
    const f = $('#watchForm');
    if (f.classList.contains('hidden')) openWatchForm();
    else f.classList.add('hidden');
  });
  $('#watchCancel').addEventListener('click', () => $('#watchForm').classList.add('hidden'));
  $('#watchForm').agent.addEventListener('change', () => { fillModelSelect($('#watchForm').model, $('#watchForm').agent.value, ''); syncWatchForm(); });
  $('#watchForm').reviewAgent.addEventListener('change', () => { fillModelSelect($('#watchForm').reviewModel, $('#watchForm').reviewAgent.value, ''); syncWatchForm(); });
  for (const name of ['fixEnabled', 'autoReviewAfterFix', 'autoFixRounds', 'reviewLabelEnabled', 'reviewNewPrs', 'mentionEnabled']) {
    $('#watchForm')[name].addEventListener('change', syncWatchForm);
  }
  for (const name of ['fixLabel', 'reviewLabel']) {
    $('#watchForm')[name].addEventListener('input', syncWatchForm);
  }

  $('#watchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]');
    busy(btn, async () => {
      const body = {
        agent: f.agent.value,
        model: supportsLocalModel(f.agent.value) ? f.model.value : '',
        reviewAgent: f.reviewAgent.value,
        reviewModel: f.reviewAgent.value && supportsLocalModel(f.reviewAgent.value) ? f.reviewModel.value : '',
        fixEnabled: f.fixEnabled.checked,
        fixLabel: f.fixLabel.value,
        autoReviewAfterFix: f.autoReviewAfterFix.checked,
        autoFixRounds: Number(f.autoFixRounds.value) || 0,
        draft: f.draft.checked,
        reviewLabelEnabled: f.reviewLabelEnabled.checked,
        reviewLabel: f.reviewLabel.value,
        reviewNewPrs: f.reviewNewPrs.checked,
        rereviewOnPush: f.rereviewOnPush.checked,
        autoFixCi: f.autoFixCi.checked,
        mentionEnabled: f.mentionEnabled.checked,
        keyword: f.keyword.value,
        allowOutside: f.allowOutside.checked,
        instructions: f.instructions.value,
        profiles: draftWatchProfiles.map((p) => ({
          id: p.id || undefined,
          label: p.label,
          action: p.action,
          agent: p.agent,
          model: supportsLocalModel(p.agent) ? (p.model || '') : '',
          autoReview: p.action !== 'review' && p.autoReview !== false,
          reviewAgent: p.action !== 'review' && p.autoReview !== false ? (p.reviewAgent || '') : '',
          reviewModel: p.action !== 'review' && p.autoReview !== false && p.reviewAgent && supportsLocalModel(p.reviewAgent) ? (p.reviewModel || '') : '',
          autoFixRounds: p.action !== 'review' && p.autoReview !== false ? (Number(p.autoFixRounds) || 0) : 0,
          enabled: p.enabled !== false,
        })),
      };
      const r = await api('POST', '/api/automations/watch', body);
      f.classList.add('hidden');
      await loadAuto();
      if (r.warnings?.length) showDialog('Saved, with warnings', r.warnings.join('\n'));
    });
  });

  $('#watchAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]');
    busy(btn, async () => {
      const r = await api('POST', '/api/automations/watched-repos', { repo: f.repo.value });
      f.repo.value = '';
      await loadAuto();
      if (r.warnings?.length) showDialog('Watching, with warnings', r.warnings.join('\n'));
    });
  });

  $('#autoForm').preset.addEventListener('change', () => {
    const f = $('#autoForm'), p = PRESETS[f.preset.value];
    if (p.label && (!f.label.value || Object.values(PRESETS).some((x) => x.label === f.label.value))) f.label.value = p.label;
    syncForm();
  });
  $('#autoForm').agent.addEventListener('change', () => { fillModelSelect($('#autoForm').model, $('#autoForm').agent.value, ''); syncForm(); });
  $('#autoForm').reviewAgent.addEventListener('change', () => { fillModelSelect($('#autoForm').reviewModel, $('#autoForm').reviewAgent.value, ''); syncForm(); });
  $('#autoForm').autoReview.addEventListener('change', syncForm);
  $('#autoCancel').addEventListener('click', () => { $('#autoForm').classList.add('hidden'); editingRule = null; });
  $('#autoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]');
    busy(btn, async () => {
      const p = PRESETS[f.preset.value];
      const body = {
        ...(editingRule ? { id: editingRule.id, enabled: editingRule.enabled } : {}),
        trigger: p.trigger, action: p.action, repo: f.repo.value, label: f.label.value, keyword: f.keyword.value,
        everyHours: Number(f.everyHours.value), cron: f.cron.value.trim(), agent: f.agent.value, model: supportsLocalModel(f.agent.value) ? f.model.value : '',
        autoReview: f.autoReview.checked,
        reviewAgent: f.autoReview.checked ? f.reviewAgent.value : '',
        reviewModel: f.autoReview.checked && f.reviewAgent.value && supportsLocalModel(f.reviewAgent.value) ? f.reviewModel.value : '',
        autoFixRounds: f.autoReview.checked ? (Number(f.autoFixRounds.value) || 0) : 0,
        instructions: f.instructions.value, draft: f.draft.checked, rereview: f.rereview.checked, allowOutside: f.allowOutside.checked,
        name: f.name.value,
      };
      const r = await api('POST', '/api/automations/rules', body);
      f.classList.add('hidden'); editingRule = null;
      await loadAuto();
      if (r.warnings?.length) showDialog('Saved, with warnings', r.warnings.join('\n'));
    });
  });

  $('#autoSettings').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    busy(f.querySelector('button'), async () => {
      await api('POST', '/api/automations/settings', { pollSeconds: Number(f.pollSeconds.value), maxConcurrent: Number(f.maxConcurrent.value), timeoutMinutes: Number(f.timeoutMinutes.value), loopLimit: Number(f.loopLimit.value), paused: f.paused.checked });
      f.querySelector('button').blur();
      await loadAuto();
    });
  });

  $('#autoNew').addEventListener('click', () => openRuleForm(null));
  $('#autoClear').addEventListener('click', (e) => busy(e.target, async () => { await api('DELETE', '/api/automations/jobs'); await loadAuto(); }));
  $('#refreshAuto').addEventListener('click', (e) => busy(e.target, loadAuto));
  $('#openAuto').addEventListener('click', (e) => busy(e.target, async () => {
    await loadAuto();
    if (!state.ghRepos.length) { api('GET', '/api/repos/github').then((d) => { state.ghRepos = d.repos || []; fillRepoDatalist(); }).catch(() => {}); }
    fillRepoDatalist();
    closeMobileSheet();
    $('#autoDlg').showModal();
    renderAutoDialog();
    clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      const active = document.activeElement;
      if (!$('#autoForm').contains(active) && !$('#watchForm').contains(active) && !$('#watchAddForm').contains(active)) {
        loadAuto().catch(() => {});
      }
    }, 4000);
  }));
  $('#autoClose').addEventListener('click', () => $('#autoDlg').close());
  $('#autoDlg').addEventListener('close', () => { clearInterval(autoTimer); autoTimer = null; });

  // Start with the rest of the UI (start() in app.js calls loadAuto if it exists).
  setInterval(() => { if (!$('#app').classList.contains('hidden')) loadAuto().catch(() => {}); }, 15000);
}

export { autoState, ago, appliedModels, watchedRepoSet, toggleWatchRepo, loadAuto, init };
