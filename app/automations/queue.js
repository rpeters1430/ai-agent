'use strict';
// The job queue: job records, follow-up jobs (auto-review / auto-fix rounds), and starting queued jobs.
const crypto = require('crypto');
const { HEADLESS_AGENTS: HEADLESS } = require('../agents');
const { OLLAMA_CLI_KEYS } = require('../ollama');
const { comment } = require('./github');
const runner = require('./runner'); // circular (pump runs jobs, jobs queue follow-ups): use through the module
const { MAX_AUTO_FIX_ROUNDS, clip, running, saveJobs, saveRules, settings } = require('./store');
const store = require('./store'); // store.ctx / store.data / store.jobs are replaced at runtime: always read them through store

const newId = () => crypto.randomBytes(5).toString('hex');
const kindLabel = (j) => ({ fix_issue: `Fix #${j.number}`, pr_task: `PR #${j.number}`, review: `Review #${j.number}`, task: 'Task' }[j.kind] || j.kind);

function effectiveReviewer(workerAgent, workerModel, reviewAgent, reviewModel) {
  if (reviewAgent && HEADLESS[reviewAgent]) {
    return { agent: reviewAgent, model: OLLAMA_CLI_KEYS.includes(reviewAgent) ? (reviewModel || '') : '' };
  }
  return { agent: workerAgent, model: OLLAMA_CLI_KEYS.includes(workerAgent) ? (workerModel || '') : '' };
}

function buildReviewFollowUp(job, prNumber, prTitle) {
  const rev = effectiveReviewer(job.workerAgent || job.agent, job.workerModel ?? job.model, job.reviewAgent, job.reviewModel);
  const round = job.autoFixRound || 0;
  return {
    source: job.source || 'rule',
    ruleId: job.ruleId,
    ruleName: job.ruleName,
    repo: job.repo,
    agent: rev.agent,
    model: rev.model,
    workerAgent: job.workerAgent || job.agent,
    workerModel: job.workerModel ?? job.model ?? '',
    reviewAgent: job.reviewAgent || '',
    reviewModel: job.reviewModel || '',
    ruleInstructions: job.ruleInstructions || '',
    draft: job.draft !== false,
    kind: 'review',
    number: prNumber,
    title: prTitle || job.title || '',
    instructions: '',
    trigger: round > 0 ? `re-review (round ${round})` : (job.kind === 'fix_issue' && job.number ? `auto-review of #${job.number}` : 'auto-review'),
    parentJobId: job.id,
    autoReview: false,
    autoFixRemaining: Math.max(0, Number(job.autoFixRemaining ?? job.autoFixRounds ?? 0) | 0),
    autoFixRound: round,
  };
}

function buildFixFollowUp(job, reviewSummary) {
  const remaining = Math.max(0, (Number(job.autoFixRemaining) | 0) - 1);
  const nextRound = (Number(job.autoFixRound) | 0) + 1;
  return {
    source: job.source || 'rule',
    ruleId: job.ruleId,
    ruleName: job.ruleName,
    repo: job.repo,
    agent: job.workerAgent || job.agent,
    model: job.workerModel ?? '',
    workerAgent: job.workerAgent || job.agent,
    workerModel: job.workerModel ?? '',
    reviewAgent: job.reviewAgent || '',
    reviewModel: job.reviewModel || '',
    ruleInstructions: job.ruleInstructions || '',
    draft: job.draft !== false,
    kind: 'pr_task',
    number: job.number,
    title: job.title || '',
    instructions: `Address the automated code review findings below and fix the concrete problems reported:\n\n${clip(reviewSummary, 16000)}`,
    trigger: `auto-fix review (round ${nextRound})`,
    parentJobId: job.id,
    autoReview: true,
    autoFixRemaining: remaining,
    autoFixRound: nextRound,
  };
}

function enqueueJob(spec) {
  const activeDup = store.jobs.some((j) => {
    if (j.status !== 'queued' && j.status !== 'running') return false;
    if (spec.number) return j.repo.toLowerCase() === spec.repo.toLowerCase() && j.number === spec.number;
    return j.ruleId === spec.ruleId && !j.number;
  });
  if (activeDup) return null;
  const job = {
    id: newId(),
    source: spec.source || 'rule',
    ruleId: spec.ruleId,
    ruleName: spec.ruleName,
    repo: spec.repo,
    agent: spec.agent,
    model: spec.model || '',
    workerAgent: spec.workerAgent || spec.agent,
    workerModel: spec.workerModel ?? spec.model ?? '',
    reviewAgent: spec.reviewAgent || '',
    reviewModel: spec.reviewModel || '',
    ruleInstructions: spec.ruleInstructions || '',
    draft: spec.draft !== false,
    autoReview: !!spec.autoReview,
    autoFixRemaining: Math.max(0, Math.min(MAX_AUTO_FIX_ROUNDS, Number(spec.autoFixRemaining ?? spec.autoFixRounds ?? 0) | 0)),
    autoFixRound: Math.max(0, Number(spec.autoFixRound) | 0),
    parentJobId: spec.parentJobId || '',
    profileId: spec.profileId || '',
    kind: spec.kind,
    number: spec.number || 0,
    title: spec.title || '',
    instructions: spec.instructions || '',
    trigger: spec.trigger || '',
    status: 'queued',
    step: '',
    createdAt: Date.now(),
  };
  store.jobs.push(job);
  saveJobs();
  pump();
  return job;
}

