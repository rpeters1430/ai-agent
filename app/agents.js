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
      const base = m ? ollama.ollamaUrl() : '';
      const envPrefix = m && base ? `env ANTHROPIC_BASE_URL=${shQ(base)} ANTHROPIC_AUTH_TOKEN='ollama' ANTHROPIC_API_KEY='ollama' ` : '';
      const modelFlag = m ? ` --model ${shQ(m)}` : '';
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
      const base = m ? ollama.ollamaUrl() : '';
      const provCfg = m && base
        ? ` -c ${shQ(`model_provider="${ollama.CODEX_PROVIDER_ID}"`)} -c ${shQ(`model_providers.${ollama.CODEX_PROVIDER_ID}={name="Ollama",base_url="${base}/v1",wire_api="responses"}`)} -m ${shQ(m)}`
        : (m ? ` -m ${shQ(m)}` : '');
      return guarded('codex', g, `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check${provCfg}${g ? ' --json' : ''} "$P"`);
    },
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    cmd: 'opencode',
    pkg: 'opencode-ai',
    headless: (m, g) => guarded('opencode', g, `opencode run --auto${g ? ' --format json' : ''}${m ? ` -m '${m.includes('/') ? m : `ollama/${m}`}'` : ''} "$P"`),
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
        modelFlag = hasProv ? ` --provider '${m.slice(0, i)}' --model '${m.slice(i + 1)}'` : ` --provider ollama --model '${m}'`;
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
      const base = m ? ollama.ollamaUrl() : '';
      const ollamaFlags = m && base ? ` --auth-type openai --openai-base-url ${shQ(`${base}/v1`)} --openai-api-key 'ollama' -m ${shQ(m)}` : (m ? ` -m ${shQ(m)}` : '');
      return guarded('qwen', g, `qwen -y${ollamaFlags}${g ? ' --output-format stream-json' : ''} -p "$P"`);
    },
  },
  dsh: {
    label: 'DeepSeek Harness',
    bin: 'dsh',
    cmd: 'env -u DEEPSEEK_BASE_URL dsh web --no-open',
    pkg: '@deepseek-ai/dsh',
    headless: (m, g) => {
      const base = m ? ollama.ollamaUrl() : '';
      if (m && base) {
        // The run script writes the patch into its own job folder ($JOBDIR), so it's removed with the job.
        const yaml = ollama.buildDshPatchYaml(base, [{ name: m }], m, { disableTitleLlm: true });
        const write = `DSH_PATCH="\${JOBDIR:-$(mktemp -d)}/dsh-ollama.yml"; (umask 077; printf '%s' ${shQ(yaml)} > "$DSH_PATCH")`;
        return `${write} && ${guarded('dsh', g, `env -u DEEPSEEK_BASE_URL -u DEEPSEEK_API_KEY OLLAMA_API_KEY='ollama' dsh --profile headless --patch "$DSH_PATCH"${g ? ' --json' : ''} --approval-policy never "$P"`)}`;
      }
      return guarded('dsh', g, `env -u DEEPSEEK_BASE_URL dsh --profile headless${g ? ' --json' : ''} --approval-policy never "$P"`);
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
  dsh:      { label: 'DeepSeek login',    cmd: 'echo "DeepSeek Harness uses DEEPSEEK_API_KEY (and optional DEEPSEEK_BASE_URL). Set them in System → API Keys or .env."; dsh --version || true; exec bash -l' },
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

// Older versions wrote one ~/.agent-hub/dsh-auto-*.yml per DeepSeek Harness run and never removed them.
function cleanupLegacyDshPatches() {
  const dir = path.dirname(ollama.DSH_PATCH_FILE);
  try {
    for (const f of fs.readdirSync(dir)) if (/^dsh-auto-.*\.yml$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {}
}

module.exports = { AGENTS, LOGINS, HEADLESS_AGENTS, UPDATABLE_TOOLS, EXTRA_TOOLS, cleanupLegacyDshPatches };
