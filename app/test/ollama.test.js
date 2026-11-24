'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODEL_RE, parseNumCtx, parseCtx, parseSearch, parseTags, usage, opencodeProvider, piProvider,
  OLLAMA_CLI_KEYS, CODEX_PROVIDER_ID, buildCodexProviderToml, buildDshPatchYaml,
} = require('../ollama');

test('MODEL_RE accepts valid tags and rejects shell metacharacters', () => {
  assert.equal(MODEL_RE.test('qwen2.5-coder:14b'), true);
  assert.equal(MODEL_RE.test('hf.co/org/model:q4_k_m'), true);
  assert.equal(MODEL_RE.test('llama3.1'), true);
  assert.equal(MODEL_RE.test("qwen' ; rm -rf /"), false);
  assert.equal(MODEL_RE.test('model with spaces'), false);
  assert.equal(MODEL_RE.test('-leading-dash'), false);
});

test('parseNumCtx and parseCtx parse Ollama parameters and sizes', () => {
  assert.equal(parseNumCtx('temperature 0.2\nnum_ctx 32768\ntop_p 0.9'), 32768);
  assert.equal(parseNumCtx('temperature 0.2'), null);
  assert.equal(parseCtx('32K'), 32768);
  assert.equal(parseCtx('1M'), 1048576);
  assert.equal(parseCtx(''), null);
});

test('usage classifies embedding, chat-only, limited context, and agent-ready models', () => {
  assert.equal(usage(['embedding'], 8192).level, 'none');
  assert.equal(usage(['completion'], 32768).level, 'chat');
  assert.equal(usage(['tools'], 4096).level, 'limited');
  assert.equal(usage(['tools', 'thinking', 'vision'], 32768).level, 'agent');
});

test('parseSearch extracts model cards from ollama.com search HTML', () => {
  const html = `
    <ul>
      <li>
        <a href="/library/qwen2.5-coder">
          <p class="desc">Code &amp; tool calling model</p>
          <span class="inline-flex items-center rounded-md bg-indigo-50">tools</span>
          <span class="inline-flex items-center rounded-md bg-[#ddf4ff]">7b</span>
          <span class="inline-flex items-center rounded-md bg-[#ddf4ff]">14b</span>
          <div title="Context window"><span>32K</span></div>
          <span title="1,234,567 downloads">1.2M</span>
          <span title="Updated 2 weeks ago">2w</span>
        </a>
      </li>
      <li>
        <a href="/library/user/community-model">ignored</a>
      </li>
    </ul>`;
  const models = parseSearch(html);
  assert.equal(models.length, 1);
  assert.equal(models[0].name, 'qwen2.5-coder');
  assert.equal(models[0].description, 'Code & tool calling model');
  assert.deepEqual(models[0].caps, ['tools']);
  assert.deepEqual(models[0].sizes, ['7b', '14b']);
  assert.equal(models[0].context, '32K');
  assert.equal(models[0].downloads, 1234567);
  assert.equal(models[0].usage.level, 'agent');
});

test('parseTags extracts tag rows from ollama.com tags HTML', () => {
  const html = `
    <a href="/library/qwen2.5-coder:14b" class="md:hidden block">
      qwen2.5-coder:14b latest • 9.0GB • 32K context window • Text input
    </a>
    <a href="/library/qwen2.5-coder:7b-cloud" class="md:hidden block">
      qwen2.5-coder:7b-cloud • 4.7GB • 128K context window • Text, Image input
    </a>`;
  const tags = parseTags(html, 'qwen2.5-coder');
  assert.equal(tags.length, 2);
  assert.equal(tags[0].tag, '14b');
  assert.equal(tags[0].size, '9.0GB');
  assert.equal(tags[0].contextTokens, 32768);
  assert.equal(tags[0].latest, true);
  assert.equal(tags[0].cloud, false);
  assert.equal(tags[1].cloud, true);
  assert.equal(tags[1].input, 'Text, Image');
});

test('opencodeProvider and piProvider build valid provider schemas', () => {
  const models = [{ name: 'qwen2.5-coder:14b', params: '14B', tools: true, thinking: true, vision: false, numCtx: 32768 }];
  const oc = opencodeProvider('http://10.0.0.5:11434', models);
  assert.equal(oc.options.baseURL, 'http://10.0.0.5:11434/v1');
  assert.equal(oc.models['qwen2.5-coder:14b'].limit.context, 32768);
  assert.equal(oc.models['qwen2.5-coder:14b'].reasoning, true);

  const pi = piProvider('http://10.0.0.5:11434', models);
  assert.equal(pi.baseUrl, 'http://10.0.0.5:11434/v1');
  assert.equal(pi.models[0].id, 'qwen2.5-coder:14b');
  assert.equal(pi.models[0].contextWindow, 32768);
  assert.deepEqual(pi.models[0].input, ['text']);
});

test('multi-CLI Ollama builders generate valid Codex TOML and DSH YAML configs', () => {
  assert.deepEqual(OLLAMA_CLI_KEYS, ['pi', 'opencode', 'claude', 'codex', 'qwen', 'dsh']);
  const toml = buildCodexProviderToml('http://10.0.0.5:11434');
  assert.match(toml, new RegExp(`\\[model_providers\\.${CODEX_PROVIDER_ID}\\]`));
  assert.match(toml, /base_url = "http:\/\/10\.0\.0\.5:11434\/v1"/);
  assert.match(toml, /wire_api = "responses"/);

  const yaml = buildDshPatchYaml('http://10.0.0.5:11434', [{ name: 'qwen3:8b', params: '8B', numCtx: 32768 }], 'qwen3:8b', { disableTitleLlm: true });
  assert.match(yaml, /id: llm-pi-ai/);
  assert.match(yaml, /api: openai-completions/);
  assert.match(yaml, /baseURL: "http:\/\/10\.0\.0\.5:11434\/v1"/);
  assert.match(yaml, /id: "qwen3:8b"/);
  assert.match(yaml, /id: session-title-llm/);
  assert.match(yaml, /disabled: true/);
});
