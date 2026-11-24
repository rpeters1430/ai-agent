'use strict';
// Ollama integration: connection settings, model discovery, and multi-CLI config generation
// for OpenCode, Pi, Claude Code, Codex, Qwen Code, and DeepSeek Harness (dsh).
const fs = require('fs');
const path = require('path');
const { notFound } = require('./errors');

const HOME = process.env.HOME || '/home/dev';
const HUB_DIR = path.join(HOME, '.agent-hub');
const SETTINGS_FILE = path.join(HUB_DIR, 'settings.json');
const OPENCODE_FILE = path.join(HOME, '.config', 'opencode', 'opencode.json');
const PI_DIR = process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent');
const PI_MODELS_FILE = path.join(PI_DIR, 'models.json');
const PI_SETTINGS_FILE = path.join(PI_DIR, 'settings.json');
const CODEX_CONFIG_FILE = path.join(HOME, '.codex', 'config.toml');
const DSH_PATCH_FILE = path.join(HUB_DIR, 'dsh-ollama.yml');
const PROVIDER_ID = 'ollama';
const CODEX_PROVIDER_ID = 'ollama-hub'; // Codex 0.171 reserves "ollama" as a built-in provider ID
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$/;
const DEFAULT_OLLAMA_CTX = 8192; // what Ollama uses when nothing sets num_ctx (varies by version/VRAM)

const OLLAMA_CLIS = {
  pi:       { label: 'Pi',               short: 'Pi',     protocol: 'OpenAI Chat (/v1)',      configHint: '~/.pi/agent/models.json' },
  opencode: { label: 'OpenCode',         short: 'OC',     protocol: 'OpenAI Chat (/v1)',      configHint: '~/.config/opencode/opencode.json' },
  claude:   { label: 'Claude Code',      short: 'Claude', protocol: 'Anthropic (/v1/messages)', configHint: 'ANTHROPIC_BASE_URL per-session' },
  codex:    { label: 'Codex',            short: 'Codex',  protocol: 'OpenAI Responses (/v1)', configHint: '~/.codex/config.toml (ollama-hub)' },
  qwen:     { label: 'Qwen Code',        short: 'Qwen',   protocol: 'OpenAI Chat (/v1)',      configHint: '--auth-type openai per-session' },
  dsh:      { label: 'DeepSeek Harness', short: 'DSH',    protocol: 'OpenAI Chat (pi-ai)',    configHint: '~/.agent-hub/dsh-ollama.yml' },
};
const OLLAMA_CLI_KEYS = Object.keys(OLLAMA_CLIS);
const UNSUPPORTED_OLLAMA_CLIS = {
  gemini: { label: 'Gemini CLI',  reason: 'Uses Google Gemini / Vertex / local LiteRT-LM (no Ollama adapter)' },
  agy:    { label: 'Antigravity', reason: 'Uses Antigravity managed cloud models only' },
};

// ---------------------------------------------------------------- files ----
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not plain JSON (${e.message}); fix or remove it first`);
  }
}
function writeJson(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}
const settings = () => readJson(SETTINGS_FILE, {});
function saveSettings(patch) { writeJson(SETTINGS_FILE, { ...settings(), ...patch }, 0o600); }

function ollamaUrl() {
  const s = settings();
  return (s.ollama?.url || process.env.OLLAMA_URL || '').replace(/\/+$/, '');
}

// ------------------------------------------------------------------ API ----
async function ollamaFetch(p, opts = {}, base = ollamaUrl()) {
  if (!base) throw new Error('No Ollama URL configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
  try {
    const r = await fetch(base + p, { ...opts, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Ollama ${p} → HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timed out reaching ${base}`);
    const code = e.cause?.code || e.cause?.errors?.[0]?.code;
    if (code || e.message === 'fetch failed') {
      const hint = code === 'ECONNREFUSED' ? ' — is Ollama running with OLLAMA_HOST=0.0.0.0 on that PC?'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? ' — hostname not found; try the IP address'
        : code === 'EHOSTUNREACH' || code === 'ENETUNREACH' ? ' — no route to that address from the NAS' : '';
      throw new Error(`Cannot reach ${base} (${code || e.cause?.message || 'network error'})${hint}`);
    }
    throw e;
  } finally { clearTimeout(t); }
}

