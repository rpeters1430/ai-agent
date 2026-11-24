'use strict';
// "Ollama × CLI Compatibility Lab" test runner:
// Runs a real tool-calling task across every Ollama-capable CLI (Pi, OpenCode, Claude Code, Codex,
// Qwen Code, DeepSeek Harness) in an isolated throwaway repo, verifying tool calls, edits/reads,
// clean completion, and loop-guard protection.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const ollama = require('./ollama');
const { LOOP_EXIT } = require('./agentstream');

const HOME = process.env.HOME || '/home/dev';
const HUB_DIR = path.join(HOME, '.agent-hub');
const RESULTS_FILE = path.join(HUB_DIR, 'model-tests.json');
const STREAM = path.join(__dirname, 'agentstream.js');
const AGENTS = Object.fromEntries(Object.entries(ollama.OLLAMA_CLIS).map(([k, v]) => [k, v.label]));
const AGENT_KEYS = ollama.OLLAMA_CLI_KEYS;
const MODES = ['coding', 'tool_smoke'];
const TIMEOUT_S = 300;
const LOOP_LIMIT = 4;
const MAX_TOOLS = 25;
const COMMENT = '// Port is configurable with the PORT environment variable.';
const SMOKE_TOKEN = 'AGENT_HUB_TOKEN_7391';

const CODING_TASK = `Find the file where the HTTP server starts listening on its port. Add a one-line comment directly above that listen call saying: ${COMMENT} Do not change anything else. Then reply with the file path you changed.`;
const SMOKE_TASK = 'Read the file secret.txt using a tool (do not guess) and reply with its exact contents only.';

// A small but realistic project, so the model has to search before it can edit.
const FIXTURE = {
  'package.json': JSON.stringify({ name: 'inventory-api', version: '1.2.0', main: 'src/server.js', scripts: { start: 'node src/server.js', test: 'node --test test/' } }, null, 2) + '\n',
  'README.md': '# inventory-api\n\nSmall HTTP API for warehouse stock.\n\n- `GET /health`\n- `GET /items`, `POST /items`\n\nRun with `npm start`.\n',
  'secret.txt': `${SMOKE_TOKEN}\n`,
  'src/config.js': "'use strict';\n\nmodule.exports = {\n  port: Number(process.env.PORT) || 3000,\n  dbFile: process.env.DB_FILE || 'data/items.json',\n  logRequests: process.env.LOG_REQUESTS !== '0',\n};\n",
  'src/db.js': "'use strict';\nconst fs = require('fs');\nconst path = require('path');\nconst { dbFile } = require('./config');\n\nfunction load() {\n  try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch { return []; }\n}\n\nfunction save(items) {\n  fs.mkdirSync(path.dirname(dbFile), { recursive: true });\n  fs.writeFileSync(dbFile, JSON.stringify(items, null, 2));\n}\n\nmodule.exports = { load, save };\n",
  'src/routes/health.js': "'use strict';\n\nmodule.exports = function health(req, res) {\n  res.writeHead(200, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));\n};\n",
  'src/routes/items.js': "'use strict';\nconst db = require('../db');\n\nfunction readBody(req) {\n  return new Promise((resolve, reject) => {\n    let body = '';\n    req.on('data', (c) => { body += c; });\n    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });\n  });\n}\n\nmodule.exports = async function items(req, res) {\n  const list = db.load();\n  if (req.method === 'POST') {\n    const item = await readBody(req);\n    if (!item.name) { res.writeHead(400); return res.end('name is required'); }\n    list.push({ id: Date.now(), name: item.name, qty: Number(item.qty) || 0 });\n    db.save(list);\n    res.writeHead(201);\n    return res.end();\n  }\n  res.writeHead(200, { 'Content-Type': 'application/json' });\n  res.end(JSON.stringify(list));\n};\n",
  'src/server.js': "'use strict';\nconst http = require('http');\nconst config = require('./config');\nconst health = require('./routes/health');\nconst items = require('./routes/items');\n\nconst routes = { '/health': health, '/items': items };\n\nconst server = http.createServer(async (req, res) => {\n  if (config.logRequests) console.log(req.method, req.url);\n  const handler = routes[req.url.split('?')[0]];\n  if (!handler) { res.writeHead(404); return res.end('not found'); }\n  try {\n    await handler(req, res);\n  } catch (e) {\n    console.error(e);\n    res.writeHead(500);\n    res.end('internal error');\n  }\n});\n\nserver.listen(config.port, () => {\n  console.log(`inventory-api listening on ${config.port}`);\n});\n\nmodule.exports = server;\n",
  'test/health.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst health = require('../src/routes/health');\n\ntest('health returns ok', () => {\n  let body = '';\n  health({}, { writeHead() {}, end(b) { body = b; } });\n  assert.strictEqual(JSON.parse(body).ok, true);\n});\n",
};

