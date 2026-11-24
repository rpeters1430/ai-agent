'use strict';
// In-process tests of server.js routes, against real git and an isolated tmux server.
// The environment is set up before server.js loads, because it reads HOME, WORKSPACE, UI_PASSWORD, ... at load time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-server-'));
const PASSWORD = crypto.randomBytes(12).toString('hex');
const GITCONFIG = path.join(TMP, 'gitconfig');
fs.writeFileSync(GITCONFIG, '[user]\n  name = Test\n  email = test@example.com\n[init]\n  defaultBranch = main\n');
fs.mkdirSync(path.join(TMP, 'home'));
fs.mkdirSync(path.join(TMP, 'tmux'));
Object.assign(process.env, {
  HOME: path.join(TMP, 'home'), WORKSPACE: path.join(TMP, 'workspace'), UI_PASSWORD: PASSWORD,
  TRUST_PROXY: 'true', // lets each test sign in from its own X-Forwarded-For "client", so rate limits don't collide
  GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', TMUX_TMPDIR: path.join(TMP, 'tmux'),
});
const WebSocket = require('ws');
const hub = require('../server');

let base = '', origin = '';
test.before(async () => {
  const { port } = await hub.start({ port: 0, previewPort: 0, host: '127.0.0.1', handleSignals: false });
  base = `http://127.0.0.1:${port}`;
  origin = base;
});
test.after(async () => {
  await hub.stop();
  if (hasTmux) try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

let ipSeq = 0;
const newClient = () => `10.0.0.${++ipSeq}`;
async function call(method, p, { body, cookie, ip = '10.0.0.250', headers = {} } = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { 'X-Forwarded-For': ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json, text, headers: r.headers };
}
async function login(ip = newClient()) {
  const r = await call('POST', '/api/login', { body: { password: PASSWORD }, ip });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test('sign-in: wrong password, session cookie, /api/me, and the API auth gate', async () => {
  assert.equal((await call('GET', '/api/me')).json.authed, false);
  assert.equal((await call('GET', '/api/sessions')).status, 401);
  const bad = await call('POST', '/api/login', { body: { password: 'nope' }, ip: newClient() });
  assert.equal(bad.status, 401);
  const r = await call('POST', '/api/login', { body: { password: PASSWORD }, ip: newClient() });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^ah_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=\d+/);
  const cookie = sc.split(';')[0];
  assert.equal((await call('GET', '/api/me', { cookie })).json.authed, true);
  assert.equal((await call('GET', '/api/me', { cookie: cookie.slice(0, -2) + 'xx' })).json.authed, false, 'tampered cookie');
});

test('sign-in rate limit: 10 failures from one client → 429, other clients unaffected', async () => {
  const ip = newClient();
  const fails = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/login', { body: { password: 'x' }, ip })));
  assert.ok(fails.every((f) => f.status === 401));
  const blocked = await call('POST', '/api/login', { body: { password: PASSWORD }, ip });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await call('POST', '/api/login', { body: { password: PASSWORD }, ip: newClient() })).status, 200);
});

test('logout revokes that session only; logout all revokes every session', async () => {
  const a = await login(), b = await login(), c = await login();
  assert.equal((await call('POST', '/api/logout', { cookie: a, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: a })).json.authed, false);
  assert.equal((await call('GET', '/api/me', { cookie: b })).json.authed, true);
  await call('POST', '/api/logout', { cookie: b, body: { all: true } });
  assert.equal((await call('GET', '/api/me', { cookie: b })).json.authed, false);
  assert.equal((await call('GET', '/api/me', { cookie: c })).json.authed, false);
});

test('cross-origin state changes are refused even with a valid cookie', async () => {
  const cookie = await login();
  const r = await call('POST', '/api/repos/create', { cookie, body: { name: 'csrf' }, headers: { Origin: 'http://evil.example' } });
  assert.equal(r.status, 403);
  assert.ok(!fs.existsSync(path.join(process.env.WORKSPACE, 'csrf')));
});

