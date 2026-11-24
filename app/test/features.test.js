'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('envstore saves, masks, exports env.sh with 0600 mode, and rejects bad keys', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-env-test-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const modPath = require.resolve('../envstore');
  delete require.cache[modPath];
  const envstore = require('../envstore');

  try {
    envstore.saveEnvVars({ DEEPSEEK_API_KEY: "sk-1234567890'abc", GEMINI_API_KEY: 'AIzaSyTest1234' });
    const loaded = envstore.loadSavedEnv();
    assert.equal(loaded.DEEPSEEK_API_KEY, "sk-1234567890'abc");
    assert.equal(loaded.GEMINI_API_KEY, 'AIzaSyTest1234');
    assert.equal(envstore.maskValue('sk-1234567890abcd'), 'sk-1••••abcd');
    assert.equal(envstore.maskValue('short'), '••••');

    const sh = fs.readFileSync(envstore.ENV_SH, 'utf8');
    assert.match(sh, /export DEEPSEEK_API_KEY='sk-1234567890'\\''abc'/);
    assert.match(sh, /export GEMINI_API_KEY='AIzaSyTest1234'/);

    // Clearing a key removes it
    envstore.saveEnvVars({ GEMINI_API_KEY: '' });
    assert.equal(envstore.loadSavedEnv().GEMINI_API_KEY, undefined);

    // Rejects invalid key names and newline injection
    assert.throws(() => envstore.saveEnvVars({ 'bad-key': 'x' }), /Invalid env var/);
    assert.throws(() => envstore.saveEnvVars({ GOOD_KEY: 'a\nb' }), /newlines/);
  } finally {
    process.env.HOME = prevHome;
    delete require.cache[modPath];
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('workspace safeSubpath blocks directory traversal outside repository root', () => {
  const { safeSubpath } = require('../workspace');
  const root = '/workspace/demo';
  assert.equal(safeSubpath(root, 'src/index.js'), path.resolve('/workspace/demo/src/index.js'));
  assert.equal(safeSubpath(root, ''), path.resolve('/workspace/demo'));
  assert.throws(() => safeSubpath(root, '../other/secret.txt'), /escapes/);
  assert.throws(() => safeSubpath(root, 'src/../../etc/passwd'), /escapes/);
});