function parseNumCtx(parameters) {
  const m = /(^|\n)\s*num_ctx\s+(\d+)/.exec(parameters || '');
  return m ? Number(m[2]) : null;
}

async function describeModel(name) {
  const info = await (await ollamaFetch('/api/show', { method: 'POST', body: JSON.stringify({ model: name }) })).json();
  const mi = info.model_info || {};
  const ctxKey = Object.keys(mi).find((k) => k.endsWith('.context_length'));
  const caps = info.capabilities || [];
  return {
    caps,
    ctxMax: ctxKey ? Number(mi[ctxKey]) : null,
    numCtx: parseNumCtx(info.parameters),
    tools: caps.includes('tools'),
    vision: caps.includes('vision'),
    thinking: caps.includes('thinking'),
    family: info.details?.family,
    params: info.details?.parameter_size,
    quant: info.details?.quantization_level,
  };
}

async function listModels() {
  const tags = await (await ollamaFetch('/api/tags')).json();
  const models = await Promise.all((tags.models || []).map(async (m) => {
    let d = {};
    try { d = await describeModel(m.name); } catch (e) { d = { error: e.message }; }
    const out = { name: m.name, size: m.size, modified: m.modified_at, ...d };
    out.cloud = /cloud/.test(m.name) || m.remote_host != null;
    if (d.caps) out.usage = usage(d.caps, effectiveCtx(out));
    return out;
  }));
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

// Context the agent should assume: what Ollama will actually allocate.
const serverCtx = () => Number(settings().ollama?.serverCtx) || DEFAULT_OLLAMA_CTX;
const effectiveCtx = (m) => m.numCtx || serverCtx();

// ----------------------------------------------------------- configure ----
function applied() {
  let oc = {}, pi = {}, piS = {};
  try { oc = readJson(OPENCODE_FILE, {}); } catch {}
  try { pi = readJson(PI_MODELS_FILE, {}); } catch {}
  try { piS = readJson(PI_SETTINGS_FILE, {}); } catch {}
  const cliModels = settings().ollama?.cliModels || {};
  const cliDefaults = settings().ollama?.cliDefaults || {};
  const customOc = [];
  for (const [pid, p] of Object.entries(oc.provider || {})) {
    if (pid === PROVIDER_ID) continue;
    for (const mid of Object.keys(p?.models || {})) customOc.push(`${pid}/${mid}`);
  }
  const customPi = [];
  for (const [pid, p] of Object.entries(pi.providers || {})) {
    if (pid === PROVIDER_ID) continue;
    for (const m of p?.models || []) if (m?.id) customPi.push(`${pid}/${m.id}`);
  }
  const cleanList = (arr) => (Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && MODEL_RE.test(x)) : []);
  return {
    opencode: Object.keys(oc.provider?.[PROVIDER_ID]?.models || {}),
    opencodeDefault: oc.model?.startsWith(PROVIDER_ID + '/') ? oc.model.slice(PROVIDER_ID.length + 1) : null,
    pi: (pi.providers?.[PROVIDER_ID]?.models || []).map((m) => m.id),
    piDefault: piS.defaultProvider === PROVIDER_ID ? piS.defaultModel : null,
    claude: cleanList(cliModels.claude),
    claudeDefault: cliDefaults.claude || null,
    codex: cleanList(cliModels.codex),
    codexDefault: cliDefaults.codex || null,
    qwen: cleanList(cliModels.qwen),
    qwenDefault: cliDefaults.qwen || null,
    dsh: cleanList(cliModels.dsh),
    dshDefault: cliDefaults.dsh || null,
    custom: { opencode: customOc, pi: customPi },
  };
}

const opencodeProvider = (base, models) => ({
  npm: '@ai-sdk/openai-compatible',
  name: 'Ollama',
  options: { baseURL: `${base}/v1` },
  models: Object.fromEntries(models.map((m) => [m.name, {
    name: `${m.name}${m.params ? ` (${m.params})` : ''}`,
    tool_call: m.tools !== false,
    reasoning: !!m.thinking,
    limit: { context: effectiveCtx(m), output: Math.min(8192, Math.floor(effectiveCtx(m) / 2)) },
  }])),
});
const piProvider = (base, models) => ({
  baseUrl: `${base}/v1`,
  api: 'openai-completions',
  apiKey: 'ollama',
  models: models.map((m) => ({
    id: m.name,
    name: `${m.name}${m.params ? ` (${m.params})` : ''}`,
    reasoning: !!m.thinking,
    input: m.vision ? ['text', 'image'] : ['text'],
    contextWindow: effectiveCtx(m),
    maxTokens: Math.min(8192, Math.floor(effectiveCtx(m) / 2)),
  })),
});

