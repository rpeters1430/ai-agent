'use strict';
// Polls GitHub for work: labels, @mentions, new PRs, CI failures and schedules.
const { HEADLESS_AGENTS: HEADLESS } = require('../agents');
const { gh } = require('./github');
const { enqueue, enqueueWatch, enqueueWatchProfile } = require('./queue');
const { MARK, TRUSTED, clip, poll, saveRules, settings, watchConfig } = require('./store');
const store = require('./store'); // store.ctx / store.data / store.jobs are replaced at runtime: always read them through store
const { matchesCron } = require('./validate');

const trusted = (cfg, assoc) => cfg.allowOutside || TRUSTED.has(assoc);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pruneSeen(seenObj) {
  for (const [k, v] of Object.entries(seenObj)) if (Date.now() - (v.t || 0) > 60 * 864e5) delete seenObj[k];
}

async function pollCiFailures(repo, cfg, st, onFailure) {
  const prs = await gh('GET', `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=20`);
  const seen = (k) => st.seen[k];
  const mark = (k, v = true) => { st.seen[k] = { t: Date.now(), v }; };
  for (const p of prs) {
    if (p.head?.repo?.full_name !== repo) continue;
    if (!trusted(cfg, p.author_association)) continue;
    const sha = p.head?.sha;
    if (!sha) continue;
    const k = `ci:${p.number}`;
    if (seen(k)?.v === sha) continue;
    const cr = await gh('GET', `/repos/${repo}/commits/${sha}/check-runs?per_page=50`).catch(() => null);
    const runs = cr?.check_runs || [];
    if (!runs.length) continue;
    if (runs.some((r) => r.status !== 'completed')) continue; // wait for CI to finish
    const failed = runs.filter((r) => ['failure', 'timed_out', 'action_required'].includes(r.conclusion));
    if (!failed.length) continue;
    mark(k, sha);
    const details = failed.map((r) => {
      const parts = [`- **${r.name}** (${r.conclusion})${r.html_url ? ` — ${r.html_url}` : ''}`];
      if (r.output?.title) parts.push(`  Title: ${r.output.title}`);
      if (r.output?.summary) parts.push(`  Summary:\n${clip(r.output.summary, 2000)}`);
      if (r.output?.text) parts.push(`  Details:\n${clip(r.output.text, 2000)}`);
      return parts.join('\n');
    }).join('\n\n');
    onFailure(p, `CI checks failed on commit ${sha.slice(0, 8)}. Inspect the failures below, reproduce locally if possible, and fix them:\n\n${details}`);
  }
}

