'use strict';
const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { AGENTS, LOGINS } = require('./agents');
const ollama = require('./ollama');
const automations = require('./automations');
const tools = require('./tools');
const notify = require('./notify');
const modeltest = require('./modeltest');
const envstore = require('./envstore');
const workspaceMod = require('./workspace');

const PORT = parseInt(process.env.PORT || '7681', 10);
const WORKSPACE = process.env.WORKSPACE || '/workspace';
const HOME = process.env.HOME || '/home/dev';
const HUB_DIR = path.join(HOME, '.agent-hub');
const SESSION_STATE_FILE = path.join(HUB_DIR, 'sessions.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------- auth ----
let PASSWORD = process.env.UI_PASSWORD || '';
if (!PASSWORD) {
  PASSWORD = crypto.randomBytes(12).toString('base64url');
  console.warn(`\n[agent-hub] UI_PASSWORD not set. Generated password for this run: ${PASSWORD}\n`);
}

let sessionState = { key: '', revoked: {} };
function loadSessionState() {
  try {
    const d = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf8'));
    if (d && typeof d.key === 'string' && d.key.length >= 32) {
      sessionState = { key: d.key, revoked: d.revoked && typeof d.revoked === 'object' ? d.revoked : {} };
      return;
    }
  } catch {}
  sessionState = { key: crypto.randomBytes(32).toString('hex'), revoked: {} };
  saveSessionState();
}
function saveSessionState() {
  const now = Date.now();
  for (const [jti, exp] of Object.entries(sessionState.revoked)) {
    if (Number(exp) < now) delete sessionState.revoked[jti];
  }
  fs.mkdirSync(HUB_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SESSION_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessionState, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SESSION_STATE_FILE);
}
loadSessionState();

// Signed session cookie backed by both PASSWORD and a persisted key so sessions survive restarts
// while still supporting individual or global revocation on logout.
const secretKey = () => crypto.createHash('sha256').update(`agent-hub:${PASSWORD}:${sessionState.key}`).digest();
const sign = (v) => crypto.createHmac('sha256', secretKey()).update(v).digest('base64url');
const makeToken = () => {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const jti = crypto.randomBytes(12).toString('hex');
  const payload = `${exp}.${jti}`;
  return `${payload}.${sign(payload)}`;
};
function parseToken(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 3) return null;
  const [exp, jti, sig] = parts;
  if (!exp || !jti || !sig || Number(exp) < Date.now()) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(`${exp}.${jti}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (sessionState.revoked[jti]) return null;
  return { exp: Number(exp), jti };
}
const validToken = (tok) => !!parseToken(tok);
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) {
      try { out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } catch {}
    }
  });
  return out;
}
const authed = (req) => validToken(cookies(req).ah_session);

const loginFailures = new Map(); // ip -> [timestamps]
function loginRateCheck(ip) {
  const now = Date.now();
  if (loginFailures.size > 1000) {
    for (const [k, list] of loginFailures) {
      const kept = list.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (kept.length) loginFailures.set(k, kept); else loginFailures.delete(k);
    }
  }
  const list = (loginFailures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length) loginFailures.set(ip, list); else loginFailures.delete(ip);
  if (list.length >= LOGIN_MAX_ATTEMPTS) {
    const retrySec = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - list[0])) / 1000));
    return { allowed: false, retrySec };
  }
  return { allowed: true, retrySec: 0 };
}
function recordLoginFailure(ip) {
  const now = Date.now();
  const list = (loginFailures.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  list.push(now);
  loginFailures.set(ip, list);
}

// ------------------------------------------------------------- helpers ----
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 30000, maxBuffer: 20 * 1024 * 1024, cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
function isBinInstalled(bin) {
  if (!bin || !SAFE_NAME.test(bin)) return false;
  const dirs = new Set([
    path.join(HOME, '.local', 'tools', 'bin'),
    path.join(HOME, '.local', 'bin'),
    '/opt/tools/npm/bin',
    '/opt/tools/bin',
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ]);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
function repoDir(name) {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') throw new Error('invalid repo name');
  return path.join(WORKSPACE, name);
}
// Worktrees live in a hidden folder so they don't show up as separate repos.
const WT_ROOT = path.join(WORKSPACE, '.worktrees');
function wtDir(repo, wt) {
  repoDir(repo);
  if (!SAFE_NAME.test(wt) || wt === '.' || wt === '..') throw new Error('invalid worktree name');
  return path.join(WT_ROOT, repo, wt);
}
const targetDir = (repo, wt) => (wt ? wtDir(repo, wt) : repoDir(repo));
const branchSlug = (b) => b.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);

async function validBranch(dir, b) {
  if (!b || b.startsWith('-') || b.length > 200) return false;
  return (await run('git', ['-C', dir, 'check-ref-format', '--branch', b])).ok;
}

async function listWorktrees(repo) {
  const dir = repoDir(repo);
  const r = await run('git', ['-C', dir, 'worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const base = path.join(WT_ROOT, repo) + path.sep;
  const blocks = r.stdout.split('\n\n').map((b) => Object.fromEntries(b.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf(' '); return i < 0 ? [l, true] : [l.slice(0, i), l.slice(i + 1)];
  })));
  const mainBranch = (await run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  return Promise.all(blocks.filter((b) => b.worktree && b.worktree.startsWith(base)).map(async (b) => {
    const wdir = b.worktree;
    const branch = b.branch ? b.branch.replace(/^refs\/heads\//, '') : '(detached)';
    if (b.prunable || !fs.existsSync(wdir)) return { name: path.basename(wdir), branch, missing: true };
    const [st, ahead, up] = await Promise.all([
      run('git', ['-C', wdir, 'status', '--porcelain']),
      mainBranch ? run('git', ['-C', wdir, 'rev-list', '--count', `${mainBranch}..HEAD`]) : Promise.resolve({ ok: false }),
      run('git', ['-C', wdir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    ]);
    return {
      name: path.basename(wdir), branch,
      dirty: st.stdout.split('\n').filter(Boolean).length,
      aheadOfMain: ahead.ok ? Number(ahead.stdout.trim()) : 0,
      mainBranch, pushed: up.ok,
    };
  }));
}

async function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = await run('gh', ['auth', 'token']);
  return r.ok ? r.stdout.trim() : '';
}

const tmuxName = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
async function tmuxSessions() {
  const fmt = '#{session_name}\t#{session_created}\t#{session_attached}\t#{window_activity}\t#{@agent}\t#{@repo}\t#{@label}\t#{@wt}';
  const r = await run('tmux', ['list-sessions', '-F', fmt]);
  if (!r.ok) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [name, created, attached, activity, agent, repo, label, wt] = l.split('\t');
    return { name, created: Number(created) * 1000, attached: Number(attached), activity: Number(activity) * 1000, agent, repo, label, wt: wt || '' };
  });
}

// ----------------------------------------------------------------- app ----
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Proxied dev-server previews manage their own framing & CSP; keep Agent Hub routes strict.
  if (!req.path.startsWith('/preview/')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com data: blob:; connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  }
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith('/preview/')) return next();
  if (req.path === '/api/upload') return express.json({ limit: '22mb' })(req, res, next);
  return express.json({ limit: '1mb' })(req, res, next);
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.post('/api/login', (req, res) => {
  const ip = req.socket?.remoteAddress || 'unknown';
  const rate = loginRateCheck(ip);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retrySec));
    return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${Math.ceil(rate.retrySec / 60)} min.` });
  }
  const pw = String(req.body?.password || '');
  const a = crypto.createHash('sha256').update(pw).digest(), b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    recordLoginFailure(ip);
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 600);
  }
  loginFailures.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `ah_session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const parsed = parseToken(cookies(req).ah_session);
  if (parsed) {
    if (req.body?.all) {
      sessionState = { key: crypto.randomBytes(32).toString('hex'), revoked: {} };
    } else {
      sessionState.revoked[parsed.jti] = parsed.exp;
    }
    try { saveSessionState(); } catch {}
  }
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `ah_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ authed: authed(req) }));

