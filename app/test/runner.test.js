'use strict';
// End-to-end test of the automation job runner: a real git "origin", a real tmux server, a fake GitHub API and a
// stand-in `claude` agent. Covers the two main paths: fix an issue → push a branch → open a PR, and review a PR.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Everything lives in one temp dir, set up before the automations modules load (they read HOME at load time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-runner-'));
const HOME = path.join(TMP, 'home');
const WORKSPACE = path.join(TMP, 'workspace');
const REMOTES = path.join(TMP, 'remotes');
const BIN = path.join(TMP, 'bin');
for (const d of [HOME, WORKSPACE, REMOTES, BIN, path.join(TMP, 'tmux')]) fs.mkdirSync(d, { recursive: true });
const GITCONFIG = path.join(TMP, 'gitconfig');
fs.writeFileSync(GITCONFIG, [
  '[user]', '  name = Test', '  email = test@example.com',
  '[init]', '  defaultBranch = main',
  '[safe]', '  directory = *',
  // https://github.com/octo/demo(.git) is served from a local bare repo.
  `[url "file://${REMOTES}/"]`, '  insteadOf = https://github.com/',
].join('\n') + '\n');
Object.assign(process.env, { HOME, GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', TMUX_TMPDIR: path.join(TMP, 'tmux') });

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// The stand-in agent: reviews when asked to review, otherwise edits README.md. Either way it writes its summary to
// the output file named in the prompt, like a real agent following the prompt's rules.
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/bash
for a; do P="$a"; done
out="$(printf '%s' "$P" | grep -o '/[^ ]*/output.md' | head -1)"
echo "fake claude in $(pwd)"
if printf '%s' "$P" | grep -q '^TASK: Review'; then
  printf 'Looks fine.\\n\\nVERDICT: APPROVE\\n' > "$out"
else
  echo "fixed by agent" >> README.md
  printf 'Appended a line to README.md.\\n' > "$out"
fi
`, { mode: 0o755 });

// Fake GitHub API: records what Agent Hub posts.
const posted = { comments: [], pulls: [], reviews: [] };
let originSha = '';
const ghServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && u === '/repos/octo/demo') return send(200, { full_name: 'octo/demo', default_branch: 'main' });
    if (req.method === 'GET' && u === '/repos/octo/demo/issues/7') return send(200, { number: 7, title: 'Add a line', body: 'Please add a line.', html_url: 'https://github.com/octo/demo/issues/7', user: { login: 'alice' } });
    if (req.method === 'GET' && u === '/repos/octo/demo/issues/8') return send(200, { number: 8, title: 'Some PR', body: 'A change.', html_url: 'https://github.com/octo/demo/pull/8', user: { login: 'bob' }, pull_request: {} });
    if (req.method === 'GET' && u === '/repos/octo/demo/pulls/8') return send(200, { number: 8, head: { ref: 'feature', sha: originSha, repo: { full_name: 'octo/demo' } }, base: { ref: 'main' } });
    if (req.method === 'GET' && /\/comments$|\/reviews$/.test(u)) return send(200, []);
    if (req.method === 'POST' && /^\/repos\/octo\/demo\/issues\/\d+\/comments$/.test(u)) { posted.comments.push(body.body); return send(201, { html_url: `https://github.com/octo/demo/issues/x#c${posted.comments.length}` }); }
    if (req.method === 'POST' && u === '/repos/octo/demo/pulls') { posted.pulls.push(body); return send(201, { number: 9, html_url: 'https://github.com/octo/demo/pull/9', title: body.title, head: { sha: 'abc' } }); }
    if (req.method === 'POST' && u === '/repos/octo/demo/pulls/8/reviews') { posted.reviews.push(body); return send(200, { html_url: 'https://github.com/octo/demo/pull/8#review' }); }
    send(404, { message: `fake GitHub has no ${req.method} ${u}` });
  });
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 30000, cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

