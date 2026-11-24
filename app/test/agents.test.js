'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENTS, LOGINS, HEADLESS_AGENTS, UPDATABLE_TOOLS } = require('../agents');

test('AGENTS has required keys and valid metadata', () => {
  for (const key of ['claude', 'codex', 'opencode', 'pi', 'agy', 'gemini', 'qwen', 'dsh', 'shell']) {
    const a = AGENTS[key];
    assert.ok(a, `missing agent ${key}`);
    assert.equal(typeof a.label, 'string');
    assert.equal(typeof a.bin, 'string');
    assert.equal(typeof a.cmd, 'string');
  }
  // Yolo modes on agents that support permission skipping
  for (const key of ['claude', 'codex', 'agy', 'gemini', 'qwen']) {
    assert.equal(typeof AGENTS[key].yolo, 'string', `${key} should have yolo cmd`);
  }
});

test('HEADLESS_AGENTS includes every coding agent except shell', () => {
  assert.deepEqual(
    Object.keys(HEADLESS_AGENTS).sort(),
    ['agy', 'claude', 'codex', 'dsh', 'gemini', 'opencode', 'pi', 'qwen']
  );
  assert.match(HEADLESS_AGENTS.opencode.cmd('qwen3:8b', 4), /--loop 4/);
  assert.match(HEADLESS_AGENTS.opencode.cmd('qwen3:8b', 4), /ollama\/qwen3:8b/);
  assert.match(HEADLESS_AGENTS.opencode.cmd('lmstudio/qwen3-32b', 4), /lmstudio\/qwen3-32b/);
  assert.doesNotMatch(HEADLESS_AGENTS.opencode.cmd('qwen3:8b', 0), /--loop/);
  assert.match(HEADLESS_AGENTS.pi.cmd('qwen3:8b', 3), /--provider ollama --model 'qwen3:8b'/);
  assert.match(HEADLESS_AGENTS.pi.cmd('lmstudio/qwen3-32b', 3), /--provider 'lmstudio' --model 'qwen3-32b'/);
  assert.match(HEADLESS_AGENTS.claude.cmd('', 4), /--agent claude --loop 4/);
  assert.match(HEADLESS_AGENTS.codex.cmd('', 4), /--agent codex --loop 4/);
  assert.match(HEADLESS_AGENTS.gemini.cmd('', 4), /--agent gemini --loop 4/);
  assert.match(HEADLESS_AGENTS.qwen.cmd('', 0), /qwen -y -p/);
  assert.match(HEADLESS_AGENTS.dsh.cmd('', 0), /dsh --profile headless/);
});

test('UPDATABLE_TOOLS includes npm packages, agent-browser, and agy installer', () => {
  const keys = UPDATABLE_TOOLS.map((t) => t.key).sort();
  assert.deepEqual(keys, ['agent-browser', 'agy', 'claude', 'codex', 'dsh', 'gemini', 'opencode', 'pi', 'qwen']);
  for (const t of UPDATABLE_TOOLS) {
    assert.ok(t.pkg || t.installer, `${t.key} needs pkg or installer`);
  }
});

test('LOGINS includes gh and all coding agents', () => {
  assert.deepEqual(
    Object.keys(LOGINS).sort(),
    ['agy', 'claude', 'codex', 'dsh', 'gemini', 'gh', 'opencode', 'pi', 'qwen']
  );
});