let results = {};       // model -> agent -> result
const queue = [];       // [{ model, agent, mode }]
let current = null;     // { model, agent, mode, startedAt, live: [], child, cancel }

function load() { try { results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch { results = {}; } }
function save() {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE + '.tmp', JSON.stringify(results, null, 2), { mode: 0o600 });
  fs.renameSync(RESULTS_FILE + '.tmp', RESULTS_FILE);
}
function killTree(child, sig) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}

function makeRepo(dir) {
  for (const [f, body] of Object.entries(FIXTURE)) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('-c', 'user.name=agent-hub', '-c', 'user.email=agent-hub@localhost', 'commit', '-qm', 'init');
}

// Did the agent make exactly the change we asked for? (Compared with the first commit, in case it committed.)
function checkEdit(dir) {
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  const root = git('rev-list', '--max-parents=0', 'HEAD').trim().split('\n').pop();
  const files = new Set([
    ...git('diff', '--name-only', root).split('\n'),
    ...git('ls-files', '--others', '--exclude-standard').split('\n'),
  ].filter(Boolean));
  const lines = fs.readFileSync(path.join(dir, 'src/server.js'), 'utf8').split('\n');
  const i = lines.findIndex((l) => l.includes('server.listen('));
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); // ignore punctuation, case and spacing
  const commented = i > 0 && /^\s*\/\//.test(lines[i - 1]) && norm(lines[i - 1]) === norm(COMMENT);
  const exact = commented && /^1\s+0\s/.test(git('diff', '--numstat', root, '--', 'src/server.js').trim());
  const others = [...files].filter((f) => f !== 'src/server.js');
  const committed = git('rev-list', '--count', 'HEAD').trim() !== '1';
  git('add', '-A'); // so new files show up in the diff too
  const diff = git('diff', '--cached', '--no-color', '--unified=2', root).slice(0, 3000);
  return { changed: files.size > 0, commented, exact, others, committed, diff };
}

function verdict(sum, chk, timedOut, mode = 'coding') {
  const t = `${sum.tools} tool call${sum.tools === 1 ? '' : 's'}`;
  if (sum.exit === LOOP_EXIT) {
    return {
      verdict: 'loop',
      text: `Looped: ${sum.loop?.call || 'repeated call'} (${sum.loop?.times || LOOP_LIMIT}×)${mode === 'coding' && chk.commented ? ' (after making the right edit — it just didn\'t stop)' : ''}.`,
    };
  }
  if (timedOut) {
    return {
      verdict: 'timeout',
      text: `Didn't finish in ${TIMEOUT_S / 60} min (${t}${mode === 'coding' ? (chk.commented ? ', the edit was made' : ', no correct edit') : ''}).`,
    };
  }
  if (!sum.tools) {
    if (sum.exit && sum.exit !== 0 && (sum.errors?.length || sum.stderr)) {
      return { verdict: 'error', text: `Failed (exit ${sum.exit}): ${(sum.errors?.[0] || sum.stderr || '').slice(0, 220)}` };
    }
    return { verdict: 'no_tools', text: `Never called a tool${sum.lastText ? ' — it probably wrote its tool calls as plain text' : ''}.` };
  }
  if (mode === 'tool_smoke') {
    const foundToken = (sum.lastText || '').includes(SMOKE_TOKEN);
    if (sum.exit && sum.exit !== 0 && !foundToken) {
      return { verdict: 'error', text: `Failed (exit ${sum.exit}): ${(sum.errors?.[0] || sum.stderr || '').slice(0, 220)}` };
    }
    if (foundToken) return { verdict: 'pass', text: `Tool call succeeded and read exact token in ${sum.secs}s (${t}).` };
    return { verdict: 'partial', text: `Made ${t} in ${sum.secs}s but reply did not include exact token.` };
  }
  if (sum.exit && sum.exit !== 0 && !chk.commented) {
    return { verdict: 'error', text: `Failed (exit ${sum.exit}): ${(sum.errors?.[0] || sum.stderr || '').slice(0, 220)}` };
  }
  const extra = chk.committed ? ' It also made a git commit nobody asked for.' : '';
  if (chk.exact && !chk.others.length) return { verdict: 'pass', text: `Made exactly the right edit in ${sum.secs}s (${t}).${extra}` };
  if (chk.commented) return { verdict: 'partial', text: `Added the comment but also changed ${chk.others.length ? chk.others.slice(0, 5).join(', ') : 'other lines in src/server.js'} (${t}).${extra}` };
  if (chk.changed) return { verdict: 'wrong', text: `Changed files but not the way it was asked (${t}).` };
  return { verdict: 'no_edit', text: `Used tools but never made the edit (${t}).` };
}