let store, queue;
test.before(async () => {
  if (!hasTmux) return;
  await new Promise((r) => ghServer.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API_URL = `http://127.0.0.1:${ghServer.address().port}`;

  // origin with one commit on main, plus a PR branch exposed as refs/pull/8/head like GitHub does
  const seed = path.join(TMP, 'seed');
  fs.mkdirSync(seed);
  git(['init', '-q'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo\n');
  git(['add', '.'], seed); git(['commit', '-qm', 'init'], seed);
  git(['checkout', '-qb', 'feature'], seed);
  fs.writeFileSync(path.join(seed, 'feature.txt'), 'feature\n');
  git(['add', '.'], seed); git(['commit', '-qm', 'feature'], seed);
  originSha = git(['rev-parse', 'HEAD'], seed);
  fs.mkdirSync(path.join(REMOTES, 'octo'));
  git(['clone', '-q', '--bare', seed, path.join(REMOTES, 'octo', 'demo.git')]);
  git(['update-ref', 'refs/pull/8/head', originSha], path.join(REMOTES, 'octo', 'demo.git'));
  // The workspace already has a clone (remote URL looks like GitHub; insteadOf serves it locally).
  git(['clone', '-q', 'https://github.com/octo/demo.git', path.join(WORKSPACE, 'demo')]);

  store = require('../automations/store');
  queue = require('../automations/queue');
  const routes = require('../automations/routes');
  const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
  const WT_ROOT = path.join(WORKSPACE, '.worktrees');
  const repoDir = (n) => path.join(WORKSPACE, n);
  routes.register({ get() {}, post() {}, delete() {} }, (fn) => fn, {
    run, githubToken: async () => 'test-token', isBinInstalled: () => true,
    WORKSPACE, WT_ROOT, SAFE_NAME, repoDir,
    wtDir: (r, wt) => path.join(WT_ROOT, r, wt),
    branchSlug: (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80),
    tmuxName: (s) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60),
    envSource: () => `export PATH=${BIN}:$PATH`, // the run script's hook for saved env vars: put the fake agent first
  });
  store.data.settings = { ...store.data.settings, loopLimit: 0, paused: true }; // plain agent command; no GitHub polling
});

test.after(async () => {
  if (!hasTmux) return;
  await run('tmux', ['kill-server']);
  ghServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function waitForJob(id, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = store.jobs.find((x) => x.id === id);
    if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    if (Date.now() > end) throw new Error(`job ${id} still ${j?.status}/${j?.step} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const spec = (kind, number) => ({
  source: 'rule', ruleId: `test-${kind}`, ruleName: 'Test rule', repo: 'octo/demo', agent: 'claude', kind, number,
  trigger: 'test', draft: true,
});

test('fix_issue job: agent edits, Agent Hub commits, pushes a branch and opens a PR that closes the issue', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const job = queue.enqueueJob(spec('fix_issue', 7));
  assert.ok(job, 'job was queued');
  const done = await waitForJob(job.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.match(done.result, /^opened PR #9/);

  assert.equal(posted.pulls.length, 1);
  const pr = posted.pulls[0];
  assert.equal(pr.base, 'main');
  assert.match(pr.head, /^agent-hub\/issue-7-[0-9a-f]{4}$/);
  assert.equal(pr.draft, true);
  assert.match(pr.body, /^Closes #7/);
  assert.match(pr.body, /Appended a line to README\.md\./);
  assert.match(pr.body, /<!-- agent-hub -->/);

  // The branch really reached origin, with the agent's change committed.
  const bare = path.join(REMOTES, 'octo', 'demo.git');
  const readme = git(['show', `${pr.head}:README.md`], bare);
  assert.match(readme, /fixed by agent/);
  assert.match(git(['log', '-1', '--format=%s', pr.head], bare), /^Fix #7: Add a line/);

  assert.ok(posted.comments.some((c) => /is working on this/.test(c)), 'announced on the issue');
  assert.ok(posted.comments.some((c) => /opened https:\/\/github\.com\/octo\/demo\/pull\/9/.test(c)), 'linked the PR');
  assert.ok(fs.existsSync(done.wtPath), 'fix worktrees are kept so you can continue the work');
  assert.ok(fs.readFileSync(path.join(store.JOBS_DIR, job.id, 'prompt.md'), 'utf8').includes('Resolve GitHub issue #7'));
});

test('review job: agent reviews the PR head, Agent Hub posts the review with its verdict and removes the worktree', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const job = queue.enqueueJob(spec('review', 8));
  const done = await waitForJob(job.id);
  assert.equal(done.status, 'succeeded', done.error);
  assert.equal(done.verdict, 'approve');
  assert.equal(done.result, 'review posted · approved');
  assert.equal(posted.reviews.length, 1);
  assert.equal(posted.reviews[0].event, 'COMMENT');
  assert.match(posted.reviews[0].body, /VERDICT: APPROVE/);
  assert.ok(!fs.existsSync(done.wtPath), 'review worktrees are removed');
  // The review ran on the PR head commit.
  assert.match(fs.readFileSync(path.join(store.JOBS_DIR, job.id, 'log.txt'), 'utf8'), /fake claude in .*review-8-/);
});