test('repos: create, git commit + diff, files, path safety, worktrees, delete', async () => {
  const cookie = await login();
  assert.equal((await call('POST', '/api/repos/create', { cookie, body: { name: '../escape' } })).status, 400);
  assert.equal((await call('POST', '/api/repos/create', { cookie, body: { name: 'demo' } })).status, 200);
  const dir = path.join(process.env.WORKSPACE, 'demo');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

  let r = await call('POST', '/api/repos/demo/git/action', { cookie, body: { action: 'commit', message: 'first' } });
  assert.equal(r.status, 200, r.text);
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n');
  r = await call('GET', '/api/repos/demo/diff', { cookie });
  assert.equal(r.json.branch, 'main');
  assert.match(r.json.diff, /\+more/);
  assert.deepEqual(r.json.files.map((f) => f.path), ['a.txt']);

  r = await call('GET', '/api/repos/local', { cookie });
  assert.deepEqual(r.json.repos.map((x) => [x.name, x.dirty]), [['demo', 1]]);

  r = await call('GET', '/api/repos/demo/file?path=a.txt', { cookie });
  assert.equal(r.json.content, 'hello\nmore\n');
  assert.equal((await call('GET', `/api/repos/demo/file?path=${encodeURIComponent('../../home/.agent-hub/sessions.json')}`, { cookie })).status, 400);
  fs.symlinkSync(path.join(process.env.HOME, '.agent-hub', 'sessions.json'), path.join(dir, 'leak.json'));
  r = await call('GET', '/api/repos/demo/file?path=leak.json', { cookie });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /symlink/);
  assert.equal((await call('GET', '/api/repos/nope/diff', { cookie })).status, 404);

  // worktrees
  r = await call('POST', '/api/repos/demo/worktrees', { cookie, body: { branch: 'feat/x' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.name, 'feat-x');
  const wdir = path.join(process.env.WORKSPACE, '.worktrees', 'demo', 'feat-x');
  assert.ok(fs.existsSync(path.join(wdir, 'a.txt')));
  assert.equal((await call('POST', '/api/repos/demo/worktrees', { cookie, body: { branch: '-bad' } })).status, 400);
  r = await call('GET', '/api/repos/local', { cookie });
  assert.deepEqual(r.json.repos[0].worktrees.map((w) => w.branch), ['feat/x']);
  r = await call('DELETE', '/api/repos/demo/worktrees/feat-x', { cookie, body: { deleteBranch: true } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.note, /Deleted branch feat\/x/);
  assert.ok(!fs.existsSync(wdir));

  // delete needs the name typed back
  assert.equal((await call('DELETE', '/api/repos/demo', { cookie, body: { confirm: 'dem' } })).status, 400);
  assert.ok(fs.existsSync(dir));
  assert.equal((await call('DELETE', '/api/repos/demo', { cookie, body: { confirm: 'demo' } })).status, 200);
  assert.ok(!fs.existsSync(dir));
});

test('sessions: start a shell in a repo, list it, type into it over the terminal WebSocket, end it', { skip: !hasTmux && 'tmux not installed' }, async () => {
  const cookie = await login();
  await call('POST', '/api/repos/create', { cookie, body: { name: 'termrepo' } });
  assert.equal((await call('POST', '/api/sessions', { cookie, body: { agent: 'nope' } })).status, 400);
  assert.equal((await call('POST', '/api/sessions', { cookie, body: { agent: 'shell', repo: 'missing' } })).status, 404);
  let r = await call('POST', '/api/sessions', { cookie, body: { agent: 'shell', repo: 'termrepo' } });
  assert.equal(r.status, 200, r.text);
  const name = r.json.name;
  assert.equal(name, 'shell-termrepo');
  r = await call('GET', '/api/sessions', { cookie });
  const s = r.json.sessions.find((x) => x.name === name);
  assert.ok(s, 'listed');
  assert.equal(s.repo, 'termrepo');
  assert.equal(s.label, 'Shell');

  const wsUrl = `${base.replace('http', 'ws')}/ws/term?session=${name}&cols=100&rows=30`;
  // Another site can't open the terminal, even with the cookie.
  const evil = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: 'http://evil.example' } });
  const evilStatus = await new Promise((resolve) => { evil.on('unexpected-response', (_q, res) => resolve(res.statusCode)); evil.on('open', () => resolve('open')); evil.on('error', () => {}); });
  assert.equal(evilStatus, 401);

  const ws = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: origin } });
  let out = '';
  ws.on('message', (d) => { out += d.toString(); });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await new Promise((r2) => setTimeout(r2, 500));
  ws.send(JSON.stringify({ t: 'i', d: 'echo "$((6*7))-marker $(basename $PWD)"\r' }));
  const end = Date.now() + 10000;
  while (!/42-marker termrepo/.test(out) && Date.now() < end) await new Promise((r2) => setTimeout(r2, 100));
  ws.close();
  assert.match(out, /42-marker termrepo/, 'the shell ran in the repo and its output came back over the WebSocket');

  assert.equal((await call('DELETE', `/api/sessions/${name}`, { cookie })).json.ok, true);
  r = await call('GET', '/api/sessions', { cookie });
  assert.ok(!r.json.sessions.some((x) => x.name === name));
});

test('unknown routes and static UI', async () => {
  const cookie = await login();
  const page = await call('GET', '/', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /<script src="\/app\.js"><\/script>/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('GET', '/vendor/xterm/lib/xterm.js', { cookie })).status, 200);
});