app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'unauthorized' })));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: e.message }));

// CLI logins (Claude, OpenCode, ...) send the browser back to http://localhost:<port>/callback?code=...
// That only exists inside this container, so the user pastes that address here and we deliver it locally.
app.post('/api/oauth-callback', wrap(async (req, res) => {
  let u;
  try { u = new URL(String(req.body?.url || '').trim()); } catch { throw new Error('Paste the full address from the browser bar (it starts with http://localhost:)'); }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('That is not a localhost address. Paste the address of the page that failed to load.');
  const port = Number(u.port);
  if (!port || port < 1024 || port === Number(process.env.PORT || 7681)) throw new Error('That address has no CLI port in it');
  let last = '';
  for (const host of ['127.0.0.1', '[::1]']) {
    try {
      const r = await fetch(`http://${host}:${port}${u.pathname}${u.search}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const body = (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      return res.json({ ok: r.status < 400, status: r.status, message: r.status < 400 ? 'Delivered. Check the login terminal: it should say you are signed in.' : `The CLI answered HTTP ${r.status}: ${body}` });
    } catch (e) { last = e.cause?.code || e.message; }
  }
  throw new Error(`Nothing is waiting on port ${port} (${last}). The login may have timed out or been closed: start it again and paste the new address.`);
}));

app.get('/api/status', wrap(async (req, res) => {
  const agents = Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, { label: a.label, installed: isBinInstalled(a.bin), yolo: !!a.yolo }]));
  const token = await githubToken();
  let github = { connected: false };
  if (token) {
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'agent-hub' }, signal: AbortSignal.timeout(15000) });
    if (r.ok) { const u = await r.json(); github = { connected: true, login: u.login, avatar: u.avatar_url, source: process.env.GH_TOKEN || process.env.GITHUB_TOKEN ? 'token' : 'gh' }; }
  }
  res.json({ agents, github, logins: Object.fromEntries(Object.entries(LOGINS).map(([k, v]) => [k, v.label])) });
}));

// Local repositories in the workspace
app.get('/api/repos/local', wrap(async (req, res) => {
  const entries = fs.existsSync(WORKSPACE) ? fs.readdirSync(WORKSPACE, { withFileTypes: true }) : [];
  const dirs = entries.filter((e) => e.isDirectory() && SAFE_NAME.test(e.name) && !e.name.startsWith('.'));
  const repos = await mapLimit(dirs, 4, async (e) => {
    const dir = path.join(WORKSPACE, e.name);
    const isGit = fs.existsSync(path.join(dir, '.git'));
    if (!isGit) return { name: e.name, git: false };
    const [br, st, rem, ab] = await Promise.all([
      run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']),
      run('git', ['-C', dir, 'status', '--porcelain']),
      run('git', ['-C', dir, 'remote', 'get-url', 'origin']),
      run('git', ['-C', dir, 'rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    ]);
    const [behind, ahead] = ab.ok ? ab.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    const worktrees = await listWorktrees(e.name).catch(() => []);
    return { name: e.name, git: true, branch: br.stdout.trim(), dirty: st.stdout.split('\n').filter(Boolean).length, remote: rem.stdout.trim(), ahead, behind, worktrees };
  });
  repos.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ repos });
}));

// GitHub repositories for the connected account
app.get('/api/repos/github', wrap(async (req, res) => {
  const token = await githubToken();
  if (!token) return res.status(400).json({ error: 'GitHub is not connected' });
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-hub' } });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    const batch = await r.json();
    all.push(...batch.map((x) => ({ full_name: x.full_name, name: x.name, private: x.private, description: x.description, updated_at: x.updated_at, default_branch: x.default_branch, fork: x.fork, archived: x.archived })));
    if (batch.length < 100) break;
  }
  res.json({ repos: all });
}));

app.post('/api/repos/clone', wrap(async (req, res) => {
  const full = String(req.body?.full_name || '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full)) throw new Error('invalid repository');
  let [owner, name] = full.split('/');
  let target = repoDir(name);
  if (fs.existsSync(target)) target = repoDir(`${owner}__${name}`);
  if (fs.existsSync(target)) throw new Error(`${path.basename(target)} already exists in workspace`);
  const token = await githubToken();
  const r = await run('gh', ['repo', 'clone', full, target], { timeout: 15 * 60 * 1000, env: token ? { GH_TOKEN: token } : {} });
  if (!r.ok) throw new Error((r.stderr || r.stdout).trim() || 'clone failed');
  res.json({ ok: true, name: path.basename(target) });
}));

app.post('/api/repos/create', wrap(async (req, res) => {
  const name = String(req.body?.name || '');
  const dir = repoDir(name);
  if (fs.existsSync(dir)) throw new Error('already exists');
  fs.mkdirSync(dir);
  await run('git', ['-C', dir, 'init']);
  if (req.body?.github) {
    const vis = req.body.private === false ? '--public' : '--private';
    const r = await run('gh', ['repo', 'create', name, vis, '--source', dir, '--remote', 'origin']);
    if (!r.ok) throw new Error((r.stderr || r.stdout).trim());
  }
  res.json({ ok: true, name });
}));

app.post('/api/repos/:name/git', wrap(async (req, res) => {
  const wt = req.body?.wt ? String(req.body.wt) : '';
  const dir = targetDir(req.params.name, wt);
  if (!fs.existsSync(dir)) throw new Error('not found');
  const op = req.body?.op;
  const ops = {
    pull: ['git', ['pull', '--ff-only']],
    fetch: ['git', ['fetch', '--all', '--prune']],
    status: ['git', ['status', '-sb']],
    log: ['git', ['log', '--oneline', '-n', '20', '--decorate']],
    diff: ['git', ['diff', '--stat', 'HEAD']],
    push: ['git', ['push', '-u', 'origin', 'HEAD']],
    pr: ['gh', ['pr', 'create', '--fill']],
  };
  if (!ops[op]) throw new Error('unknown op');
  const [bin, args] = ops[op];
  const r = await run(bin, bin === 'git' ? ['-C', dir, ...args] : args, { cwd: dir, timeout: 5 * 60 * 1000 });
  res.json({ ok: r.ok, output: (r.stdout + r.stderr).trim() });
}));

// ---- git worktrees: parallel checkouts of one repo, one branch each ----
app.post('/api/repos/:name/worktrees', wrap(async (req, res) => {
  const repo = req.params.name, dir = repoDir(repo);
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('not a git repository');
  const branch = String(req.body?.branch || '').trim();
  const from = String(req.body?.base || '').trim();
  if (!(await validBranch(dir, branch))) throw new Error(`"${branch}" is not a valid branch name`);
  const slug = branchSlug(branch);
  if (!slug) throw new Error('invalid branch name');
  const wdir = wtDir(repo, slug);
  if (fs.existsSync(wdir)) throw new Error(`a worktree for ${branch} already exists`);
  fs.mkdirSync(path.dirname(wdir), { recursive: true });

  const local = (await run('git', ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
  const remote = !local && (await run('git', ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).ok;
  let args;
  if (local || remote) {
    args = ['worktree', 'add', wdir, branch]; // remote-only: git creates a tracking branch
  } else {
    if (from && (from.startsWith('-') || !(await run('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${from}^{commit}`])).ok)) throw new Error(`base "${from}" not found`);
    args = ['worktree', 'add', '-b', branch, wdir, from || 'HEAD'];
  }
  const r = await run('git', ['-C', dir, ...args], { timeout: 5 * 60 * 1000 });
  if (!r.ok) throw new Error((r.stderr || r.stdout).trim());
  res.json({ ok: true, name: slug, branch, created: !(local || remote) });
}));

