'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const crypto = require('crypto');
const preview = require('../preview');

test('stripHubCookies removes only Agent Hub cookies', () => {
  assert.equal(preview.stripHubCookies('ah_session=abc; theme=dark; ah_preview=x; sid=1'), 'theme=dark; sid=1');
  assert.equal(preview.stripHubCookies('ah_session=abc'), '');
  assert.equal(preview.stripHubCookies(''), '');
  const h = preview.upstreamHeaders({ cookie: 'ah_session=abc', host: 'nas:3871', accept: '*/*' }, 5173);
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, '127.0.0.1:5173');
  assert.equal(h.accept, '*/*');
});

test('validPort, parsePreviewPath and rewriteLocation', () => {
  assert.equal(preview.validPort('5173', [7681]), 5173);
  assert.equal(preview.validPort('7681', [7681]), 0);
  assert.equal(preview.validPort('80'), 0);
  assert.equal(preview.validPort('abc'), 0);
  assert.deepEqual(preview.parsePreviewPath('/preview/5173/src/main.js'), { port: 5173, rest: '/src/main.js' });
  assert.deepEqual(preview.parsePreviewPath('/preview/5173'), { port: 5173, rest: '/' });
  assert.equal(preview.parsePreviewPath('/api/sessions'), null);
  assert.equal(preview.rewriteLocation('/login', 5173), '/preview/5173/login');
  assert.equal(preview.rewriteLocation('http://localhost:5173/a?b=1', 5173), '/preview/5173/a?b=1');
  assert.equal(preview.rewriteLocation('//evil.example/x', 5173), '//evil.example/x');
  assert.equal(preview.rewriteLocation('https://github.com/x', 5173), 'https://github.com/x');
});

test('safeSubpath rejects symlinks that point outside the repository', () => {
  const { safeSubpath } = require('../workspace');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sym-'));
  const repo = path.join(tmp, 'repo');
  const secret = path.join(tmp, 'secret.json');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(secret, '{}');
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), '');
  fs.symlinkSync(secret, path.join(repo, 'leak.json'));
  fs.symlinkSync(tmp, path.join(repo, 'up'));
  fs.symlinkSync(path.join(repo, 'src', 'a.js'), path.join(repo, 'ok.js'));
  assert.throws(() => safeSubpath(repo, 'leak.json'), /symlink/);
  assert.throws(() => safeSubpath(repo, 'up/secret.json'), /symlink/);
  assert.throws(() => safeSubpath(repo, 'up/new-file'), /symlink/);
  assert.equal(safeSubpath(repo, 'ok.js'), path.join(repo, 'ok.js'));
  assert.equal(safeSubpath(repo, 'src/missing/new.txt'), path.join(repo, 'src/missing/new.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('envstore sourceLine sources env.sh instead of embedding values', () => {
  const envstore = require('../envstore');
  const line = envstore.sourceLine();
  assert.match(line, /^\[ -f '.*env\.sh' \] && \. '.*env\.sh'$/);
});

// ---------------------------------------------------------------- e2e ----
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for server');
}

test('server: CSRF origin check, isolated preview port, cookie stripping', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-e2e-'));
  const uiPassword = crypto.randomBytes(12).toString('hex'); // generated per run, nothing hardcoded
  const [hubPort, previewPort] = [await freePort(), await freePort()];
  let upstreamCookie = 'unset';
  const upstream = http.createServer((req, res) => {
    upstreamCookie = req.headers.cookie;
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`dev server ${req.url}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const devPort = upstream.address().port;

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, HOME: tmp, WORKSPACE: path.join(tmp, 'ws'), UI_PASSWORD: uiPassword,
      PORT: String(hubPort), PREVIEW_PORT: String(previewPort), PREVIEW_PUBLIC_PORT: String(previewPort),
      PREVIEW_SAME_ORIGIN: 'false', GH_TOKEN: '', GITHUB_TOKEN: '', PATH: '/usr/bin:/bin',
    },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGKILL'); upstream.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  await waitFor(async () => (await request(hubPort, 'GET', '/healthz')).status === 200);
  await waitFor(async () => (await request(previewPort, 'GET', '/healthz')).status === 200);

  const host = `127.0.0.1:${hubPort}`;
  // Cross-origin login (CSRF) is blocked, same-origin works.
  const evil = await request(hubPort, 'POST', '/api/login', { body: { password: uiPassword }, headers: { Origin: `http://127.0.0.1:${previewPort}` } });
  assert.equal(evil.status, 403);
  const login = await request(hubPort, 'POST', '/api/login', { body: { password: uiPassword }, headers: { Origin: `http://${host}` } });
  assert.equal(login.status, 200);
  const session = login.headers['set-cookie'][0].split(';')[0];

  // A previewed page (other port = other origin) can't create sessions even with the cookie attached.
  const xs = await request(hubPort, 'POST', '/api/sessions', { body: { agent: 'shell' }, headers: { Cookie: session, Origin: `http://127.0.0.1:${previewPort}` } });
  assert.equal(xs.status, 403);
  const ss = await request(hubPort, 'POST', '/api/sessions', { body: {}, headers: { Cookie: session, 'Sec-Fetch-Site': 'same-site' } });
  assert.equal(ss.status, 403);

  // Preview: unauthenticated is refused; the link's handoff token sets a preview cookie and strips the token.
  assert.equal((await request(previewPort, 'GET', `/preview/${devPort}/`)).status, 401);
  assert.equal((await request(previewPort, 'GET', `/preview/${hubPort}/`, { headers: { Cookie: session } })).status, 400);
  const link = JSON.parse((await request(hubPort, 'GET', `/api/preview/link?port=${devPort}`, { headers: { Cookie: session } })).text);
  const u = new URL(link.url);
  assert.equal(u.port, String(previewPort));
  assert.ok(u.searchParams.get('ah_pt'));
  const hand = await request(previewPort, 'GET', u.pathname + u.search);
  assert.equal(hand.status, 302);
  assert.equal(hand.headers.location, `/preview/${devPort}/`);
  const pvCookie = hand.headers['set-cookie'][0].split(';')[0];
  assert.match(pvCookie, /^ah_preview=pc\./);
  assert.equal((await request(previewPort, 'GET', `/preview/${devPort}/?ah_pt=forged.1.2.3`)).status, 401);

  const page = await request(previewPort, 'GET', `/preview/${devPort}/hello?x=1`, { headers: { Cookie: `${pvCookie}; ${session}; app=1` } });
  assert.equal(page.status, 200);
  assert.equal(page.text, 'dev server /hello?x=1');
  assert.equal(upstreamCookie, 'app=1');

  // The preview cookie is not a valid Agent Hub session.
  assert.equal((await request(hubPort, 'GET', '/api/sessions', { headers: { Cookie: pvCookie.replace('ah_preview', 'ah_session') } })).status, 401);
  // Old /preview links on the main port redirect to the preview server.
  const old = await request(hubPort, 'GET', `/preview/${devPort}/a`, { headers: { Cookie: session } });
  assert.equal(old.status, 302);
  assert.match(old.headers.location, new RegExp(`^http://127\\.0\\.0\\.1:${previewPort}/preview/${devPort}/a\\?ah_pt=`));
});
