'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verdict, buildCliCommand, AGENT_KEYS, SMOKE_TOKEN } = require('../modeltest');
const { LOOP_EXIT } = require('../agentstream');

test('modeltest supports all 6 local/custom-capable CLIs and builds isolated commands', () => {
  assert.deepEqual(AGENT_KEYS, ['pi', 'opencode', 'claude', 'codex', 'qwen', 'cline']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-unit-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  try {
    const base = 'http://192.168.8.143:11434';
    const mInfo = { name: 'qwen3:8b', params: '8B', tools: true, thinking: true, numCtx: 32768 };

    const pi = buildCliCommand('pi', 'qwen3:8b', base, mInfo, tmp, repo, 'task');
    assert.equal(pi.cmd[0], 'pi');
    assert.ok(fs.existsSync(path.join(pi.env.PI_CODING_AGENT_DIR, 'models.json')));

    const oc = buildCliCommand('opencode', 'qwen3:8b', base, mInfo, tmp, repo, 'task');
    assert.equal(oc.cmd[0], 'opencode');
    assert.ok(fs.existsSync(oc.env.OPENCODE_CONFIG));

    const claude = buildCliCommand('claude', 'qwen3:8b', base, mInfo, tmp, repo, 'task');
    assert.equal(claude.cmd[0], 'claude');
    assert.equal(claude.env.ANTHROPIC_BASE_URL, base);
    assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
    assert.ok(claude.cmd.includes('--bare'));

    const codex = buildCliCommand('codex', 'qwen3:8b', base, mInfo, tmp, repo, 'task');
    assert.equal(codex.cmd[0], 'codex');
    assert.ok(fs.existsSync(path.join(codex.env.CODEX_HOME, 'config.toml')));
    assert.match(fs.readFileSync(path.join(codex.env.CODEX_HOME, 'config.toml'), 'utf8'), /ollama-hub/);

    const qwen = buildCliCommand('qwen', 'qwen3:8b', base, mInfo, tmp, repo, 'task');
    assert.equal(qwen.cmd[0], 'qwen');
    assert.ok(qwen.cmd.includes('--auth-type'));
    assert.ok(qwen.cmd.includes(`${base}/v1`));

    const cline = buildCliCommand('cline', 'qwen3:8b', base, mInfo, tmp, repo, 'task');
    assert.equal(cline.cmd[0], 'cline');
    assert.ok(cline.cmd.includes('--json'));
    assert.ok(fs.existsSync(path.join(cline.env.CLINE_DIR, 'data', 'settings', 'providers.json')));

    // Custom llama.cpp endpoint with API key
    const llamaEp = {
      providerId: 'llamacpp',
      name: 'llama.cpp',
      baseUrl: 'http://192.168.8.143:8080/v1',
      apiKey: 'secret-llama-key',
      modelId: 'qwen3-coder',
      contextWindow: 32768,
      isCustom: true,
    };
    const qwenLlama = buildCliCommand('qwen', 'llamacpp/qwen3-coder', llamaEp, { name: 'qwen3-coder' }, tmp, repo, 'task');
    assert.ok(qwenLlama.cmd.includes('http://192.168.8.143:8080/v1'));
    assert.ok(qwenLlama.cmd.includes('secret-llama-key'));
    const codexLlama = buildCliCommand('codex', 'llamacpp/qwen3-coder', llamaEp, { name: 'qwen3-coder' }, tmp, repo, 'task');
    assert.equal(codexLlama.env.AGENT_HUB_PROVIDER_KEY, 'secret-llama-key');
    assert.match(fs.readFileSync(path.join(codexLlama.env.CODEX_HOME, 'config.toml'), 'utf8'), /http:\/\/192\.168\.8\.143:8080\/v1/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verdict classifies pass, loop, no_tools, error, and tool_smoke outcomes', () => {
  const passCoding = verdict({ tools: 3, secs: 18, exit: 0 }, { exact: true, others: [], commented: true, changed: true, committed: false }, false, 'coding');
  assert.equal(passCoding.verdict, 'pass');

  const looped = verdict({ tools: 4, secs: 20, exit: LOOP_EXIT, loop: { call: 'read a.js', times: 4 } }, { commented: false }, false, 'coding');
  assert.equal(looped.verdict, 'loop');

  const noTools = verdict({ tools: 0, secs: 5, exit: 0, lastText: 'here is code' }, { commented: false }, false, 'coding');
  assert.equal(noTools.verdict, 'no_tools');

  const smokePass = verdict({ tools: 1, secs: 12, exit: 0, lastText: `Value: ${SMOKE_TOKEN}` }, {}, false, 'tool_smoke');
  assert.equal(smokePass.verdict, 'pass');

  const smokePartial = verdict({ tools: 1, secs: 12, exit: 0, lastText: 'something else' }, {}, false, 'tool_smoke');
  assert.equal(smokePartial.verdict, 'partial');
});