app.delete('/api/repos/:name/worktrees/:wt', wrap(async (req, res) => {
  const repo = req.params.name, dir = repoDir(repo), wdir = wtDir(repo, req.params.wt);
  const { force, deleteBranch } = req.body || {};
  const branch = fs.existsSync(wdir) ? (await run('git', ['-C', wdir, 'symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim() : '';
  const r = await run('git', ['-C', dir, 'worktree', 'remove', ...(force ? ['--force'] : []), wdir]);
  if (!r.ok && fs.existsSync(wdir)) throw new Error((r.stderr || r.stdout).trim() + (force ? '' : '\n\nIt has uncommitted changes. Refresh and remove again to discard them.'));
  // Stop agents that were running inside it.
  for (const s of await tmuxSessions()) if (s.repo === repo && s.wt === req.params.wt) await run('tmux', ['kill-session', '-t', `=${s.name}`]);
  await run('git', ['-C', dir, 'worktree', 'prune']);
  let note = '';
  if (deleteBranch && branch) {
    const b = await run('git', ['-C', dir, 'branch', '-d', branch]);
    note = b.ok ? `Deleted branch ${branch}.` : `Kept branch ${branch}: ${(b.stderr || '').trim()}`;
  }
  res.json({ ok: true, note });
}));

app.delete('/api/repos/:name', wrap(async (req, res) => {
  const dir = repoDir(req.params.name);
  if (req.body?.confirm !== req.params.name) throw new Error('confirmation does not match');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(WT_ROOT, req.params.name), { recursive: true, force: true });
  res.json({ ok: true });
}));

ollama.register(app, wrap);
modeltest.register(app, wrap, {});
envstore.register(app, wrap, { repoDir });
workspaceMod.register(app, wrap, {
  run, targetDir, repoDir, wtDir, WT_ROOT, WORKSPACE, branchSlug, tmuxName, tmuxSessions,
  envOverrides: envstore.getEnvOverrides, PORT,
});
automations.register(app, wrap, {
  run, isBinInstalled, githubToken, WORKSPACE, WT_ROOT, SAFE_NAME, repoDir, wtDir, branchSlug, tmuxName,
  MODEL_RE: ollama.MODEL_RE, ollamaApplied: ollama.applied, envOverrides: envstore.getEnvOverrides,
  onJobEnd: notify.jobEnded,
});
tools.register(app, wrap, { run });
notify.register(app, wrap, { run });

// ---- Authenticated Port Preview Proxy (/preview/:port/*) ----
function validPreviewPort(raw) {
  const p = Number(raw);
  return Number.isInteger(p) && p >= 1024 && p <= 65535 && p !== PORT ? p : 0;
}

app.use('/preview/:port', (req, res) => {
  if (!authed(req)) return res.status(401).send('Unauthorized — sign in to Agent Hub first.');
  const port = validPreviewPort(req.params.port);
  if (!port) return res.status(400).send('Invalid preview port (must be 1024-65535 and not Agent Hub itself).');
  const upstreamPath = req.url || '/';
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers['content-security-policy'];
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: upstreamPath,
    method: req.method,
    headers,
  }, (proxyRes) => {
    const outHeaders = { ...proxyRes.headers };
    if (outHeaders.location && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(outHeaders.location)) {
      try {
        const u = new URL(outHeaders.location);
        if (Number(u.port) === port) outHeaders.location = `/preview/${port}${u.pathname}${u.search}${u.hash}`;
      } catch {}
    } else if (outHeaders.location && outHeaders.location.startsWith('/') && !outHeaders.location.startsWith(`/preview/${port}/`)) {
      outHeaders.location = `/preview/${port}${outHeaders.location}`;
    }
    res.writeHead(proxyRes.statusCode || 502, outHeaders);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).send(`Nothing is listening on container port ${port} (${err.code || err.message}).`);
  });
  req.pipe(proxyReq);
});