async function pollRule(rule) {
  const st = (rule.state ||= { seen: {} });
  st.seen ||= {};
  const seen = (k) => st.seen[k];
  const mark = (k, v = true) => { st.seen[k] = { t: Date.now(), v }; };

  if (rule.trigger === 'label') {
    const items = await gh('GET', `/repos/${rule.repo}/issues?state=open&labels=${encodeURIComponent(rule.label)}&per_page=30`);
    for (const it of items) {
      if (rule.action === 'review' && !it.pull_request) continue;
      // Remove the label so adding it again triggers a new run. Only people with triage access can add labels.
      let removed = true;
      try { await gh('DELETE', `/repos/${rule.repo}/issues/${it.number}/labels/${encodeURIComponent(rule.label)}`); } catch { removed = false; }
      if (!removed && seen(`i${it.number}`)) continue;
      mark(`i${it.number}`);
      enqueue(rule, { kind: rule.action === 'review' ? 'review' : 'fix_issue', number: it.number, title: it.title, trigger: `label “${rule.label}”` });
    }
  } else if (rule.trigger === 'mention') {
    if (!st.since) { st.since = new Date(rule.createdAt || Date.now()).toISOString(); }
    const cs = await gh('GET', `/repos/${rule.repo}/issues/comments?since=${encodeURIComponent(st.since)}&sort=updated&direction=asc&per_page=100`);
    const re = new RegExp(`(^|[^\\w@/])${escapeRe(rule.keyword)}(?![\\w-])`, 'i');
    let max = st.since;
    for (const c of cs) {
      if (c.updated_at > max) max = c.updated_at;
      if (seen(`c${c.id}`) || new Date(c.created_at) < new Date(rule.createdAt || 0)) continue;
      const body = c.body || '';
      if (body.includes(MARK) || !re.test(body)) continue;
      mark(`c${c.id}`);
      if (!trusted(rule, c.author_association)) continue;
      const n = Number(c.issue_url.split('/').pop());
      enqueue(rule, { kind: 'fix_issue', number: n, instructions: `@${c.user?.login} wrote:\n${clip(body, 8000)}`, trigger: `${rule.keyword} by @${c.user?.login}` });
    }
    // `since` is inclusive; overlapping by a second is fine because of `seen`.
    st.since = max;
  } else if (rule.trigger === 'new_pr') {
    const prs = await gh('GET', `/repos/${rule.repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`);
    for (const p of prs) {
      const k = `p${p.number}`, prev = seen(k);
      if (new Date(p.created_at) < new Date(rule.createdAt || 0)) continue; // only PRs opened after the rule was made
      if (p.draft || !trusted(rule, p.author_association)) continue;
      if (prev && (prev.v === p.head.sha || !rule.rereview)) continue;
      mark(k, p.head.sha);
      enqueue(rule, { kind: 'review', number: p.number, title: p.title, trigger: prev ? 'new commits' : 'new pull request' });
    }
  } else if (rule.trigger === 'schedule') {
    if (rule.cron) {
      const curMin = Math.floor(Date.now() / 60000);
      if (st.lastCronMinute !== curMin && matchesCron(rule.cron, new Date())) {
        st.lastCronMinute = curMin;
        st.lastRun = Date.now();
        enqueue(rule, { kind: 'task', trigger: `cron (${rule.cron})` });
      }
    } else {
      const every = Math.max(1, Number(rule.everyHours) || 24) * 3600e3;
      st.lastRun ||= rule.createdAt || Date.now();
      if (Date.now() - st.lastRun >= every) { st.lastRun = Date.now(); enqueue(rule, { kind: 'task', trigger: 'schedule' }); }
    }
  } else if (rule.trigger === 'ci_failure') {
    await pollCiFailures(rule.repo, rule, st, (p, instructions) => {
      enqueue(rule, { kind: 'pr_task', number: p.number, title: p.title, instructions, trigger: `CI failed on ${p.head.sha.slice(0, 7)}` });
    });
  }
  pruneSeen(st.seen);
}