function yamlStr(s) {
  return JSON.stringify(String(s ?? ''));
}

function buildDshPatchYaml(base, models, defaultModel, opts = {}) {
  const lines = [
    '# Generated by Agent Hub — Ollama provider for DeepSeek Harness (dsh)',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${PROVIDER_ID}:`,
    '        displayName: Ollama',
    '        api: openai-completions',
    `        baseURL: ${yamlStr(`${base}/v1`)}`,
    '        apiKeyEnv: OLLAMA_API_KEY',
    '        models:',
  ];
  for (const m of models) {
    const ctx = effectiveCtx(m);
    const maxTok = Math.min(8192, Math.floor(ctx / 2));
    lines.push(
      `          - id: ${yamlStr(m.name)}`,
      `            name: ${yamlStr(`${m.name}${m.params ? ` (${m.params})` : ''}`)}`,
      `            contextWindow: ${ctx}`,
      `            maxTokens: ${maxTok}`,
    );
  }
  if (defaultModel) {
    lines.push(
      '- id: agent-default-model',
      '  config:',
      `    provider: ${PROVIDER_ID}`,
      `    model: ${yamlStr(defaultModel)}`,
    );
  }
  if (opts.disableTitleLlm) {
    lines.push(
      '- id: session-title-llm',
      '  disabled: true',
    );
  }
  return lines.join('\n') + '\n';
}

function buildCodexProviderToml(base) {
  return [
    '# --- agent-hub ollama start ---',
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "Ollama"',
    `base_url = ${JSON.stringify(`${base}/v1`)}`,
    'wire_api = "responses"',
    '# --- agent-hub ollama end ---',
  ].join('\n');
}

function configureOpenCode(base, models, def) {
  const cfg = readJson(OPENCODE_FILE, {});
  cfg.$schema ||= 'https://opencode.ai/config.json';
  cfg.provider ||= {};
  cfg.provider[PROVIDER_ID] = opencodeProvider(base, models);
  if (def) cfg.model = `${PROVIDER_ID}/${def}`;
  else if (cfg.model?.startsWith(PROVIDER_ID + '/') && !models.some((m) => `${PROVIDER_ID}/${m.name}` === cfg.model)) delete cfg.model;
  writeJson(OPENCODE_FILE, cfg);
}

function configurePi(base, models, def) {
  const cfg = readJson(PI_MODELS_FILE, {});
  cfg.$schema ||= 'https://pi.dev/schemas/models.schema.json';
  cfg.providers ||= {};
  cfg.providers[PROVIDER_ID] = piProvider(base, models);
  writeJson(PI_MODELS_FILE, cfg);
  const s = readJson(PI_SETTINGS_FILE, {});
  if (def) { s.defaultProvider = PROVIDER_ID; s.defaultModel = def; writeJson(PI_SETTINGS_FILE, s); }
  else if (s.defaultProvider === PROVIDER_ID && !models.some((m) => m.name === s.defaultModel)) {
    delete s.defaultProvider; delete s.defaultModel; writeJson(PI_SETTINGS_FILE, s);
  }
}

function saveCliList(cliKey, models, def) {
  const s = settings();
  const olm = { ...(s.ollama || {}) };
  olm.cliModels = { ...(olm.cliModels || {}), [cliKey]: models.map((m) => m.name) };
  olm.cliDefaults = { ...(olm.cliDefaults || {}) };
  if (def) olm.cliDefaults[cliKey] = def;
  else if (olm.cliDefaults[cliKey] && !models.some((m) => m.name === olm.cliDefaults[cliKey])) delete olm.cliDefaults[cliKey];
  saveSettings({ ollama: olm });
}

function configureCodex(base, models, def) {
  fs.mkdirSync(path.dirname(CODEX_CONFIG_FILE), { recursive: true });
  let existing = '';
  try { existing = fs.readFileSync(CODEX_CONFIG_FILE, 'utf8'); } catch {}
  if (fs.existsSync(CODEX_CONFIG_FILE)) fs.copyFileSync(CODEX_CONFIG_FILE, CODEX_CONFIG_FILE + '.bak');
  const cleaned = existing.replace(/\n?# --- agent-hub ollama start ---[\s\S]*?# --- agent-hub ollama end ---\n?/g, '\n').trim();
  const block = models.length ? buildCodexProviderToml(base) : '';
  const next = [cleaned, block].filter(Boolean).join('\n\n') + '\n';
  const tmp = CODEX_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, CODEX_CONFIG_FILE);
  saveCliList('codex', models, def);
}

function configureDsh(base, models, def) {
  fs.mkdirSync(path.dirname(DSH_PATCH_FILE), { recursive: true });
  const chosenDefault = def || models[0]?.name || '';
  if (models.length) {
    const tmp = DSH_PATCH_FILE + '.tmp';
    fs.writeFileSync(tmp, buildDshPatchYaml(base, models, chosenDefault), { mode: 0o600 });
    fs.renameSync(tmp, DSH_PATCH_FILE);
  } else if (fs.existsSync(DSH_PATCH_FILE)) {
    try { fs.unlinkSync(DSH_PATCH_FILE); } catch {}
  }
  saveCliList('dsh', models, def);
}

function configureScopedCli(cliKey, models, def) {
  saveCliList(cliKey, models, def);
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Builds an interactive shell command for launching any Ollama-capable CLI with a selected model.
function buildInteractiveCmd(agent, model, opts = {}) {
  const base = ollamaUrl();
  const yolo = !!opts.yolo;
  const slash = model.indexOf('/');
  const hasProv = slash > 0 && !model.startsWith('hf.co/') && /^[a-z0-9_-]+$/.test(model.slice(0, slash));
  const prov = hasProv ? model.slice(0, slash) : PROVIDER_ID;
  const mid = hasProv ? model.slice(slash + 1) : model;

  if (agent === 'opencode') return `opencode -m ${shQuote(`${prov}/${mid}`)}`;
  if (agent === 'pi') return `pi --provider ${shQuote(prov)} --model ${shQuote(mid)}`;
  if (!base) throw new Error('Set the Ollama URL in the Models tab first');
  if (agent === 'claude') {
    const flag = yolo ? ' --dangerously-skip-permissions' : '';
    return `ANTHROPIC_BASE_URL=${shQuote(base)} ANTHROPIC_AUTH_TOKEN='ollama' ANTHROPIC_API_KEY='ollama' claude${flag} --model ${shQuote(model)}`;
  }
  if (agent === 'codex') {
    const flag = yolo ? ' --dangerously-bypass-approvals-and-sandbox' : '';
    const provCfg = `model_providers.${CODEX_PROVIDER_ID}={name="Ollama",base_url="${base}/v1",wire_api="responses"}`;
    return `codex${flag} -c ${shQuote(`model_provider="${CODEX_PROVIDER_ID}"`)} -c ${shQuote(provCfg)} -m ${shQuote(model)}`;
  }
  if (agent === 'qwen') {
    const flag = yolo ? ' -y' : '';
    return `qwen${flag} --auth-type openai --openai-base-url ${shQuote(`${base}/v1`)} --openai-api-key 'ollama' -m ${shQuote(model)}`;
  }
  if (agent === 'dsh') {
    const patch = path.join(HUB_DIR, `dsh-session-${process.pid}-${Date.now()}.yml`);
    fs.mkdirSync(HUB_DIR, { recursive: true });
    fs.writeFileSync(patch, buildDshPatchYaml(base, [{ name: model }], model), { mode: 0o600 });
    return `env -u DEEPSEEK_BASE_URL -u DEEPSEEK_API_KEY OLLAMA_API_KEY='ollama' dsh --profile web --patch ${shQuote(patch)} --no-open`;
  }
  throw new Error(`${agent} does not support local Ollama models`);
}

// ---------------------------------------------------------------- pulls ----
const pulls = new Map(); // name -> { status, completed, total, error, done }
async function startPull(name) {
  if (pulls.get(name) && !pulls.get(name).done) return;
  const st = { status: 'starting', completed: 0, total: 0, done: false };
  pulls.set(name, st);
  try {
    const r = await ollamaFetch('/api/pull', { method: 'POST', body: JSON.stringify({ model: name, stream: true }), timeout: 6 * 60 * 60 * 1000 });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        st.status = ev.status || st.status;
        if (ev.total) { st.total = ev.total; st.completed = ev.completed || 0; }
      }
    }
    st.status = 'success';
  } catch (e) { st.error = e.message; st.status = 'error'; }
  st.done = true;
}

// -------------------------------------------------------------- catalog ----
// ollama.com has no public catalog API, so read its search and tags pages (cached).
const catalogCache = new Map();
async function fetchCached(url, ttl = 30 * 60 * 1000) {
  const hit = catalogCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.body;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'agent-hub', Accept: 'text/html' } });
    if (!r.ok) throw new Error(`ollama.com returned HTTP ${r.status}`);
    const body = await r.text();
    catalogCache.set(url, { at: Date.now(), body });
    if (catalogCache.size > 200) catalogCache.delete(catalogCache.keys().next().value);
    return body;
  } catch (e) {
    if (hit) return hit.body; // stale is better than nothing
    throw new Error(e.name === 'AbortError' ? 'ollama.com timed out' : `Could not load ollama.com (${e.message})`);
  } finally { clearTimeout(t); }
}
const unescape = (s) => s.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// What the model is good for inside Agent Hub.
function usage(caps, ctx) {
  const c = new Set(caps);
  if (c.has('embedding')) return { level: 'none', text: 'Embedding model — turns text into vectors for search/RAG. Not for chat or coding agents.' };
  if (!c.has('tools')) return { level: 'chat', text: 'Chat only — no tool calling, so coding CLIs can’t edit files or run commands with it. Fine for Q&A.' };
  const extras = [c.has('thinking') && 'reasons step by step (thinking)', c.has('vision') && 'reads screenshots/images'].filter(Boolean);
  const small = ctx && ctx < 16384;
  return {
    level: small ? 'limited' : 'agent',
    text: `Works as a coding agent across Ollama-compatible CLIs (Pi, OpenCode, Claude, Codex, Qwen, DSH) — can read/edit files and run commands${extras.length ? ', ' + extras.join(', ') : ''}.` +
      (small ? ` Its ${Math.round(ctx / 1024)}k context is small for agent work.` : ''),
  };
}

function parseSearch(html) {
  const out = [];
  for (const card of html.split('<li').slice(1)) {
    const m = /href="\/library\/([A-Za-z0-9._-]+)"/.exec(card);
    if (!m) continue; // community (namespaced) models are skipped
    const spans = [...card.matchAll(/<span\s+class="inline-flex items-center rounded-md ([^"]*)"\s*>\s*([^<]+?)\s*<\/span>/g)];
    const caps = spans.filter((s) => s[1].includes('indigo')).map((s) => s[2].trim());
    const sizes = spans.filter((s) => s[1].includes('ddf4ff')).map((s) => s[2].trim());
    const cloud = spans.some((s) => s[1].includes('cyan') && /cloud/i.test(s[2]));
    const desc = /<p class="[^"]*">([\s\S]*?)<\/p>/.exec(card);
    const ctx = /title="Context window">[\s\S]*?<span\s*>([^<]+)<\/span>/.exec(card);
    const dl = /title="([\d,]+) downloads"/.exec(card);
    const updated = /title="Updated ([^"]+)"/.exec(card);
    out.push({
      name: m[1], description: desc ? unescape(desc[1]) : '', caps, sizes, cloud,
      context: ctx ? ctx[1].trim() : null, downloads: dl ? Number(dl[1].replace(/,/g, '')) : null,
      updated: updated ? updated[1] : null, usage: usage(caps),
    });
  }
  return out;
}

function parseCtx(s) { const m = /([\d.]+)\s*([KM])/i.exec(s || ''); return m ? Math.round(Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1048576 : 1024)) : null; }

function parseTags(html, name) {
  const re = new RegExp(`<a href="/library/${name.replace(/[.]/g, '\\.')}:([A-Za-z0-9._-]+)" class="md:hidden[\\s\\S]*?</a>`, 'g');
  const tags = [];
  for (const m of html.matchAll(re)) {
    const text = unescape(m[0]);
    const size = /•\s*([\d.]+\s*[KMGT]?B)\s*•/.exec(text);
    const ctx = /([\d.]+[KM])\s*context window/i.exec(text);
    const input = /•\s*((?:Text|Image|Audio|Video)(?:,\s*(?:Text|Image|Audio|Video))*)\s*input/i.exec(text);
    tags.push({
      tag: m[1], model: `${name}:${m[1]}`, size: size ? size[1].replace(/\s+/g, '') : null,
      context: ctx ? ctx[1] : null, contextTokens: parseCtx(ctx?.[1]),
      input: input ? input[1] : 'Text', latest: /\blatest\b/.test(text), cloud: /cloud/.test(m[1]),
    });
  }
  return tags;
}

// --------------------------------------------------------------- routes ----
function register(app, wrap) {
  app.get('/api/ollama/catalog', wrap(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 80);
    const c = ['tools', 'vision', 'thinking', 'embedding', 'cloud'].includes(req.query.c) ? req.query.c : '';
    const page = Math.max(1, Math.min(20, Number(req.query.p) || 1));
    const qs = new URLSearchParams({ ...(q && { q }), ...(c && { c }), ...(page > 1 && { p: String(page) }) });
    const models = parseSearch(await fetchCached(`https://ollama.com/search?${qs}`));
    res.json({ models, page, more: models.length >= 20 });
  }));

  app.get('/api/ollama/catalog/:name', wrap(async (req, res) => {
    const name = req.params.name;
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid model');
    const [tagsHtml, search] = await Promise.all([
      fetchCached(`https://ollama.com/library/${name}/tags`),
      fetchCached(`https://ollama.com/search?q=${encodeURIComponent(name)}`).then(parseSearch).catch(() => []),
    ]);
    const info = search.find((m) => m.name === name) || { name, caps: [], sizes: [] };
    const tags = parseTags(tagsHtml, name).map((t) => ({ ...t, usage: usage(info.caps, t.contextTokens) }));
    res.json({ ...info, tags });
  }));

  app.get('/api/ollama/pulls', wrap(async (req, res) => {
    res.json({ pulls: Object.fromEntries(pulls) });
  }));

  app.get('/api/ollama', wrap(async (req, res) => {
    const url = ollamaUrl();
    const out = {
      url, connected: false, applied: applied(), pulls: Object.fromEntries(pulls),
      serverCtx: serverCtx(), clis: OLLAMA_CLIS, unsupportedClis: UNSUPPORTED_OLLAMA_CLIS,
    };
    if (!url) return res.json(out);
    try {
      const [ver, models, ps] = await Promise.all([
        ollamaFetch('/api/version').then((r) => r.json()),
        listModels(),
        ollamaFetch('/api/ps').then((r) => r.json()).catch(() => ({ models: [] })),
      ]);
      out.version = ver.version;
      out.models = models;
      out.running = (ps.models || []).map((m) => ({
        name: m.name, size: m.size, vram: m.size_vram || 0, contextLength: m.context_length || null,
      }));
      out.connected = true;
    } catch (e) { out.error = e.message; }
    res.json(out);
  }));

  app.post('/api/ollama/url', wrap(async (req, res) => {
    let url = String(req.body?.url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    if (url && !/^https?:\/\//.test(url)) url = 'http://' + url;
    if (url && !/:\d+$/.test(new URL(url).host) && new URL(url).protocol === 'http:') url += ':11434';
    if (url) {
      const v = await (await ollamaFetch('/api/version', {}, url)).json(); // must be reachable before saving
      saveSettings({ ollama: { ...(settings().ollama || {}), url } });
      return res.json({ ok: true, url, version: v.version });
    }
    saveSettings({ ollama: { ...(settings().ollama || {}), url: '' } });
    res.json({ ok: true, url: '' });
  }));

  app.post('/api/ollama/server-ctx', wrap(async (req, res) => {
    const n = Number(req.body?.serverCtx);
    if (!Number.isInteger(n) || n < 2048 || n > 1048576) throw new Error('context must be 2048–1048576');
    saveSettings({ ollama: { ...(settings().ollama || {}), serverCtx: n } });
    res.json({ ok: true });
  }));

  app.post('/api/ollama/apply', wrap(async (req, res) => {
    const base = ollamaUrl();
    if (!base) throw new Error('Set the Ollama URL first');
    const names = (req.body?.models || []).map(String);
    const targets = (req.body?.targets || []).filter((t) => OLLAMA_CLI_KEYS.includes(t));
    const def = req.body?.default ? String(req.body.default) : '';
    if (!targets.length) throw new Error('Pick at least one CLI target');
    if (names.some((n) => !MODEL_RE.test(n)) || (def && !names.includes(def))) throw new Error('invalid model selection');
    const all = await listModels();
    const chosen = all.filter((m) => names.includes(m.name));
    if (targets.includes('opencode')) configureOpenCode(base, chosen, def);
    if (targets.includes('pi')) configurePi(base, chosen, def);
    if (targets.includes('codex')) configureCodex(base, chosen, def);
    if (targets.includes('dsh')) configureDsh(base, chosen, def);
    if (targets.includes('claude')) configureScopedCli('claude', chosen, def);
    if (targets.includes('qwen')) configureScopedCli('qwen', chosen, def);
    res.json({ ok: true, applied: applied() });
  }));

  // Copy a model with a bigger num_ctx so agents get enough context for tool calls.
  app.post('/api/ollama/variant', wrap(async (req, res) => {
    const from = String(req.body?.model || '');
    const ctx = Number(req.body?.num_ctx || 32768);
    if (!MODEL_RE.test(from) || ![8192, 16384, 32768, 65536, 131072].includes(ctx)) throw new Error('invalid request');
    const [repo, tag = 'latest'] = from.split(':');
    const name = `${repo}:${tag.replace(/-ctx\d+k$/, '')}-ctx${ctx / 1024}k`;
    const r = await ollamaFetch('/api/create', { method: 'POST', body: JSON.stringify({ model: name, from, parameters: { num_ctx: ctx }, stream: false }), timeout: 5 * 60 * 1000 });
    const body = await r.json().catch(() => ({}));
    if (body.error) throw new Error(body.error);
    res.json({ ok: true, name });
  }));

  app.post('/api/ollama/pull', wrap(async (req, res) => {
    const name = String(req.body?.model || '').trim();
    if (!MODEL_RE.test(name)) throw new Error('invalid model name');
    startPull(name);
    res.json({ ok: true });
  }));

  app.delete('/api/ollama/models', wrap(async (req, res) => {
    const name = String(req.body?.model || '');
    if (!MODEL_RE.test(name)) throw new Error('invalid model name');
    await ollamaFetch('/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) });
    res.json({ ok: true });
  }));

  // ---- Custom OpenAI-Compatible Providers (LM Studio, llama.cpp, vLLM, OpenRouter, DeepSeek, etc.) ----
  const PROV_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
  const customProviders = () => Array.isArray(settings().customProviders) ? settings().customProviders : [];
  const maskKey = (k) => (!k ? '' : k.length <= 8 ? '••••' : `${k.slice(0, 4)}••••${k.slice(-4)}`);

  app.get('/api/providers', wrap(async (req, res) => {
    const list = customProviders().map((p) => ({ ...p, apiKey: maskKey(p.apiKey), hasKey: !!p.apiKey }));
    res.json({ providers: list, applied: applied() });
  }));

  app.post('/api/providers/discover', wrap(async (req, res) => {
    let baseUrl = String(req.body?.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');
    const id = String(req.body?.id || '').trim().toLowerCase();
    let apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey || apiKey.includes('••••')) {
      apiKey = customProviders().find((p) => p.id === id)?.apiKey || '';
    }
    const r = await fetch(`${baseUrl}/models`, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Provider /models returned HTTP ${r.status}`);
    const body = await r.json();
    const raw = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    const models = raw.map((m) => String(m.id || m.name || '')).filter((m) => m && MODEL_RE.test(m)).sort();
    res.json({ ok: true, models });
  }));

  app.post('/api/providers', wrap(async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').trim().toLowerCase();
    if (!PROV_ID_RE.test(id) || id === PROVIDER_ID) throw new Error('Provider ID must be lowercase letters/digits/-/_ (and not "ollama")');
    const name = String(b.name || id).trim().slice(0, 60);
    const baseUrl = String(b.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('Base URL must start with http:// or https://');
    const list = customProviders();
    const prev = list.find((p) => p.id === id);
    let apiKey = b.apiKey === undefined ? (prev?.apiKey || '') : String(b.apiKey || '').trim();
    if (apiKey.includes('••••')) apiKey = prev?.apiKey || '';
    const ctxLen = Math.max(4096, Math.min(1048576, Number(b.contextWindow) || 32768));
    const models = (Array.isArray(b.models) ? b.models : String(b.models || '').split(/[\n,]+/))
      .map((s) => String(s).trim()).filter(Boolean);
    if (models.some((m) => !MODEL_RE.test(m))) throw new Error('One or more model IDs contain invalid characters');
    const entry = { id, name, baseUrl, apiKey, contextWindow: ctxLen, models: [...new Set(models)] };
    const next = list.filter((p) => p.id !== id).concat(entry);
    saveSettings({ customProviders: next });
    res.json({ ok: true, provider: { ...entry, apiKey: maskKey(entry.apiKey), hasKey: !!entry.apiKey } });
  }));

  app.post('/api/providers/:id/apply', wrap(async (req, res) => {
    const id = String(req.params.id || '').toLowerCase();
    const p = customProviders().find((x) => x.id === id);
    if (!p) throw notFound('provider not found');
    const targets = (Array.isArray(req.body?.targets) && req.body.targets.length ? req.body.targets : ['opencode', 'pi'])
      .filter((t) => t === 'opencode' || t === 'pi');
    if (!targets.length) throw new Error('Pick OpenCode and/or Pi');
    if (!p.models.length) throw new Error('Add at least one model ID to this provider first');
    const ctxLen = p.contextWindow || 32768;
    const outMax = Math.min(8192, Math.floor(ctxLen / 2));

    if (targets.includes('opencode')) {
      const cfg = readJson(OPENCODE_FILE, {});
      cfg.$schema ||= 'https://opencode.ai/config.json';
      cfg.provider ||= {};
      cfg.provider[id] = {
        npm: '@ai-sdk/openai-compatible',
        name: p.name,
        options: { baseURL: p.baseUrl, ...(p.apiKey ? { apiKey: p.apiKey } : {}) },
        models: Object.fromEntries(p.models.map((m) => [m, { name: m, tool_call: true, limit: { context: ctxLen, output: outMax } }])),
      };
      writeJson(OPENCODE_FILE, cfg);
    }
    if (targets.includes('pi')) {
      const cfg = readJson(PI_MODELS_FILE, {});
      cfg.$schema ||= 'https://pi.dev/schemas/models.schema.json';
      cfg.providers ||= {};
      cfg.providers[id] = {
        baseUrl: p.baseUrl,
        api: 'openai-completions',
        apiKey: p.apiKey || id,
        models: p.models.map((m) => ({ id: m, name: m, input: ['text'], contextWindow: ctxLen, maxTokens: outMax })),
      };
      writeJson(PI_MODELS_FILE, cfg);
    }
    res.json({ ok: true, applied: applied() });
  }));

  app.delete('/api/providers/:id', wrap(async (req, res) => {
    const id = String(req.params.id || '').toLowerCase();
    saveSettings({ customProviders: customProviders().filter((p) => p.id !== id) });
    try {
      const oc = readJson(OPENCODE_FILE, {});
      if (oc.provider?.[id]) { delete oc.provider[id]; writeJson(OPENCODE_FILE, oc); }
    } catch {}
    try {
      const pi = readJson(PI_MODELS_FILE, {});
      if (pi.providers?.[id]) { delete pi.providers[id]; writeJson(PI_MODELS_FILE, pi); }
    } catch {}
    res.json({ ok: true, applied: applied() });
  }));
}

module.exports = {
  register, applied, MODEL_RE, PROVIDER_ID, CODEX_PROVIDER_ID, DSH_PATCH_FILE,
  OLLAMA_CLIS, OLLAMA_CLI_KEYS, UNSUPPORTED_OLLAMA_CLIS,
  ollamaUrl, describeModel, opencodeProvider, piProvider,
  buildDshPatchYaml, buildCodexProviderToml, buildInteractiveCmd,
  parseNumCtx, parseCtx, parseSearch, parseTags, usage, effectiveCtx,
};