// URLs that CLIs tried to open via xdg-open/$BROWSER (see /usr/local/bin/hub-open)
const OPEN_LOGS = [path.join(HUB_DIR, 'open.log'), '/tmp/agent-hub/open.log'];
function readOpenLog(file) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  if (lines.length > 200) {
    try { fs.writeFileSync(file, lines.slice(-50).join('\n') + '\n', { mode: 0o600 }); } catch {}
  }
  return lines.slice(-20);
}
app.get('/api/open-urls', wrap(async (req, res) => {
  const since = Number(req.query.since || 0);
  const now = Date.now();
  const lines = OPEN_LOGS.flatMap(readOpenLog);
  const urls = lines.map((l) => { const i = l.indexOf('\t'); return { ts: Number(l.slice(0, i)), url: l.slice(i + 1) }; })
    .filter((u) => u.ts > since && /^https?:\/\//.test(u.url) && now - u.ts < 10 * 60 * 1000)
    .sort((a, b) => a.ts - b.ts);
  res.json({ now, urls });
}));

// tmux-backed sessions (survive browser disconnects and UI restarts)
app.get('/api/sessions', wrap(async (req, res) => res.json({ sessions: await tmuxSessions() })));

app.post('/api/sessions', wrap(async (req, res) => {
  const { kind = 'agent', agent, repo, yolo, model } = req.body || {};
  const wt = req.body?.wt ? String(req.body.wt) : '';
  let cmd, cwd, label, agentKey;
  if (kind === 'login') {
    const l = LOGINS[agent]; if (!l) throw new Error('unknown login');
    cmd = l.cmd; cwd = process.env.HOME; label = l.label; agentKey = `login-${agent}`;
  } else {
    const a = AGENTS[agent]; if (!a) throw new Error('unknown agent');
    if (wt && !repo) throw new Error('worktree needs a repo');
    cwd = repo ? targetDir(repo, wt) : WORKSPACE;
    if (!fs.existsSync(cwd)) throw new Error(wt ? 'worktree not found' : 'repo not found');
    cmd = yolo && a.yolo ? a.yolo : a.cmd;
    label = `${a.label}${yolo && a.yolo ? ' (yolo)' : ''}`; agentKey = agent;
    // Local Ollama or custom OpenAI-compatible provider model (validated: no quotes/spaces)
    if (model && ollama.OLLAMA_CLI_KEYS.includes(agent)) {
      if (!ollama.MODEL_RE.test(model)) throw new Error('invalid model');
      cmd = ollama.buildInteractiveCmd(agent, model, { yolo });
      label += ` · ${model}`;
    }
  }
  const existing = new Set((await tmuxSessions()).map((s) => s.name));
  const base = tmuxName(`${agentKey}-${repo || 'home'}${wt ? '-' + wt : ''}`);
  let name = base, i = 2;
  while (existing.has(name)) name = `${base}-${i++}`;
  const envExports = Object.entries(envstore.getEnvOverrides())
    .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`).join('; ');
  // Keep the pane alive after the agent exits so output isn't lost.
  const script = `${envExports ? envExports + '; ' : ''}${cmd}; code=$?; echo; echo "[${label} exited with code $code - dropping to shell]"; exec bash -l`;
  const r = await run('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '50', 'bash', '-lc', script]);
  if (!r.ok) throw new Error(r.stderr.trim() || 'tmux failed');
  await run('tmux', ['set-option', '-t', name, '@agent', agentKey]);
  await run('tmux', ['set-option', '-t', name, '@repo', repo || '']);
  await run('tmux', ['set-option', '-t', name, '@label', label]);
  await run('tmux', ['set-option', '-t', name, '@wt', wt]);
  res.json({ ok: true, name });
}));

app.delete('/api/sessions/:name', wrap(async (req, res) => {
  const r = await run('tmux', ['kill-session', '-t', `=${req.params.name}`]);
  res.json({ ok: r.ok });
}));

// static
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// ------------------------------------------------------------ terminal ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
  const origin = req.headers.origin;
  let sameOrigin = !origin;
  if (origin) {
    try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
  }
  if (!authed(req) || !sameOrigin) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
  }
  // WebSocket tunnel for /preview/:port/* (Vite / Next.js HMR / DSH web UI)
  const pm = url.pathname.match(/^\/preview\/(\d+)(\/.*)?$/);
  if (pm) {
    const port = validPreviewPort(pm[1]);
    if (!port) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    const targetPath = (pm[2] || '/') + url.search;
    const upstream = net.connect(port, '127.0.0.1', () => {
      const hdrs = [`${req.method} ${targetPath} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i], v = req.rawHeaders[i + 1];
        if (k.toLowerCase() === 'host') hdrs.push(`Host: 127.0.0.1:${port}`);
        else hdrs.push(`${k}: ${v}`);
      }
      upstream.write(hdrs.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => { try { socket.destroy(); } catch {} });
    socket.on('error', () => { try { upstream.destroy(); } catch {} });
    return;
  }
  if (url.pathname !== '/ws/term') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
});

