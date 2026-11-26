'use strict';
const express = require('express');
const http = require('http');
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
const preview = require('./preview');
const tmuxfmt = require('./tmuxfmt');
const { wrap, notFound } = require('./errors');

const PORT = parseInt(process.env.PORT || '7681', 10);
const WORKSPACE = process.env.WORKSPACE || '/workspace';
const HOME = process.env.HOME || '/home/dev';
const HUB_DIR = path.join(HOME, '.agent-hub');
const SESSION_STATE_FILE = path.join(HUB_DIR, 'sessions.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
// Dev-server previews run on their own port, which the browser treats as a separate origin (see preview.js).
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT ?? '7682', 10) || 0;
const PREVIEW_PUBLIC_PORT = parseInt(process.env.PREVIEW_PUBLIC_PORT || '', 10) || PREVIEW_PORT;
const PREVIEW_PUBLIC_URL = String(process.env.PREVIEW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
// Legacy mode: serve /preview/ on the main port. Previewed pages then share Agent Hub's origin and can use its API.
const PREVIEW_SAME_ORIGIN = process.env.PREVIEW_SAME_ORIGIN === 'true' || !PREVIEW_PORT;
const PREVIEW_HANDOFF_MS = 2 * 60 * 1000;
const PREVIEW_COOKIE_MS = 12 * 60 * 60 * 1000;
// Set TRUST_PROXY=true when Agent Hub sits behind a reverse proxy (e.g. Tailscale/docktail) that sets X-Forwarded-For.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

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

// Preview tokens have 4 parts ("pt"/"pc" prefix), so they can never pass as a session token and vice versa.
// pt = one-time-ish handoff in a preview link (2 min), pc = the preview server's own cookie (12 h).
function makePreviewToken(kind) {
  const exp = String(Date.now() + (kind === 'pt' ? PREVIEW_HANDOFF_MS : PREVIEW_COOKIE_MS));
  const payload = `${kind}.${exp}.${crypto.randomBytes(9).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}
function validPreviewToken(tok, kind) {
  if (!tok || typeof tok !== 'string') return false;
  const parts = tok.split('.');
  if (parts.length !== 4 || parts[0] !== kind || !parts[2] || Number(parts[1]) < Date.now()) return false;
  const a = Buffer.from(parts[3]), b = Buffer.from(sign(parts.slice(0, 3).join('.')));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
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

// Browsers always send Origin on cross-origin and on non-GET requests. Rejecting a mismatch blocks CSRF,
// including from previewed dev servers, which are same-site (same host, other port) but not same-origin.
function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (origin) {
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1]; // the entry added by the trusted proxy
  }
  return req.socket?.remoteAddress || 'unknown';
}

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
  const r = await run('tmux', tmuxfmt.listArgs(['session_name', 'session_created', 'session_attached', 'window_activity', '@agent', '@repo', '@label', '@wt']));
  if (!r.ok) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const [name, created, attached, activity, agent, repo, label, wt] = tmuxfmt.parseLine(l);
    return { name, created: Number(created) * 1000, attached: Number(attached), activity: Number(activity) * 1000, agent, repo, label, wt: wt || '' };
  });
}

// ----------------------------------------------------------------- app ----
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Same-origin (legacy) previews manage their own framing & CSP; keep Agent Hub routes strict. frame-src allows
  // the separate preview origin to be shown in the Preview dialog's iframe.
  if (!req.path.startsWith('/preview/')) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com data: blob:; connect-src 'self' ws: wss:; frame-src 'self' http: https:; frame-ancestors 'none'; base-uri 'self'");
  }
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith('/preview/')) return next();
  if (req.path === '/api/upload') return express.json({ limit: '22mb' })(req, res, next);
  return express.json({ limit: '1mb' })(req, res, next);
});

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.use('/api', (req, res, next) => (
  ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || sameOriginRequest(req)
    ? next() : res.status(403).json({ error: 'cross-origin request blocked' })));

app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
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
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-hub' }, signal: AbortSignal.timeout(30000) });
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
  if (!fs.existsSync(dir)) throw notFound();
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
  envSource: envstore.sourceLine, excludedPorts: () => PREVIEW_EXCLUDED,
});
automations.register(app, wrap, {
  run, isBinInstalled, githubToken, WORKSPACE, WT_ROOT, SAFE_NAME, repoDir, wtDir, branchSlug, tmuxName,
  MODEL_RE: ollama.MODEL_RE, ollamaApplied: ollama.applied, envSource: envstore.sourceLine,
  onJobEnd: notify.jobEnded,
});
tools.register(app, wrap, { run });
notify.register(app, wrap, { run });

// ---- Authenticated Port Preview Proxy (/preview/:port/*), see preview.js ----
const PREVIEW_EXCLUDED = [PORT, PREVIEW_PORT].filter(Boolean);

function previewBase(req) {
  if (PREVIEW_PUBLIC_URL) return PREVIEW_PUBLIC_URL;
  let host = 'localhost';
  try { host = new URL(`http://${req.headers.host || 'localhost'}`).hostname; } catch {}
  return `http://${host}:${PREVIEW_PUBLIC_PORT}`;
}
function previewLink(req, port, rest = '/') {
  if (PREVIEW_SAME_ORIGIN) return `/preview/${port}${rest}`;
  const u = new URL(`${previewBase(req)}/preview/${port}${rest}`);
  u.searchParams.set('ah_pt', makePreviewToken('pt'));
  return u.toString();
}

app.get('/api/preview/link', wrap(async (req, res) => {
  const port = preview.validPort(req.query.port, PREVIEW_EXCLUDED);
  if (!port) throw new Error('Enter a port between 1024 and 65535 (not Agent Hub itself).');
  res.json({ url: previewLink(req, port), sameOrigin: PREVIEW_SAME_ORIGIN });
}));

app.use('/preview/:port', (req, res) => {
  if (!authed(req)) return res.status(401).send('Unauthorized — sign in to Agent Hub first.');
  const port = preview.validPort(req.params.port, PREVIEW_EXCLUDED);
  if (!port) return res.status(400).send('Invalid preview port (must be 1024-65535 and not Agent Hub itself).');
  // Old links / bookmarks: send them to the isolated preview server.
  if (!PREVIEW_SAME_ORIGIN) return res.redirect(302, previewLink(req, port, req.url || '/'));
  preview.proxyHttp(req, res, port, req.url || '/');
});

// URLs that CLIs tried to open via xdg-open/$BROWSER (see /usr/local/bin/hub-open)
const OPEN_LOGS = [path.join(HUB_DIR, 'open.log'), '/tmp/agent-hub/open.log'];
function readOpenLog(file) {
  let lines;
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
    if (!fs.existsSync(cwd)) throw notFound(wt ? 'worktree not found' : 'repo not found');
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
  // Saved API keys come from ~/.agent-hub/env.sh (mode 600) rather than the command line, where `ps` would show them.
  // Keep the pane alive after the agent exits so output isn't lost.
  const script = `${envstore.sourceLine()}; ${cmd}; code=$?; echo; echo "[${label} exited with code $code - dropping to shell]"; exec bash -l`;
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
  if (!authed(req) || !sameOriginRequest(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
  }
  // WebSocket tunnel for /preview/:port/* (legacy same-origin mode only)
  const pm = PREVIEW_SAME_ORIGIN && preview.parsePreviewPath(url.pathname);
  if (pm) {
    const port = preview.validPort(pm.port, PREVIEW_EXCLUDED);
    if (!port) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    return preview.proxyUpgrade(req, socket, head, port, pm.rest + url.search);
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

// ------------------------------------------------------------- startup ----
// `node server.js` starts listening. Tests require() this file instead and call start()/stop() themselves.
let previewServer = null;
let shuttingDown = false;

function start({ port = PORT, previewPort = PREVIEW_PORT, host = '0.0.0.0', handleSignals = true } = {}) {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  if (handleSignals) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (e) => console.error('[agent-hub] unhandled rejection:', e?.stack || e));
  }
  const listening = [new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`[agent-hub] listening on :${server.address().port}, workspace ${WORKSPACE}`);
      resolve();
    });
  })];
  if (!PREVIEW_SAME_ORIGIN) {
    previewServer = preview.createPreviewServer({
      excludedPorts: PREVIEW_EXCLUDED,
      parseCookies: cookies,
      isAuthed: (c) => validToken(c.ah_session) || validPreviewToken(c.ah_preview, 'pc'),
      checkHandoff: (t) => validPreviewToken(t, 'pt'),
      makeCookie: () => makePreviewToken('pc'),
      cookieTtlSec: PREVIEW_COOKIE_MS / 1000,
    });
    previewServer.on('error', (e) => console.error(`[agent-hub] preview server on :${previewPort} failed: ${e.message}`));
    listening.push(new Promise((resolve) => previewServer.listen(previewPort, host, () => {
      console.log(`[agent-hub] dev-server previews on :${previewServer.address().port} (published as ${PREVIEW_PUBLIC_URL || ':' + PREVIEW_PUBLIC_PORT})`);
      resolve();
    })));
  }
  return Promise.all(listening).then(() => ({ port: server.address().port, previewPort: previewServer?.address()?.port || 0 }));
}

// Close terminals and both servers. Resolves once they have stopped accepting connections.
function stop() {
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server restarting'); } catch {}
  }
  wss.close(() => {});
  const closing = [new Promise((r) => server.close(() => r()))];
  if (previewServer) closing.push(new Promise((r) => previewServer.close(() => r())));
  server.closeAllConnections?.();
  previewServer?.closeAllConnections?.();
  return Promise.all(closing);
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[agent-hub] received ${sig}, shutting down…`);
  stop().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

if (require.main === module) {
  start().catch((e) => { console.error(`[agent-hub] failed to start: ${e.message}`); process.exit(1); });
}

module.exports = { app, server, start, stop };