function buildCliCommand(agent, model, base, mInfo, tmp, repo, task) {
  const env = { ...process.env, PWD: repo }; // OpenCode takes the project from $PWD, not the real cwd
  if (agent === 'opencode') {
    // Merged over user config, so the model doesn't need to be applied first.
    const f = path.join(tmp, 'opencode.json');
    fs.writeFileSync(f, JSON.stringify({ $schema: 'https://opencode.ai/config.json', provider: { [ollama.PROVIDER_ID]: ollama.opencodeProvider(base, [mInfo]) } }));
    env.OPENCODE_CONFIG = f;
    return { env, cmd: ['opencode', 'run', '--auto', '--format', 'json', '-m', `${ollama.PROVIDER_ID}/${model}`, task] };
  }
  if (agent === 'pi') {
    const d = path.join(tmp, 'pi');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'models.json'), JSON.stringify({ providers: { [ollama.PROVIDER_ID]: ollama.piProvider(base, [mInfo]) } }));
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ defaultProvider: ollama.PROVIDER_ID, defaultModel: model }));
    env.PI_CODING_AGENT_DIR = d;
    return { env, cmd: ['pi', '--provider', ollama.PROVIDER_ID, '--model', model, '--mode', 'json', '-p', task] };
  }
  if (agent === 'claude') {
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_AUTH_TOKEN = 'ollama';
    env.ANTHROPIC_API_KEY = 'ollama';
    return { env, cmd: ['claude', '--bare', '--dangerously-skip-permissions', '--model', model, '--output-format', 'stream-json', '--verbose', '-p', task] };
  }
  if (agent === 'codex') {
    const d = path.join(tmp, 'codex_home');
    fs.mkdirSync(d);
    const toml = [
      `model_provider = "${ollama.CODEX_PROVIDER_ID}"`,
      `model = ${JSON.stringify(model)}`,
      '',
      ollama.buildCodexProviderToml(base),
      '',
    ].join('\n');
    fs.writeFileSync(path.join(d, 'config.toml'), toml);
    env.CODEX_HOME = d;
    return { env, cmd: ['codex', 'exec', '-C', repo, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '-m', model, task] };
  }
  if (agent === 'qwen') {
    env.QWEN_CODE_SUPPRESS_YOLO_WARNING = '1';
    return {
      env,
      cmd: ['qwen', '-y', '--bare', '--auth-type', 'openai', '--openai-base-url', `${base}/v1`, '--openai-api-key', 'ollama', '-m', model, '--output-format', 'stream-json', '--max-tool-calls', String(MAX_TOOLS), task],
    };
  }
  if (agent === 'dsh') {
    const patch = path.join(tmp, 'dsh-ollama.yml');
    fs.writeFileSync(patch, ollama.buildDshPatchYaml(base, [mInfo], model, { disableTitleLlm: true }));
    delete env.DEEPSEEK_BASE_URL;
    delete env.DEEPSEEK_API_KEY;
    env.OLLAMA_API_KEY = 'ollama';
    return { env, cmd: ['dsh', '--profile', 'headless', '--patch', patch, '--json', '--approval-policy', 'never', task] };
  }
  throw new Error(`Unsupported CLI for Ollama test: ${agent}`);
}

