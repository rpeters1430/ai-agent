'use strict';
// Single source of truth for installed coding agents, login helpers, headless automation commands, and updatable CLIs.
const fs = require('fs');
const path = require('path');
const ollama = require('./ollama');

const STREAM = path.join(__dirname, 'agentstream.js');
const shQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const guarded = (agent, limit, cmd) => (limit ? `node '${STREAM}' --agent ${agent} --loop ${limit} --summary "$JOBDIR/stream.json" -- ${cmd}` : cmd);

const AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    cmd: 'claude',
    yolo: 'claude --dangerously-skip-permissions',
    pkg: '@anthropic-ai/claude-code',
    headless: (m, g) => {
      const ep = m ? ollama.resolveModelEndpoint(m) : null;
      const anthropicBase = ep ? (ep.ollamaBase || ep.baseUrl.replace(/\/v1\/?$/, '')) : '';
      const envPrefix = ep ? `env ANTHROPIC_BASE_URL=${shQ(anthropicBase)} ANTHROPIC_AUTH_TOKEN=${shQ(ep.apiKey)} ANTHROPIC_API_KEY=${shQ(ep.apiKey)} ` : '';
      const modelFlag = m ? ` --model ${shQ(ep ? ep.modelId : m)}` : '';
      return guarded('claude', g, `${envPrefix}claude --dangerously-skip-permissions${modelFlag}${g ? ' --output-format stream-json --verbose' : ''} -p "$P"`);
    },
  },
  codex: {
    label: 'Codex',
    bin: 'codex',
    cmd: 'codex',
    yolo: 'codex --dangerously-bypass-approvals-and-sandbox',
    pkg: '@openai/codex',
    headless: (m, g) => {
      const ep = m ? ollama.resolveModelEndpoint(m) : null;
      let envPrefix = '';
      let provCfg = m ? ` -m ${shQ(m)}` : '';
      if (ep) {
        const provId = ep.isCustom ? `hub-${ep.providerId}` : ollama.CODEX_PROVIDER_ID;
        if (ep.isCustom) envPrefix = `AGENT_HUB_PROVIDER_KEY=${shQ(ep.apiKey)} `;
        const cfgVal = ep.isCustom
          ? `model_providers.${provId}={name=${JSON.stringify(ep.name)},base_url=${JSON.stringify(ep.baseUrl)},wire_api="responses",env_key="AGENT_HUB_PROVIDER_KEY"}`
          : `model_providers.${provId}={name="Ollama",base_url=${JSON.stringify(ep.baseUrl)},wire_api="responses"}`;
        provCfg = ` -c ${shQ(`model_provider="${provId}"`)} -c ${shQ(cfgVal)} -m ${shQ(ep.modelId)}`;
      }
      return guarded('codex', g, `${envPrefix}codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${provCfg}${g ? ' --json' : ''} "$P"`);
    },
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    cmd: 'opencode',
    pkg: 'opencode-ai',
    headless: (m, g) => guarded('opencode', g, `opencode run --auto${g ? ' --format json' : ''}${m ? ` -m ${shQ(m.includes('/') ? m : `ollama/${m}`)}` : ''} "$P"`),
  },
  pi: {
    label: 'Pi',
    bin: 'pi',
    cmd: 'pi',
    pkg: '@earendil-works/pi-coding-agent',
    headless: (m, g) => {
      let modelFlag = '';
      if (m) {
        const i = m.indexOf('/');
        const hasProv = i > 0 && !m.startsWith('hf.co/') && /^[a-z0-9_-]+$/.test(m.slice(0, i));
        modelFlag = hasProv ? ` --provider ${shQ(m.slice(0, i))} --model ${shQ(m.slice(i + 1))}` : ` --provider ollama --model ${shQ(m)}`;
      }
      return guarded('pi', g, `pi${modelFlag}${g ? ' --mode json' : ''} -p "$P"`);
    },
  },
  agy: {
    label: 'Antigravity',
    bin: 'agy',
    cmd: 'agy',
    yolo: 'agy --dangerously-skip-permissions',
    installer: 'https://antigravity.google/cli/install.sh',
    headless: () => 'agy --dangerously-skip-permissions -p "$P"',
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    cmd: 'gemini',
    yolo: 'gemini --yolo',
    pkg: '@google/gemini-cli',
    headless: (_m, g) => guarded('gemini', g, `gemini --yolo${g ? ' --output-format stream-json' : ''} -p "$P"`),
  },
  qwen: {
    label: 'Qwen Code',
    bin: 'qwen',
    cmd: 'qwen',
    yolo: 'qwen -y',
    pkg: '@qwen-code/qwen-code',
    headless: (m, g) => {
      const ep = m ? ollama.resolveModelEndpoint(m) : null;
      const ollamaFlags = ep
        ? ` --auth-type openai --openai-base-url ${shQ(ep.baseUrl)} --openai-api-key ${shQ(ep.apiKey)} -m ${shQ(ep.modelId)}`
        : (m ? ` -m ${shQ(m)}` : '');
      return guarded('qwen', g, `qwen -y${ollamaFlags}${g ? ' --output-format stream-json' : ''} -p "$P"`);
    },
  },
  cline: {
    label: 'Cline',
    bin: 'cline',
    cmd: 'cline',
    yolo: 'cline -y',
    pkg: 'cline',
    headless: (m, g) => {
      const ep = m ? ollama.resolveModelEndpoint(m) : null;
      if (ep) {
        const setup = `CLINE_DIR="\${JOBDIR:-$(mktemp -d)}/cline"; export CLINE_DIR; cline auth -p openai -b ${shQ(ep.baseUrl)} -k ${shQ(ep.apiKey)} -m ${shQ(ep.modelId)} >/dev/null 2>&1`;
        return `${setup} && ${guarded('cline', g, `cline -y${g ? ' --json' : ''} -m ${shQ(ep.modelId)} "$P"`)}`;
      }
      const modelFlag = m ? ` -m ${shQ(m)}` : '';
      return guarded('cline', g, `cline -y${g ? ' --json' : ''}${modelFlag} "$P"`);
    },
  },
  shell: {
    label: 'Shell',
    bin: 'bash',
    cmd: 'bash -l',
  },
};

