'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HUB_OPEN = path.resolve(__dirname, '..', '..', 'hub-open');

test('hub-open logs http(s) URLs to $HOME/.agent-hub/open.log and ignores non-web schemes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-hubopen-'));
  try {
    const env = { ...process.env, HOME: tmp };
    execFileSync(HUB_OPEN, ['file:///etc/passwd'], { env, stdio: 'pipe' });
    assert.equal(fs.existsSync(path.join(tmp, '.agent-hub', 'open.log')), false);

    execFileSync(HUB_OPEN, ['https://example.com/auth?code=123'], { env, stdio: 'pipe' });
    const lines = fs.readFileSync(path.join(tmp, '.agent-hub', 'open.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const [ts, url] = lines[0].split('\t');
    assert.ok(Number(ts) > 1700000000000);
    assert.equal(url, 'https://example.com/auth?code=123');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hub-open bounds open.log line count when > 100 entries are logged', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-hubopen-cap-'));
  try {
    const env = { ...process.env, HOME: tmp };
    for (let i = 0; i < 105; i++) {
      execFileSync(HUB_OPEN, [`https://example.com/login/${i}`], { env, stdio: 'pipe' });
    }
    const lines = fs.readFileSync(path.join(tmp, '.agent-hub', 'open.log'), 'utf8').trim().split('\n');
    assert.ok(lines.length >= 50 && lines.length <= 60, `expected 50..60 lines, got ${lines.length}`);
    assert.ok(lines[lines.length - 1].endsWith('\thttps://example.com/login/104'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