async function pollWatchedRepo(entry, watch) {
  if (!watch.agent || !HEADLESS[watch.agent]) throw new Error('Pick a worker agent in Watch workflow settings');
  const st = (entry.state ||= { seen: {} });
  st.seen ||= {};
  const seen = (k) => st.seen[k];
  const mark = (k, v = true) => { st.seen[k] = { t: Date.now(), v }; };

  if (watch.fixEnabled && watch.fixLabel) {
    const items = await gh('GET', `/repos/${entry.repo}/issues?state=open&labels=${encodeURIComponent(watch.fixLabel)}&per_page=30`);
    for (const it of items) {
      let removed = true;
      try { await gh('DELETE', `/repos/${entry.repo}/issues/${it.number}/labels/${encodeURIComponent(watch.fixLabel)}`); } catch { removed = false; }
      if (!removed && seen(`fix:${it.number}`)) continue;
      mark(`fix:${it.number}`);
      enqueueWatch(entry, watch, { kind: 'fix_issue', number: it.number, title: it.title, trigger: `label “${watch.fixLabel}”` });
    }
  }

  if (watch.reviewLabelEnabled && watch.reviewLabel) {
    const items = await gh('GET', `/repos/${entry.repo}/issues?state=open&labels=${encodeURIComponent(watch.reviewLabel)}&per_page=30`);
    for (const it of items) {
      if (!it.pull_request) continue;
      let removed = true;
      try { await gh('DELETE', `/repos/${entry.repo}/issues/${it.number}/labels/${encodeURIComponent(watch.reviewLabel)}`); } catch { removed = false; }
      if (!removed && seen(`rev:${it.number}`)) continue;
      mark(`rev:${it.number}`);
      enqueueWatch(entry, watch, { kind: 'review', number: it.number, title: it.title, trigger: `label “${watch.reviewLabel}”` });
    }
  }

  for (const p of watch.profiles || []) {
    if (p.enabled === false || !p.label || !HEADLESS[p.agent]) continue;
    const items = await gh('GET', `/repos/${entry.repo}/issues?state=open&labels=${encodeURIComponent(p.label)}&per_page=30`);
    for (const it of items) {
      if (p.action === 'review' && !it.pull_request) continue;
      let removed = true;
      try { await gh('DELETE', `/repos/${entry.repo}/issues/${it.number}/labels/${encodeURIComponent(p.label)}`); } catch { removed = false; }
      const sk = `prof:${p.id || p.label}:${it.number}`;
      if (!removed && seen(sk)) continue;
      mark(sk);
      enqueueWatchProfile(entry, watch, p, { number: it.number, title: it.title, trigger: `label “${p.label}”` });
    }
  }

  if (watch.reviewNewPrs) {
    const sinceTs = st.newPrSince || entry.addedAt || 0;
    const prs = await gh('GET', `/repos/${entry.repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`);
    for (const p of prs) {
      const k = `p${p.number}`, prev = seen(k);
      if (new Date(p.created_at) < new Date(sinceTs)) continue;
      if (p.draft || !trusted(watch, p.author_association)) continue;
      if (prev && (prev.v === p.head.sha || !watch.rereviewOnPush)) continue;
      mark(k, p.head.sha);
      enqueueWatch(entry, watch, { kind: 'review', number: p.number, title: p.title, trigger: prev ? 'new commits' : 'new pull request' });
    }
  }

  if (watch.mentionEnabled && watch.keyword) {
    if (!st.since) st.since = new Date(entry.addedAt || Date.now()).toISOString();
    const cs = await gh('GET', `/repos/${entry.repo}/issues/comments?since=${encodeURIComponent(st.since)}&sort=updated&direction=asc&per_page=100`);
    const re = new RegExp(`(^|[^\\w@/])${escapeRe(watch.keyword)}(?![\\w-])`, 'i');
    const baseline = new Date(st.mentionSince || entry.addedAt || 0);
    let max = st.since;
    for (const c of cs) {
      if (c.updated_at > max) max = c.updated_at;
      if (seen(`c${c.id}`) || new Date(c.created_at) < baseline) continue;
      const body = c.body || '';
      if (body.includes(MARK) || !re.test(body)) continue;
      mark(`c${c.id}`);
      if (!trusted(watch, c.author_association)) continue;
      const n = Number(c.issue_url.split('/').pop());
      enqueueWatch(entry, watch, { kind: 'fix_issue', number: n, instructions: `@${c.user?.login} wrote:\n${clip(body, 8000)}`, trigger: `${watch.keyword} by @${c.user?.login}` });
    }
    st.since = max;
  }

  if (watch.autoFixCi) {
    await pollCiFailures(entry.repo, watch, st, (p, instructions) => {
      enqueueWatch(entry, watch, { kind: 'pr_task', number: p.number, title: p.title, instructions, trigger: `CI failed on ${p.head.sha.slice(0, 7)}` });
    });
  }

  pruneSeen(st.seen);
}

async function pollAll() {
  if (poll.busy) return;
  poll.busy = true;
  try {
    const s = settings();
    if (!s.paused) {
      const rules = store.data.rules.filter((r) => r.enabled);
      const watched = (store.data.watchedRepos || []).filter((w) => w.enabled);
      if ((rules.length || watched.length) && !(await store.ctx.githubToken())) throw new Error('GitHub is not connected');
      const wcfg = watchConfig();
      for (const w of watched) {
        try { await pollWatchedRepo(w, wcfg); w.lastError = ''; } catch (e) { w.lastError = e.message; }
        w.lastPoll = Date.now();
      }
      for (const r of rules) {
        try { await pollRule(r); r.lastError = ''; } catch (e) { r.lastError = e.message; }
        r.lastPoll = Date.now();
      }
      if (rules.length || watched.length) saveRules();
    }
    poll.error = '';
  } catch (e) { poll.error = e.message; }
  finally { poll.last = Date.now(); poll.busy = false; }
}
function loop() {
  pollAll().finally(() => setTimeout(loop, Math.max(20, settings().pollSeconds | 0) * 1000).unref());
}

Object.assign(module.exports, { trusted, escapeRe, pruneSeen, pollCiFailures, pollRule, pollWatchedRepo, pollAll, loop });