async function runOne(model, agent, mode = 'coding') {
  const base = ollama.ollamaUrl();
  if (!base) throw new Error('No Ollama URL configured');
  const mInfo = { name: model, ...(await ollama.describeModel(model)) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  makeRepo(repo);
  const task = mode === 'tool_smoke' ? SMOKE_TASK : CODING_TASK;
  const { env, cmd } = buildCliCommand(agent, model, base, mInfo, tmp, repo, task);
  const sumFile = path.join(tmp, 'summary.json');
  const started = Date.now();
  let timedOut = false, stderr = '';
  try {
    await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [STREAM, '--agent', agent, '--loop', String(LOOP_LIMIT), '--max-tools', String(MAX_TOOLS), '--summary', sumFile, '--', ...cmd],
        { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      current.child = child;
      const add = (s) => {
        for (const l of s.split('\n')) {
          if (l.trim()) {
            current.live.push(l.slice(0, 300));
            if (current.live.length > 50) current.live.shift();
          }
        }
      };
      child.stdout.setEncoding('utf8'); child.stdout.on('data', add);
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2500); });
      const timer = setTimeout(() => { timedOut = true; killTree(child, 'SIGTERM'); setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref(); }, TIMEOUT_S * 1000);
      child.on('close', () => { clearTimeout(timer); resolve(); });
    });
    let sum = {};
    try { sum = JSON.parse(fs.readFileSync(sumFile, 'utf8')); } catch {}
    sum.secs ??= Math.round((Date.now() - started) / 1000);
    sum.tools ??= 0;
    sum.stderr = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' | ') || '';
    const chk = checkEdit(repo);
    if (current.cancel) return null;
    const v = verdict(sum, chk, timedOut, mode);
    return {
      ...v,
      mode,
      secs: sum.secs,
      tools: sum.tools,
      maxPromptTokens: sum.maxPromptTokens || 0,
      calls: (sum.calls || []).slice(0, 30),
      errors: (sum.errors || []).slice(0, 10),
      loop: sum.loop || null,
      lastText: (sum.lastText || '').slice(0, 400),
      diff: mode === 'coding' ? chk.diff : '',
      at: Date.now(),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pump() {
  if (current || !queue.length) return;
  const { model, agent, mode } = queue.shift();
  current = { model, agent, mode, startedAt: Date.now(), live: [] };
  try {
    const r = await runOne(model, agent, mode);
    if (r) { (results[model] ||= {})[agent] = r; save(); }
  } catch (e) {
    (results[model] ||= {})[agent] = { verdict: 'error', mode, text: e.message, errors: [e.message], tools: 0, secs: 0, at: Date.now() };
    save();
  } finally {
    current = null;
    setImmediate(pump);
  }
}

function register(app, wrap, helpers) {
  load();

  app.get('/api/ollama/tests', wrap(async (req, res) => {
    res.json({
      results,
      queue,
      running: current && { model: current.model, agent: current.agent, mode: current.mode, startedAt: current.startedAt, live: current.live.slice(-16) },
      timeoutSeconds: TIMEOUT_S,
      agents: ollama.OLLAMA_CLIS,
      unsupportedAgents: ollama.UNSUPPORTED_OLLAMA_CLIS,
    });
  }));

  app.post('/api/ollama/tests', wrap(async (req, res) => {
    const models = Array.isArray(req.body?.models) && req.body.models.length
      ? req.body.models.map(String)
      : (req.body?.model ? [String(req.body.model)] : []);
    const agents = (Array.isArray(req.body?.agents) && req.body.agents.length ? req.body.agents : AGENT_KEYS).map(String);
    const mode = MODES.includes(req.body?.mode) ? req.body.mode : 'coding';
    if (!models.length || !models.every((m) => ollama.MODEL_RE.test(m)) || !agents.every((a) => AGENTS[a])) {
      throw new Error('invalid test request');
    }
    let queued = 0;
    for (const model of models) {
      for (const agent of agents) {
        if ((current?.model === model && current?.agent === agent) || queue.some((q) => q.model === model && q.agent === agent)) continue;
        queue.push({ model, agent, mode });
        queued++;
      }
    }
    pump();
    res.json({ ok: true, queued });
  }));

  app.post('/api/ollama/tests/cancel', wrap(async (req, res) => {
    queue.length = 0;
    if (current?.child) {
      const c = current.child;
      current.cancel = true;
      killTree(c, 'SIGTERM');
      setTimeout(() => killTree(c, 'SIGKILL'), 5000).unref();
    }
    res.json({ ok: true });
  }));

  app.delete('/api/ollama/tests', wrap(async (req, res) => {
    const model = req.body?.model ? String(req.body.model) : '';
    const agent = req.body?.agent ? String(req.body.agent) : '';
    if (model && agent && results[model]) {
      delete results[model][agent];
      if (!Object.keys(results[model]).length) delete results[model];
    } else if (model) {
      delete results[model];
    } else {
      results = {};
    }
    save();
    res.json({ ok: true });
  }));
}

module.exports = { register, verdict, buildCliCommand, AGENTS, AGENT_KEYS, SMOKE_TOKEN };