function enqueue(rule, t) {
  const isFix = t.kind === 'fix_issue' || t.kind === 'pr_task';
  const autoReview = isFix && !!rule.autoReview;
  return enqueueJob({
    source: 'rule',
    ruleId: rule.id,
    ruleName: rule.name,
    repo: rule.repo,
    agent: rule.agent,
    model: rule.model || '',
    workerAgent: rule.agent,
    workerModel: rule.model || '',
    reviewAgent: rule.reviewAgent || '',
    reviewModel: rule.reviewModel || '',
    ruleInstructions: rule.trigger === 'schedule' ? '' : (rule.instructions || ''),
    draft: rule.draft !== false,
    autoReview,
    autoFixRemaining: autoReview ? (Number(rule.autoFixRounds) | 0) : 0,
    kind: t.kind,
    number: t.number || 0,
    title: t.title || '',
    instructions: t.instructions || (rule.trigger === 'schedule' ? rule.instructions : ''),
    trigger: t.trigger,
  });
}

function enqueueWatch(entry, watch, t) {
  const isReview = t.kind === 'review';
  const rev = effectiveReviewer(watch.agent, watch.model, watch.reviewAgent, watch.reviewModel);
  const autoReview = !isReview && !!watch.autoReviewAfterFix;
  return enqueueJob({
    source: 'watch',
    ruleId: `watch:${entry.repo.toLowerCase()}`,
    ruleName: `Watch · ${entry.repo}`,
    repo: entry.repo,
    agent: isReview ? rev.agent : watch.agent,
    model: isReview ? rev.model : (watch.model || ''),
    workerAgent: watch.agent,
    workerModel: watch.model || '',
    reviewAgent: watch.reviewAgent || '',
    reviewModel: watch.reviewModel || '',
    ruleInstructions: watch.instructions || '',
    draft: watch.draft !== false,
    autoReview,
    autoFixRemaining: autoReview ? (Number(watch.autoFixRounds) | 0) : 0,
    kind: t.kind,
    number: t.number || 0,
    title: t.title || '',
    instructions: t.instructions || '',
    trigger: t.trigger,
  });
}

function enqueueWatchProfile(entry, watch, profile, t) {
  const isReview = profile.action === 'review' || t.kind === 'review';
  const autoReview = !isReview && !!profile.autoReview;
  return enqueueJob({
    source: 'watch',
    profileId: profile.id || '',
    ruleId: `watch:${entry.repo.toLowerCase()}`,
    ruleName: `Watch · ${entry.repo} (${profile.label})`,
    repo: entry.repo,
    agent: profile.agent,
    model: profile.model || '',
    workerAgent: profile.agent,
    workerModel: profile.model || '',
    reviewAgent: profile.reviewAgent || '',
    reviewModel: profile.reviewModel || '',
    ruleInstructions: watch.instructions || '',
    draft: watch.draft !== false,
    autoReview,
    autoFixRemaining: autoReview ? (Number(profile.autoFixRounds) | 0) : 0,
    kind: isReview ? 'review' : 'fix_issue',
    number: t.number || 0,
    title: t.title || '',
    instructions: t.instructions || '',
    trigger: t.trigger || `label “${profile.label}”`,
  });
}

function markPrReviewed(repo, prNumber, headSha) {
  if (!prNumber) return;
  const key = `p${prNumber}`;
  const lower = repo.toLowerCase();
  let changed = false;
  for (const w of store.data.watchedRepos || []) {
    if (w.repo.toLowerCase() === lower) {
      w.state ||= { seen: {} };
      w.state.seen ||= {};
      w.state.seen[key] = { t: Date.now(), v: headSha || true };
      changed = true;
    }
  }
  for (const r of store.data.rules || []) {
    if (r.trigger === 'new_pr' && r.repo.toLowerCase() === lower) {
      r.state ||= { seen: {} };
      r.state.seen ||= {};
      r.state.seen[key] = { t: Date.now(), v: headSha || true };
      changed = true;
    }
  }
  if (changed) saveRules();
}

function pump() {
  const max = Math.max(1, Math.min(4, settings().maxConcurrent | 0));
  for (const j of store.jobs) {
    if (running.size >= max) break;
    if (j.status !== 'queued') continue;
    const handle = { cancel: false };
    running.set(j.id, handle);
    Object.assign(j, { status: 'running', startedAt: Date.now() }); saveJobs();
    let followUp = null;
    runner.runJob(j, handle)
      .then((res) => { j.status = 'succeeded'; followUp = res?.followUp || null; })
      .catch(async (e) => {
        j.status = handle.cancel ? 'cancelled' : 'failed'; j.error = e.message;
        await runner.cleanupIfEmpty(j).catch(() => {});
        if (j.announced && !j.told) await comment(j.repo, j.number, `🤖 **Agent Hub** — the automation failed: ${clip(e.message, 2000)}`).catch(() => {});
      })
      .finally(() => {
        j.endedAt = Date.now(); j.step = ''; running.delete(j.id);
        if (followUp) {
          const next = enqueueJob(followUp);
          if (next) j.chainedJobId = next.id;
        }
        saveJobs(); pump();
        try { store.ctx.onJobEnd?.(j); } catch {}
      });
  }
}

Object.assign(module.exports, { newId, kindLabel, effectiveReviewer, buildReviewFollowUp, buildFixFollowUp, enqueueJob, enqueue, enqueueWatch, enqueueWatchProfile, markPrReviewed, pump });
