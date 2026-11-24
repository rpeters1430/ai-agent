'use strict';
// HTTP routes for the Automations UI, and register(), which starts everything.
const fs = require('fs');
const path = require('path');
const { HEADLESS_AGENTS: HEADLESS } = require('../agents');
const { notFound } = require('../errors');
const { ensureLabels, gh, watchLabelDefs } = require('./github');
const { loop } = require('./polling');
const { enqueue, enqueueJob, enqueueWatch, enqueueWatchProfile, newId, pump } = require('./queue');
const { JOBS_DIR, load, poll, pruneOrphanJobDirs, readIf, running, saveJobs, saveRules, settings, stripAnsi, watchConfig } = require('./store');
const store = require('./store'); // store.ctx / store.data / store.jobs are replaced at runtime: always read them through store
const { cleanRule, cleanWatch, defaultAgent, normalizeRepo, validateModel } = require('./validate');

function publicJob(j) {
  const { ruleInstructions: _ruleInstructions, instructions: _instructions, ...rest } = j; // keep prompts out of the job list
  return { ...rest, live: !!j.session && j.status === 'running' };
}

function register(app, wrap, helpers) {
  store.ctx = helpers;
  load();
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  pruneOrphanJobDirs();
  // Re-queue jobs that were waiting when the container stopped.
  setTimeout(pump, 2000).unref();
  setTimeout(loop, 10000).unref();

  app.get('/api/automations', wrap(async (req, res) => {
    const installed = Object.fromEntries(Object.entries(HEADLESS).map(([k, a]) => [k, { label: a.label, installed: store.ctx.isBinInstalled(a.bin) }]));
    const w = watchConfig();
    if (!w.agent) w.agent = defaultAgent();
    res.json({
      settings: settings(),
      watch: w,
      watchedRepos: (store.data.watchedRepos || []).map(({ state, ...entry }) => entry),
      agents: installed,
      models: store.ctx.ollamaApplied ? store.ctx.ollamaApplied() : { opencode: [], pi: [] },
      poll: { last: poll.last, error: poll.error, busy: poll.busy },
      rules: store.data.rules.map(({ state, ...r }) => ({ ...r, lastRun: state?.lastRun || 0 })),
      jobs: store.jobs.slice(-60).reverse().map(publicJob),
    });
  }));

  app.post('/api/automations/settings', wrap(async (req, res) => {
    const b = req.body || {}, s = settings();
    store.data.settings = {
      pollSeconds: Math.max(20, Math.min(3600, Number(b.pollSeconds ?? s.pollSeconds) | 0)),
      maxConcurrent: Math.max(1, Math.min(4, Number(b.maxConcurrent ?? s.maxConcurrent) | 0)),
      timeoutMinutes: Math.max(5, Math.min(600, Number(b.timeoutMinutes ?? s.timeoutMinutes) | 0)),
      loopLimit: b.loopLimit === undefined ? s.loopLimit : Number(b.loopLimit) === 0 ? 0 : Math.max(2, Math.min(50, Number(b.loopLimit) | 0 || 4)),
      paused: b.paused ?? s.paused,
    };
    store.data.settings.paused = !!store.data.settings.paused;
    saveRules(); pump();
    res.json({ ok: true, settings: settings() });
  }));

  app.post('/api/automations/watch', wrap(async (req, res) => {
    const prev = watchConfig();
    const next = cleanWatch(req.body || {}, prev);
    const now = Date.now();
    // Avoid flooding old PRs/comments when turning these triggers on for already-watched repos.
    if (!prev.reviewNewPrs && next.reviewNewPrs) {
      for (const entry of store.data.watchedRepos || []) { entry.state ||= { seen: {} }; entry.state.newPrSince = now; }
    }
    if (!prev.mentionEnabled && next.mentionEnabled) {
      const iso = new Date(now).toISOString();
      for (const entry of store.data.watchedRepos || []) { entry.state ||= { seen: {} }; entry.state.since = iso; entry.state.mentionSince = now; }
    }
    store.data.watch = next;
    saveRules();
    const warnings = [];
    const defs = watchLabelDefs(next);
    if (defs.length && (await store.ctx.githubToken())) {
      for (const entry of (store.data.watchedRepos || []).filter((e) => e.enabled)) {
        warnings.push(...(await ensureLabels(entry.repo, defs)));
      }
    }
    res.json({ ok: true, watch: watchConfig(), warnings });
  }));

  app.post('/api/automations/watched-repos', wrap(async (req, res) => {
    const b = req.body || {};
    const repoInput = normalizeRepo(b.repo);
    let existing = (store.data.watchedRepos || []).find((w) => w.repo.toLowerCase() === repoInput.toLowerCase());
    if (existing) {
      if (b.enabled !== undefined) existing.enabled = !!b.enabled;
      saveRules();
      return res.json({ ok: true, repo: existing.repo, existed: true, warnings: [] });
    }
    // Ensure a valid default worker agent is saved on first watch so polling works immediately.
    if (!store.data.watch?.agent || !HEADLESS[store.data.watch.agent]) {
      store.data.watch = { ...watchConfig(), agent: defaultAgent() };
    }
    const w = watchConfig();
    const meta = await gh('GET', `/repos/${repoInput}`).catch((e) => { throw new Error(e.status === 404 ? `Can't see ${repoInput} with the connected GitHub account` : e.message); });
    const warnings = [];
    if (meta.permissions && !meta.permissions.push && (w.fixEnabled || w.mentionEnabled)) {
      warnings.push(`${meta.full_name}: the connected GitHub account has no push access, so fixes can't be pushed.`);
    }
    warnings.push(...(await ensureLabels(meta.full_name, watchLabelDefs(w))));
    const now = Date.now();
    const entry = {
      repo: meta.full_name,
      enabled: b.enabled !== false,
      addedAt: now,
      lastPoll: 0,
      lastError: '',
      state: { seen: {}, newPrSince: now, mentionSince: now, since: new Date(now).toISOString() },
    };
    store.data.watchedRepos.push(entry);
    saveRules();
    res.json({ ok: true, repo: entry.repo, warnings });
  }));

  app.delete('/api/automations/watched-repos/:owner/:name', wrap(async (req, res) => {
    const repo = normalizeRepo(`${req.params.owner}/${req.params.name}`);
    store.data.watchedRepos = (store.data.watchedRepos || []).filter((w) => w.repo.toLowerCase() !== repo.toLowerCase());
    saveRules();
    res.json({ ok: true });
  }));

  app.post('/api/automations/watched-repos/:owner/:name/run', wrap(async (req, res) => {
    const repo = normalizeRepo(`${req.params.owner}/${req.params.name}`);
    const entry = (store.data.watchedRepos || []).find((w) => w.repo.toLowerCase() === repo.toLowerCase());
    if (!entry) throw notFound('watched repository not found');
    const n = Number(req.body?.number) || 0;
    if (!n || n < 1) throw new Error('Enter an issue or PR number');
    const w = watchConfig();
    if (!w.agent || !HEADLESS[w.agent]) w.agent = defaultAgent();
    const profile = req.body?.profileId ? (w.profiles || []).find((p) => p.id === req.body.profileId) : null;
    if (req.body?.profileId && !profile) throw notFound('label profile not found');
    const kind = req.body?.action === 'review' ? 'review' : 'fix_issue';
    const job = profile
      ? enqueueWatchProfile(entry, w, profile, { number: n, trigger: 'run by hand', instructions: String(req.body?.instructions || '').slice(0, 8000) })
      : enqueueWatch(entry, w, {
          kind,
          number: n,
          trigger: 'run by hand',
          instructions: String(req.body?.instructions || '').slice(0, 8000),
        });
    if (!job) throw new Error('That one is already queued or running');
    res.json({ ok: true, id: job.id });
  }));

  app.post('/api/automations/rules', wrap(async (req, res) => {
    const b = req.body || {};
    const old = b.id ? store.data.rules.find((r) => r.id === b.id) : null;
    if (b.id && !old) throw notFound('rule not found');
    const rule = cleanRule(b, old || { id: newId(), createdAt: Date.now(), state: { seen: {} } });
    // Check access and make sure the trigger label exists, so it shows up in GitHub's label picker.
    const meta = await gh('GET', `/repos/${rule.repo}`).catch((e) => { throw new Error(e.status === 404 ? `Can't see ${rule.repo} with the connected GitHub account` : e.message); });
    rule.repo = meta.full_name;
    const warnings = [];
    if (meta.permissions && !meta.permissions.push && !(rule.trigger === 'label' && rule.action === 'review') && rule.trigger !== 'new_pr') warnings.push('The connected GitHub account has no push access, so fixes can\'t be pushed.');
    if (rule.trigger === 'label') {
      try { await gh('POST', `/repos/${rule.repo}/labels`, { name: rule.label, color: rule.action === 'review' ? '1d76db' : 'e0864a', description: `Agent Hub: ${rule.action === 'review' ? 'review this PR' : (rule.autoReview ? 'fix & review this' : 'fix this')} with ${HEADLESS[rule.agent].label}`.slice(0, 100) }); }
      catch (e) { if (e.status !== 422) warnings.push(`Couldn't create the label: ${e.message}`); }
    }
    if (old && rule.trigger !== old.trigger) { rule.state = { seen: {} }; rule.createdAt = Date.now(); } // new baseline
    if (old) Object.assign(old, rule); else store.data.rules.push(rule);
    saveRules();
    res.json({ ok: true, id: rule.id, warnings });
  }));

  app.delete('/api/automations/rules/:id', wrap(async (req, res) => {
    store.data.rules = store.data.rules.filter((r) => r.id !== req.params.id);
    saveRules(); res.json({ ok: true });
  }));

  // Run a rule by hand, optionally on one issue/PR number.
  app.post('/api/automations/rules/:id/run', wrap(async (req, res) => {
    const rule = store.data.rules.find((r) => r.id === req.params.id);
    if (!rule) throw notFound('rule not found');
    const n = Number(req.body?.number) || 0;
    let t;
    if (rule.trigger === 'schedule') t = { kind: 'task', trigger: 'run by hand' };
    else {
      if (!n || n < 1) throw new Error('Enter an issue or PR number');
      const kind = rule.trigger === 'new_pr' || rule.action === 'review' ? 'review' : 'fix_issue';
      t = { kind, number: n, trigger: 'run by hand', instructions: String(req.body?.instructions || '').slice(0, 8000) };
    }
    const job = enqueue(rule, t);
    if (!job) throw new Error('That one is already queued or running');
    res.json({ ok: true, id: job.id });
  }));

  app.post('/api/automations/jobs/:id/cancel', wrap(async (req, res) => {
    const j = store.jobs.find((x) => x.id === req.params.id);
    if (!j) throw notFound('job not found');
    if (j.status === 'queued') { j.status = 'cancelled'; j.endedAt = Date.now(); saveJobs(); }
    else if (running.has(j.id)) { running.get(j.id).cancel = true; if (j.session) await store.ctx.run('tmux', ['kill-session', '-t', `=${j.session}`]); }
    res.json({ ok: true });
  }));

  app.post('/api/automations/jobs/:id/retry', wrap(async (req, res) => {
    const j = store.jobs.find((x) => x.id === req.params.id);
    if (!j) throw notFound('job not found');
    let job;
    if (j.source === 'watch' || String(j.ruleId || '').startsWith('watch:')) {
      const entry = (store.data.watchedRepos || []).find((w) => w.repo.toLowerCase() === j.repo.toLowerCase()) || { repo: j.repo };
      const w = watchConfig();
      if (!w.agent || !HEADLESS[w.agent]) w.agent = j.workerAgent || j.agent;
      const profile = j.profileId ? (w.profiles || []).find((p) => p.id === j.profileId) : null;
      job = profile
        ? enqueueWatchProfile(entry, w, profile, { kind: j.kind === 'pr_task' ? 'fix_issue' : j.kind, number: j.number, title: j.title, instructions: j.instructions, trigger: 'retry' })
        : enqueueWatch(entry, w, {
            kind: j.kind === 'pr_task' ? 'fix_issue' : j.kind,
            number: j.number,
            title: j.title,
            instructions: j.instructions,
            trigger: 'retry',
          });
    } else {
      const rule = store.data.rules.find((r) => r.id === j.ruleId);
      if (!rule) throw new Error('its rule was deleted');
      job = enqueue(rule, { kind: j.kind === 'pr_task' ? 'fix_issue' : j.kind, number: j.number, title: j.title, instructions: j.instructions, trigger: 'retry' });
    }
    if (!job) throw new Error('already queued or running');
    res.json({ ok: true, id: job.id });
  }));

  app.get('/api/automations/jobs/:id/log', wrap(async (req, res) => {
    const j = store.jobs.find((x) => x.id === req.params.id);
    if (!j) throw notFound('job not found');
    const d = path.join(JOBS_DIR, j.id);
    res.json({ log: stripAnsi(readIf(path.join(d, 'log.txt'))), output: readIf(path.join(d, 'output.md')), prompt: readIf(path.join(d, 'prompt.md')) });
  }));

  app.delete('/api/automations/jobs', wrap(async (req, res) => {
    const keep = store.jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    for (const j of store.jobs) if (!keep.includes(j)) fs.rmSync(path.join(JOBS_DIR, j.id), { recursive: true, force: true });
    store.jobs = keep; saveJobs(); res.json({ ok: true });
  }));

  // GitHub open issues & PRs browser for one-click Fix / Review
  app.get('/api/github/repos/:owner/:name/items', wrap(async (req, res) => {
    const repo = normalizeRepo(`${req.params.owner}/${req.params.name}`);
    const items = await gh('GET', `/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=40`);
    res.json({
      repo,
      items: (items || []).map((it) => ({
        number: it.number,
        title: it.title,
        isPr: !!it.pull_request,
        draft: !!it.draft,
        author: it.user?.login || '',
        labels: (it.labels || []).map((l) => ({ name: l.name, color: l.color })),
        comments: it.comments || 0,
        updatedAt: it.updated_at,
        url: it.html_url,
      })),
    });
  }));

  // Quick trigger on any repo's issue/PR without needing a pre-existing watched entry
  app.post('/api/github/repos/:owner/:name/dispatch', wrap(async (req, res) => {
    const repo = normalizeRepo(`${req.params.owner}/${req.params.name}`);
    const n = Number(req.body?.number) || 0;
    if (!n || n < 1) throw new Error('Enter a valid issue or PR number');
    const action = req.body?.action === 'review' ? 'review' : 'fix_issue';
    const w = watchConfig();
    const agent = req.body?.agent && HEADLESS[req.body.agent] ? req.body.agent : (w.agent && HEADLESS[w.agent] ? w.agent : defaultAgent());
    const model = validateModel(agent, String(req.body?.model ?? (agent === w.agent ? w.model : '') ?? '').trim());
    const job = enqueueJob({
      source: 'watch',
      ruleId: `watch:${repo.toLowerCase()}`,
      ruleName: `Quick · ${repo}`,
      repo,
      agent,
      model,
      workerAgent: agent,
      workerModel: model,
      reviewAgent: w.reviewAgent || '',
      reviewModel: w.reviewModel || '',
      ruleInstructions: w.instructions || '',
      draft: w.draft !== false,
      autoReview: action !== 'review' && !!w.autoReviewAfterFix,
      autoFixRemaining: action !== 'review' && w.autoReviewAfterFix ? (Number(w.autoFixRounds) | 0) : 0,
      kind: action,
      number: n,
      title: String(req.body?.title || ''),
      trigger: 'Issues/PRs browser',
    });
    if (!job) throw new Error('That issue/PR is already queued or running');
    res.json({ ok: true, id: job.id });
  }));

  // Automation usage & performance stats
  app.get('/api/automations/stats', wrap(async (req, res) => {
    const total = store.jobs.length;
    let succeeded = 0, failed = 0, cancelled = 0, durSum = 0, durCount = 0, totalTools = 0, totalTokens = 0;
    const byAgent = {};
    for (const j of store.jobs) {
      if (j.status === 'succeeded') succeeded++;
      else if (j.status === 'failed') failed++;
      else if (j.status === 'cancelled' || j.status === 'interrupted') cancelled++;
      const dur = j.startedAt && j.endedAt ? Math.max(0, (j.endedAt - j.startedAt) / 1000) : null;
      if (dur !== null) { durSum += dur; durCount++; }
      const m = j.metrics || {};
      const tools = Number(m.tools) || 0;
      const tokens = (Number(m.totalInputTokens) || Number(m.maxPromptTokens) || 0) + (Number(m.totalOutputTokens) || 0);
      totalTools += tools;
      totalTokens += tokens;
      const ak = j.agent || 'unknown';
      const ba = (byAgent[ak] ||= { agent: ak, label: HEADLESS[ak]?.label || ak, total: 0, succeeded: 0, failed: 0, tools: 0, tokens: 0, durSum: 0, durCount: 0 });
      ba.total++;
      if (j.status === 'succeeded') ba.succeeded++;
      if (j.status === 'failed') ba.failed++;
      ba.tools += tools;
      ba.tokens += tokens;
      if (dur !== null) { ba.durSum += dur; ba.durCount++; }
    }
    const agents = Object.values(byAgent).map((a) => ({
      agent: a.agent, label: a.label, total: a.total, succeeded: a.succeeded, failed: a.failed,
      passRate: a.succeeded + a.failed ? Math.round((a.succeeded / (a.succeeded + a.failed)) * 100) : null,
      avgSecs: a.durCount ? Math.round(a.durSum / a.durCount) : 0,
      tools: a.tools, tokens: a.tokens,
    })).sort((a, b) => b.total - a.total);
    res.json({
      total, succeeded, failed, cancelled,
      passRate: succeeded + failed ? Math.round((succeeded / (succeeded + failed)) * 100) : null,
      avgSecs: durCount ? Math.round(durSum / durCount) : 0,
      totalTools, totalTokens, agents,
    });
  }));
}

Object.assign(module.exports, { publicJob, register });
