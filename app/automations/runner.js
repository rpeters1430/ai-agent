'use strict';
// Runs one automation job: clone, checkout in its own worktree, run the agent in tmux, then post/push the result.
const fs = require('fs');
const path = require('path');
const { HEADLESS_AGENTS: HEADLESS } = require('../agents');
const { LOOP_EXIT } = require('../agentstream');
const { comment, gh, whoami } = require('./github');
const { buildPrompt, parseReviewVerdict, reviewText, threadText } = require('./prompts');
const queue = require('./queue'); // circular (pump runs jobs, jobs queue follow-ups): use through the module
const { JOBS_DIR, MARK, clip, readIf, saveJobs, settings, step, stripAnsi, withLock } = require('./store');
const store = require('./store'); // store.ctx / store.data / store.jobs are replaced at runtime: always read them through store

const git = (dir, args, timeout = 120000) => store.ctx.run('git', ['-C', dir, ...args], { timeout });
async function must(p, what) { const r = await p; if (!r.ok) throw new Error(`${what}: ${(r.stderr || r.stdout).trim()}`); return r.stdout.trim(); }

// Find the workspace clone of owner/name, cloning it if needed. Returns the folder name.
async function ensureClone(full) {
  const ws = store.ctx.WORKSPACE;
  for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || !fs.existsSync(path.join(ws, e.name, '.git'))) continue;
    const u = (await git(path.join(ws, e.name), ['config', '--get', 'remote.origin.url'])).stdout.trim();
    const m = u.match(/github\.com[:/]+(.+?)(\.git)?\/?$/i);
    if (m && m[1].toLowerCase() === full.toLowerCase()) return e.name;
  }
  const [owner, name] = full.split('/');
  const local = [name, `${owner}__${name}`, `${owner}-${name}`].find((n) => store.ctx.SAFE_NAME.test(n) && !fs.existsSync(path.join(ws, n)));
  if (!local) throw new Error(`no free folder name to clone ${full} into`);
  await must(store.ctx.run('gh', ['repo', 'clone', full, path.join(ws, local)], { timeout: 15 * 60 * 1000 }), `clone ${full}`);
  return local;
}

// Fetch, look up the issue/PR and create the job's worktree. Runs under the clone's lock, because two jobs doing
// `git fetch` / `git worktree add` in one clone at the same time can fail on git's lock files.
async function prepareCheckout(job, local) {
  const repo = job.repo;
  const ldir = store.ctx.repoDir(local);
  await must(git(ldir, ['fetch', 'origin', '--prune'], 10 * 60 * 1000), 'git fetch');
  const meta = await gh('GET', `/repos/${repo}`);

  let item = null, pr = null;
  if (job.number) {
    item = await gh('GET', `/repos/${repo}/issues/${job.number}`);
    job.url = item.html_url; job.title = item.title;
    if (item.pull_request) pr = await gh('GET', `/repos/${repo}/pulls/${job.number}`);
    if (job.kind === 'fix_issue' && pr) job.kind = 'pr_task';   // a label/mention on a PR means "work on this PR"
    if (job.kind === 'review' && !pr) throw new Error(`#${job.number} is an issue, not a pull request`);
  }
  if (pr && job.kind === 'pr_task' && pr.head.repo?.full_name !== repo) {
    job.kind = 'review';                                       // forks can't be pushed to: answer with a review instead
    job.autoReview = false;
    job.autoFixRemaining = 0;
    job.note = 'PR comes from a fork, so Agent Hub replied with a review instead of pushing changes.';
  }

  // Worktree: one per job, so jobs never collide with each other or with your own checkouts.
  const short = job.id.slice(0, 4);
  fs.mkdirSync(path.join(store.ctx.WT_ROOT, local), { recursive: true });
  let wt, branch = '', startSha = '';
  if (pr) {
    const ref = `refs/remotes/agent-hub/pr-${job.number}`;
    await must(git(ldir, ['fetch', 'origin', `+refs/pull/${job.number}/head:${ref}`], 10 * 60 * 1000), 'fetch PR');
    await git(ldir, ['fetch', 'origin', pr.base.ref], 5 * 60 * 1000);
    startSha = await must(git(ldir, ['rev-parse', ref]), 'rev-parse');
    wt = store.ctx.branchSlug(`${job.kind === 'review' ? 'review' : 'pr'}-${job.number}-${short}`);
    await must(git(ldir, ['worktree', 'add', '--detach', store.ctx.wtDir(local, wt), startSha]), 'git worktree add');
  } else {
    const slug = job.number ? `issue-${job.number}` : store.ctx.branchSlug((job.ruleName || 'task').toLowerCase()).slice(0, 30) || 'task';
    branch = `agent-hub/${slug}-${short}`;
    wt = store.ctx.branchSlug(branch);
    startSha = await must(git(ldir, ['rev-parse', `origin/${meta.default_branch}`]), 'find default branch');
    await must(git(ldir, ['worktree', 'add', '-b', branch, store.ctx.wtDir(local, wt), startSha]), 'git worktree add');
  }
  return { ldir, meta, item, pr, wt, branch, startSha };
}