wss.on('connection', async (ws, url) => {
  const name = url.searchParams.get('session') || '';
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    return ws.close(1008, 'invalid session');
  }
  const exists = (await run('tmux', ['has-session', '-t', `=${name}`])).ok;
  if (!exists || ws.readyState !== 1) {
    if (ws.readyState === 1) ws.close(1000, 'session not found');
    return;
  }
  const cols = Math.max(20, Math.min(500, parseInt(url.searchParams.get('cols') || '120', 10) || 120));
  const rows = Math.max(5, Math.min(200, parseInt(url.searchParams.get('rows') || '40', 10) || 40));
  const term = pty.spawn('tmux', ['attach-session', '-t', `=${name}`], {
    name: 'xterm-256color', cols, rows, cwd: HOME, env: { ...process.env, TERM: 'xterm-256color' },
  });
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(() => { if (ws.readyState === 1) ws.close(1000, 'session ended'); });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') term.write(m.d);
    else if (m.t === 'r') term.resize(Math.max(20, Math.min(500, m.c | 0)), Math.max(5, Math.min(200, m.r | 0)));
  });
  ws.on('close', () => { try { term.kill(); } catch {} });
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent-hub] received ${sig}, shutting down…`);
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server restarting'); } catch {}
  }
  wss.close(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

fs.mkdirSync(WORKSPACE, { recursive: true });
server.listen(PORT, '0.0.0.0', () => console.log(`[agent-hub] listening on :${PORT}, workspace ${WORKSPACE}`));
