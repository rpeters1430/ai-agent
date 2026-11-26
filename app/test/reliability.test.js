'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HttpError, notFound, statusFor, makeWrap } = require('../errors');

test('statusFor maps validation, not-found, system and programmer errors', () => {
  assert.equal(statusFor(new Error('Commit message is required')), 400);
  assert.equal(statusFor(notFound()), 404);
  assert.equal(statusFor(new HttpError(409, 'busy')), 409);
  assert.equal(statusFor(Object.assign(new Error('x'), { code: 'ENOENT' })), 404);
  assert.equal(statusFor(Object.assign(new Error('x'), { code: 'EACCES' })), 500);
  assert.equal(statusFor(new TypeError('cannot read properties of undefined')), 500);
  // GitHub API errors carry GitHub's status in e.status; a GitHub 401 must not look like "you are signed out".
  assert.equal(statusFor(Object.assign(new Error('GitHub GET /user → 401'), { status: 401 })), 400);
});

test('wrap sends the status, logs only 5xx, and handles sync throws', async () => {
  const logged = [];
  const wrap = makeWrap((...a) => logged.push(a.join(' ')));
  const call = (fn) => new Promise((resolve) => {
    const res = { headersSent: false, code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    wrap(fn)({ method: 'GET', originalUrl: '/api/x' }, res);
  });
  assert.deepEqual(await call(async () => { throw new Error('bad input'); }), { code: 400, body: { error: 'bad input' } });
  assert.equal((await call(() => { throw notFound('repo not found'); })).code, 404);
  assert.equal(logged.length, 0);
  assert.equal((await call(async () => { null.x; })).code, 500);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /GET \/api\/x failed/);
});

test('withLock runs same-key calls one at a time, in order, and survives failures', async () => {
  const { withLock } = require('../automations');
  const events = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const job = (name, ms, fail) => withLock('repo:a', async () => {
    events.push(`start ${name}`); await sleep(ms); events.push(`end ${name}`);
    if (fail) throw new Error(name);
  });
  const other = withLock('repo:b', async () => { events.push('start b'); await sleep(1); events.push('end b'); });
  const results = await Promise.allSettled([job('1', 20, true), job('2', 5), other, job('3', 1)]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  const a = events.filter((e) => /[123]$/.test(e));
  assert.deepEqual(a, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  assert.ok(events.indexOf('end b') < events.indexOf('end 1'), 'other keys are not blocked');
});

test('cline headless command sets up isolated CLINE_DIR at run time, not when built', () => {
  const { HEADLESS_AGENTS } = require('../agents');
  process.env.OLLAMA_URL = 'http://10.0.0.5:11434';
  try {
    const cmd = HEADLESS_AGENTS.cline.cmd('qwen3:8b', 0);
    assert.match(cmd, /CLINE_DIR="\$\{JOBDIR:-/);
    assert.match(cmd, /cline auth -p openai/);
    assert.match(cmd, /cline -y -m 'qwen3:8b'/);
  } finally {
    delete process.env.OLLAMA_URL;
  }
});