async function runJob(job, handle) {
  const a = HEADLESS[job.agent];
  if (!a) throw new Error(`unknown agent ${job.agent}`);
  const jdir = path.join(JOBS_DIR, job.id);
  fs.mkdirSync(jdir, { recursive: true, mode: 0o700 });
  const out = path.join(jdir, 'output.md');
  const repo = job.repo;

  step(job, 'Preparing the repository');
  const local = await withLock('clone', () => ensureClone(repo));
  job.local = local;
  const { meta, item, pr, wt, branch, startSha } = await withLock(`repo:${local}`, () => prepareCheckout(job, local));
  job.wt = wt; job.branch = branch; job.startSha = startSha;
  const wdir = store.ctx.wtDir(local, wt);
  job.wtPath = wdir;

  step(job, 'Reading the issue/PR');
  const info = { out, wdir, item, pr };
  if (item) {
    info.thread = await threadText(repo, job.number);
    if (pr && job.kind === 'pr_task') info.reviews = await reviewText(repo, job.number);
  }
  fs.writeFileSync(path.join(jdir, 'prompt.md'), buildPrompt(job, info));
  if (item) job.announced = !!(await comment(repo, job.number, `🤖 **Agent Hub** — ${a.label} is ${job.kind === 'review' ? 'reviewing this pull request' : 'working on this'}. I'll post the result here.`).catch(() => null));

  // Run the agent in a tmux session so it can be watched live from the UI.
  step(job, `${a.label} is working`);
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const script = [
    // Saved API keys are sourced from ~/.agent-hub/env.sh, never written into run.sh.
    ...(store.ctx.envSource ? [store.ctx.envSource()] : []),
    `cd ${q(wdir)} || exit 1`,
    `JOBDIR=${q(jdir)}`,
    `P="$(cat ${q(path.join(jdir, 'prompt.md'))})"`,
    `echo "== Agent Hub automation: ${a.label} (job ${job.id}) — log is saved in Automations"`,
    'set -o pipefail',
    `${a.cmd(job.model, settings().loopLimit)} 2>&1 | tee ${q(path.join(jdir, 'log.txt'))}`,
    'code=$?',
    `echo "$code" > ${q(path.join(jdir, 'exit.tmp'))} && mv ${q(path.join(jdir, 'exit.tmp'))} ${q(path.join(jdir, 'exit'))}`,
    'echo; echo "[agent exited with code $code - Agent Hub is posting the result. This window closes in 2 minutes.]"',
    'sleep 120',
  ].join('\n');
  fs.writeFileSync(path.join(jdir, 'run.sh'), script + '\n', { mode: 0o700 });
  const sess = store.ctx.tmuxName(`auto-${job.agent}-${job.id}`);
  job.session = sess; saveJobs();
  await must(store.ctx.run('tmux', ['new-session', '-d', '-s', sess, '-c', wdir, '-x', '200', '-y', '50', 'bash', '-lc', `bash ${q(path.join(jdir, 'run.sh'))}`]), 'tmux');
  for (const [k, v] of [['@agent', job.agent], ['@repo', local], ['@wt', wt], ['@label', `Auto · ${queue.kindLabel(job)} · ${a.label}`]]) await store.ctx.run('tmux', ['set-option', '-t', sess, k, v]);

  const deadline = Date.now() + settings().timeoutMinutes * 60000;
  const exitFile = path.join(jdir, 'exit');
  let code = null;
  while (code === null) {
    await new Promise((r) => setTimeout(r, 3000));
    if (fs.existsSync(exitFile)) { code = Number(readIf(exitFile).trim()); break; }
    const alive = (await store.ctx.run('tmux', ['has-session', '-t', `=${sess}`])).ok;
    if (handle.cancel || !alive || Date.now() > deadline) {
      await store.ctx.run('tmux', ['kill-session', '-t', `=${sess}`]);
      const why = handle.cancel ? 'Cancelled.' : !alive ? 'The agent session was closed.' : `Timed out after ${settings().timeoutMinutes} minutes.`;
      if (item) { job.told = true; await comment(repo, job.number, `🤖 **Agent Hub** — ${a.label} stopped: ${why}`).catch(() => {}); }
      throw new Error(why + ' The worktree was kept.');
    }
  }

  const logTail = () => clip(stripAnsi(readIf(path.join(jdir, 'log.txt'), 6000)).trim(), 6000);
  const summary = readIf(out, 60000).trim();
  job.resultText = clip(summary || logTail(), 4000);
  try {
    const sm = JSON.parse(readIf(path.join(jdir, 'stream.json')));
    if (sm && typeof sm === 'object') {
      job.metrics = {
        tools: Number(sm.tools) || 0,
        maxPromptTokens: Number(sm.maxPromptTokens) || 0,
        totalInputTokens: Number(sm.totalInputTokens) || 0,
        totalOutputTokens: Number(sm.totalOutputTokens) || 0,
      };
    }
  } catch {}
  const footer = `\n\n---\n<sub>Automated by Agent Hub · ${a.label}${job.model ? ` (${job.model})` : ''} · ${job.ruleName}</sub>`;

  if (code === LOOP_EXIT) {
    let loop = {}; try { loop = JSON.parse(readIf(path.join(jdir, 'stream.json'))).loop || {}; } catch {}
    const why = `the loop guard stopped it — it ran \`${loop.call || 'the same step'}\` ${loop.times || settings().loopLimit} times with the same result.`;
    job.told = true;
    if (item) await comment(repo, job.number, `🤖 **Agent Hub** — ${a.label}${job.model ? ` (${job.model})` : ''} didn't finish: ${why} Small local models often do this; try a larger model or another agent.\n\n<details><summary>Last output</summary>\n\n\`\`\`\n${logTail()}\n\`\`\`\n</details>${footer}`).catch(() => {});
    throw new Error(`${a.label} looped: ${why} The worktree was kept, so you can check or continue its changes.`);
  }

  if (code !== 0) {
    job.told = true;
    if (item) await comment(repo, job.number, `🤖 **Agent Hub** — ${a.label} failed (exit code ${code}).\n\n<details><summary>Last output</summary>\n\n\`\`\`\n${logTail()}\n\`\`\`\n</details>${footer}`).catch(() => {});
    throw new Error(`${a.label} exited with code ${code}. The worktree was kept.`);
  }

  if (job.kind === 'review') {
    step(job, 'Posting the review');
    const verdict = parseReviewVerdict(summary);
    job.verdict = verdict;
    const willAutoFix = verdict === 'changes_requested' && (job.autoFixRemaining || 0) > 0 && pr?.head?.repo?.full_name === repo;
    const body = (job.note ? `> ${job.note}\n\n` : '') + (summary || `*${a.label} didn't write a review. Last output:*\n\n\`\`\`\n${logTail()}\n\`\`\``) + footer;
    const rv = await gh('POST', `/repos/${repo}/pulls/${job.number}/reviews`, { event: 'COMMENT', body: clip(body, 60000) + `\n${MARK}` });
    job.resultUrl = rv.html_url || job.url;
    job.result = verdict === 'approve' ? 'review posted · approved'
      : verdict === 'changes_requested' ? (willAutoFix ? 'review posted · changes requested → auto-fix queued' : 'review posted · changes requested')
        : 'review posted';
    await removeWorktree(local, wt);
    if (willAutoFix) return { followUp: queue.buildFixFollowUp(job, summary) };
    return;
  }

  // Commit whatever the agent left uncommitted.
  step(job, 'Committing');
  if ((await git(wdir, ['status', '--porcelain'])).stdout.trim()) {
    await must(git(wdir, ['add', '-A']), 'git add');
    const id = await identity(wdir);
    const msg = job.number ? `${job.kind === 'fix_issue' ? 'Fix' : 'Update'} #${job.number}: ${job.title}` : (job.ruleName || 'Automated change');
    await must(git(wdir, [...id, 'commit', '-m', msg, '-m', `Automated by Agent Hub (${a.label}).`]), 'git commit');
  }
  const ahead = Number((await git(wdir, ['rev-list', '--count', `${startSha}..HEAD`])).stdout.trim() || 0);
  if (!ahead) {
    if (item) await comment(repo, job.number, `🤖 **Agent Hub** — ${a.label} finished without changing any code.\n\n${summary || logTail()}${footer}`);
    job.resultUrl = job.url; job.result = 'no changes';
    await removeWorktree(local, wt, branch);
    return;
  }

  step(job, 'Pushing');
  const headSha = (await git(wdir, ['rev-parse', 'HEAD'])).stdout.trim();
  if (job.kind === 'pr_task') {
    await must(git(wdir, ['push', 'origin', `HEAD:refs/heads/${pr.head.ref}`], 5 * 60 * 1000), 'git push');
    const rev = job.autoReview ? queue.effectiveReviewer(job.workerAgent || job.agent, job.workerModel ?? job.model, job.reviewAgent, job.reviewModel) : null;
    const revNote = rev ? ` Auto-review queued with ${HEADLESS[rev.agent]?.label || rev.agent}.` : '';
    const c = await comment(repo, job.number, `🤖 **Agent Hub** — pushed ${ahead} commit${ahead > 1 ? 's' : ''} to \`${pr.head.ref}\`.${revNote}\n\n${summary || '(no summary)'}${footer}`);
    job.resultUrl = c.html_url;
    job.result = `pushed ${ahead} commit(s)${job.autoReview ? ' → auto-review queued' : ''}`;
    if (job.autoReview) queue.markPrReviewed(repo, job.number, headSha);
    await removeWorktree(local, wt);
    if (job.autoReview) return { followUp: queue.buildReviewFollowUp(job, job.number, job.title) };
    return;
  }

  await must(git(wdir, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], 5 * 60 * 1000), 'git push');
  step(job, 'Opening the pull request');
  const title = job.number ? `Fix #${job.number}: ${job.title}` : (job.ruleName || 'Automated change');
  const body = `${job.number ? `Closes #${job.number}\n\n` : ''}${summary || '(no summary)'}${footer}\n${MARK}`;
  const mk = (draft) => gh('POST', `/repos/${repo}/pulls`, { title: clip(title, 250), head: branch, base: meta.default_branch, body: clip(body, 60000), draft });
  let newPr;
  try { newPr = await mk(job.draft); } catch (e) { if (job.draft && e.status === 422) newPr = await mk(false); else throw e; } // drafts aren't available on every plan
  job.resultUrl = newPr.html_url;
  const rev = job.autoReview ? queue.effectiveReviewer(job.workerAgent || job.agent, job.workerModel ?? job.model, job.reviewAgent, job.reviewModel) : null;
  job.result = `opened PR #${newPr.number}${job.autoReview ? ' → auto-review queued' : ''}`;
  if (job.autoReview) queue.markPrReviewed(repo, newPr.number, newPr.head?.sha || headSha);
  if (item) {
    const revNote = rev ? ` (auto-review queued with ${HEADLESS[rev.agent]?.label || rev.agent})` : '';
    await comment(repo, job.number, `🤖 **Agent Hub** — opened ${newPr.html_url}${revNote}${footer}`).catch(() => {});
  }
  // Keep the worktree: you can continue the work from the Workspace list. Remove it there when you're done.
  if (job.autoReview) return { followUp: queue.buildReviewFollowUp(job, newPr.number, newPr.title || title) };
}

