'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tmuxfmt = require('../tmuxfmt');

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('list-sessions output survives real tmux: tabs (3.4+) and non-ASCII without a UTF-8 locale', { skip: !hasTmux && 'tmux not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-tmux-'));
  const env = { ...process.env, TMUX_TMPDIR: dir };
  const tmux = (...a) => execFileSync('tmux', a, { env, encoding: 'utf8' });
  try {
    tmux('new-session', '-d', '-s', 'arena-1-claude', 'sleep 30');
    tmux('set-option', '-t', 'arena-1-claude', '@label', 'Arena 1 · Claude Code (qwen3:8b)');
    tmux('set-option', '-t', 'arena-1-claude', '@repo', 'my-repo');
    const out = tmux(...tmuxfmt.listArgs(['session_name', '@label', '@repo', '@wt', 'session_created']));
    const [name, label, repo, wt, created] = tmuxfmt.parseLine(out.trim());
    assert.equal(name, 'arena-1-claude');
    assert.equal(label, 'Arena 1 · Claude Code (qwen3:8b)');
    assert.equal(repo, 'my-repo');
    assert.equal(wt, '');
    assert.match(created, /^\d{10}$/);
  } finally {
    try { tmux('kill-server'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