// Extra non-agent CLIs tracked by System → Agent CLIs updater.
const EXTRA_TOOLS = [
  { key: 'agent-browser', label: 'Agent Browser', bin: 'agent-browser', pkg: 'agent-browser' },
];

// Account/login helpers (run in $HOME, not a repo).
const LOGINS = {
  gh:       { label: 'GitHub login',      cmd: 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git && echo && echo "GitHub connected."' },
  claude:   { label: 'Claude login',      cmd: 'echo "Claude Code asks you to sign in on first run (or type /login)."; claude' },
  codex:    { label: 'Codex login',       cmd: 'codex login --device-auth' },
  opencode: { label: 'OpenCode login',    cmd: 'opencode auth login' },
  pi:       { label: 'Pi login',          cmd: 'echo "Type /login inside pi to sign in."; pi' },
  agy:      { label: 'Antigravity login', cmd: 'agy' },
  gemini:   { label: 'Gemini login',      cmd: 'echo "Gemini CLI signs in with Google OAuth on first run (or set GEMINI_API_KEY in System → API Keys)."; gemini' },
  qwen:     { label: 'Qwen Code login',   cmd: 'echo "Qwen Code signs in with Qwen OAuth or an OpenAI-compatible API key on first run."; qwen' },
  cline:    { label: 'Cline login',       cmd: 'cline auth' },
};

const HEADLESS_AGENTS = Object.fromEntries(
  Object.entries(AGENTS)
    .filter(([, a]) => typeof a.headless === 'function')
    .map(([k, a]) => [k, { label: a.label, bin: a.bin, cmd: a.headless }])
);

const UPDATABLE_TOOLS = [
  ...Object.entries(AGENTS)
    .filter(([, a]) => a.pkg || a.installer)
    .map(([key, a]) => ({ key, label: a.label, bin: a.bin, ...(a.pkg ? { pkg: a.pkg } : {}), ...(a.installer ? { installer: a.installer } : {}) })),
  ...EXTRA_TOOLS,
];

module.exports = { AGENTS, LOGINS, HEADLESS_AGENTS, UPDATABLE_TOOLS, EXTRA_TOOLS };