// A failed run that changed nothing leaves nothing worth keeping.
async function cleanupIfEmpty(j) {
  if (!j.wt || !j.local || !j.startSha) return;
  const wdir = store.ctx.wtDir(j.local, j.wt);
  if (!fs.existsSync(wdir)) return;
  const dirty = (await git(wdir, ['status', '--porcelain'])).stdout.trim();
  const head = (await git(wdir, ['rev-parse', 'HEAD'])).stdout.trim();
  if (dirty || head !== j.startSha) return;
  await removeWorktree(j.local, j.wt, j.branch);
  j.error = (j.error || '').replace(' The worktree was kept.', '');
}

async function identity(dir) {
  if ((await git(dir, ['config', 'user.email'])).stdout.trim()) return [];
  const u = await whoami().catch(() => null);
  return u ? ['-c', `user.name=${u.name || u.login}`, '-c', `user.email=${u.id}+${u.login}@users.noreply.github.com`]
    : ['-c', 'user.name=Agent Hub', '-c', 'user.email=agent-hub@localhost'];
}
function removeWorktree(local, wt, branch) {
  return withLock(`repo:${local}`, async () => {
    const ldir = store.ctx.repoDir(local);
    await git(ldir, ['worktree', 'remove', '--force', store.ctx.wtDir(local, wt)]);
    await git(ldir, ['worktree', 'prune']);
    if (branch) await git(ldir, ['branch', '-D', branch]);
  });
}

Object.assign(module.exports, { git, must, ensureClone, prepareCheckout, runJob, cleanupIfEmpty, identity, removeWorktree });
