// Models tab: Ollama connection, model list, applying models to the CLIs, pulls.
import { state } from './state.js';
import { $, api, busy, h, m3Confirm, setRailBadge } from './core.js';
import { AGENT_LABEL, AGENT_SHORT, OLLAMA_CLIS_ORDER } from './agentinfo.js';
import { keepOpen } from './workspace.js';
import { openOllamaLab, renderLab } from './lab.js';
import { ago } from './automations.js';

let ollamaState = {};

const gb = (n) => (n / 1e9).toFixed(1) + ' GB';
const kctx = (n) => (n >= 1024 ? Math.round(n / 1024) + 'k' : String(n));

let testState = { results: {}, queue: [] };

 // { model, agent }
let labCliSelection = new Set(OLLAMA_CLIS_ORDER);

async function loadTests() {
  testState = await api('GET', '/api/ollama/tests');
  clearTimeout(state.testTimer);
  if (testState.running || testState.queue.length) {
    state.testTimer = setTimeout(() => loadTests().then(() => { renderOllamaModels(); renderLab(); }).catch(() => {}), 2500);
  }
  return testState;
}
const TEST_ICON = { pass: '✓', partial: '≈', loop: '↻', timeout: '⏱', no_tools: '✗', no_edit: '✗', wrong: '✗', error: '✗' };
const verdictClass = (v) => (v === 'pass' ? 'live' : v === 'partial' ? 'warn' : 'bad');

function testBadges(name) {
  const r = testState.results?.[name] || {}, run = testState.running;
  return OLLAMA_CLIS_ORDER.map((k) => {
    const l = AGENT_SHORT[k] || k;
    if (run?.model === name && run.agent === k) return h('span', { class: 'badge warn', title: `Testing ${AGENT_LABEL[k]} now` }, `${l} …`);
    if (testState.queue?.some((q) => q.model === name && q.agent === k)) return h('span', { class: 'badge', title: `${AGENT_LABEL[k]} queued` }, `${l} queued`);
    const t = r[k]; if (!t) return null;
    const cls = verdictClass(t.verdict);
    return h('span', {
      class: 'badge ' + cls,
      style: 'cursor:pointer',
      title: `${AGENT_LABEL[k]} (${t.mode || 'coding'}): ${t.text} — click to inspect in Lab`,
      onclick: () => openOllamaLab({ model: name, agent: k }),
    }, `${l} ${TEST_ICON[t.verdict] || '?'}${t.verdict === 'pass' ? ' ' + t.secs + 's' : ' ' + t.verdict.replace('_', ' ')}`);
  });
}

function testPanel(m) {
  const r = testState.results?.[m.name] || {}, run = testState.running?.model === m.name ? testState.running : null;
  const busyHere = run || testState.queue?.some((q) => q.model === m.name);
  const testedCount = OLLAMA_CLIS_ORDER.filter((k) => r[k]).length;
  return h('div', { class: 'olm-test' },
    h('div', { class: 'row' },
      h('button', { style: 'font-size:11px;padding:3px 8px', disabled: !!busyHere,
        title: 'Tests this model across all 6 Ollama-capable CLIs (Pi, OpenCode, Claude, Codex, Qwen, DSH) in throwaway repos.',
        onclick: (e) => busy(e.target, async () => { await api('POST', '/api/ollama/tests', { model: m.name, mode: state.labMode }); await loadTests(); renderOllamaModels(); renderLab(); }) },
        busyHere ? 'Testing…' : testedCount ? 'Re-test all 6 CLIs' : 'Test all 6 CLIs'),
      h('button', { style: 'font-size:11px;padding:3px 8px', class: 'tonal',
        onclick: () => openOllamaLab({ model: m.name, agent: OLLAMA_CLIS_ORDER.find((k) => r[k]) || 'pi' }) }, 'Lab matrix…'),
      busyHere && h('button', { style: 'font-size:11px;padding:3px 8px', onclick: (e) => busy(e.target, async () => { await api('POST', '/api/ollama/tests/cancel'); await loadTests(); renderOllamaModels(); renderLab(); }) }, 'Stop')),
    ...OLLAMA_CLIS_ORDER.map((k) => r[k] && h('div', { class: 'small' },
      h('b', {}, `${AGENT_SHORT[k]}: `), r[k].text, h('span', { class: 'muted' }, ` · ${ago(r[k].at)}`),
      r[k].verdict !== 'pass' && r[k].diff ? keepOpen(`oltd:${m.name}:${k}`, h('summary', {}, 'what it changed'), h('pre', { class: 'olm-live' }, r[k].diff)) : null)),
    run && h('div', { class: 'small muted' }, `${AGENT_LABEL[run.agent] || run.agent} running for ${Math.round((Date.now() - run.startedAt) / 1000)}s (max ${Math.round((testState.timeoutSeconds || 300) / 60)} min)…`),
    run && run.live?.length ? h('pre', { class: 'olm-live' }, run.live.slice(-6).join('\n')) : null);
}

function runtimeWarningText(s) {
  const running = s.running || [];
  if (!running.length) return '';
  const small = running.filter((r) => r.contextLength && r.contextLength < 16384);
  if (small.length) {
    return `⚠ Ollama currently loaded ${small.map((r) => `${r.name} at ${kctx(r.contextLength)} ctx`).join(', ')} (server default). CLIs like Codex/Qwen/OpenCode send 6k–10k prompt tokens; set OLLAMA_CONTEXT_LENGTH=32768 on your Ollama PC or create a 32k variant copy for best tool calling.`;
  }
  return '';
}

async function loadOllama() {
  await loadTests().catch(() => {});
  const s = ollamaState = await api('GET', '/api/ollama');
  if (document.activeElement !== $('#ollamaUrl')) $('#ollamaUrl').value = s.url || '';
  if (document.activeElement !== $('#serverCtx')) $('#serverCtx').value = s.serverCtx;
  const st = $('#ollamaStatus'); st.replaceChildren(); st.className = 'small';
  if (!s.url) {
    st.classList.add('muted');
    st.append('Enter the address of the PC running Ollama. On that PC set ', h('code', {}, 'OLLAMA_HOST=0.0.0.0'), ', restart Ollama and allow port 11434 through its firewall.');
  } else if (s.connected) {
    st.append(h('span', { class: 'badge live' }, 'connected'), ` Ollama ${s.version} · ${s.models.length} model(s)`);
  } else {
    st.append(h('span', { class: 'err' }, s.error || 'not reachable'));
  }
  const rt = $('#ollamaRuntimeInfo');
  if (rt) {
    const warn = s.connected ? runtimeWarningText(s) : '';
    const loaded = s.connected && s.running?.length ? s.running.map((r) => `${r.name}${r.contextLength ? ` (${kctx(r.contextLength)} ctx)` : ''}`).join(', ') : '';
    rt.replaceChildren();
    if (warn) {
      rt.className = 'usage limited';
      rt.textContent = warn;
    } else if (loaded) {
      rt.className = 'small muted';
      rt.textContent = `Loaded in Ollama: ${loaded}`;
    } else {
      rt.className = 'small hidden';
    }
  }
  $('#ollamaBody').classList.toggle('hidden', !s.connected);
  renderOllamaModels(); renderPulls(); renderLaunchModels(); renderLab();
  schedulePullPoll(s.pulls);
}

function schedulePullPoll(pulls) {
  clearTimeout(state.pullTimer); state.pullTimer = null;
  const anyPulling = Object.values(pulls || {}).some((p) => !p.done);
  if (anyPulling) state.pullTimer = setTimeout(() => pollPulls().catch(() => {}), 2000);
}

async function pollPulls() {
  const { pulls } = await api('GET', '/api/ollama/pulls');
  const prev = ollamaState.pulls || {};
  const newlyDone = Object.entries(pulls || {}).some(([k, p]) => p.done && !prev[k]?.done);
  ollamaState.pulls = pulls;
  renderPulls();
  if (newlyDone) {
    await loadOllama();
  } else {
    schedulePullPoll(pulls);
  }
}

function renderOllamaModels() {
  const s = ollamaState, box = $('#ollamaModels');
  const prev = box.querySelector('.olm') ? new Set([...box.querySelectorAll('.olm:checked')].map((c) => c.value)) : null; // keep unsaved ticks on re-render
  box.replaceChildren();
  if (!s.connected) return;
  const configured = new Set(OLLAMA_CLIS_ORDER.flatMap((k) => s.applied?.[k] || []));
  if (!s.models.length) box.append(h('p', { class: 'muted small' }, 'No models on this Ollama server yet. Pull one below.'));
  for (const m of s.models) {
    const ctx = m.numCtx || s.serverCtx;
    const ctxCls = ctx >= 32768 ? 'live' : ctx >= 16384 ? '' : 'warn';
    const canGrow = (m.ctxMax || 131072) > ctx && ctx < 32768;
    const target = Math.min(32768, m.ctxMax || 32768);
    const id = 'olm-' + m.name.replace(/[^A-Za-z0-9]/g, '_');
    const where = OLLAMA_CLIS_ORDER.filter((k) => (s.applied?.[k] || []).includes(m.name)).map((k) => AGENT_SHORT[k]);
    box.append(h('div', { class: 'item check' },
      h('input', { type: 'checkbox', id, class: 'olm', value: m.name, checked: prev ? prev.has(m.name) : configured.has(m.name) || (!configured.size && m.tools && ctx >= 16384) }),
      h('div', { class: 'olm-body' },
        h('div', { class: 'top' },
          h('label', { for: id, class: 'name', title: m.name }, m.name),
          h('span', { class: 'spacer' }),
          h('button', { class: 'icon', title: `Delete ${m.name} from Ollama`, onclick: (e) => busy(e.target, async () => {
            if (!(await m3Confirm(`Delete ${m.name}?`, `Delete ${m.name} from the Ollama server? This frees ${gb(m.size)} on that PC.`, { okLabel: 'Delete', danger: true }))) return;
            await api('DELETE', '/api/ollama/models', { model: m.name }); await loadOllama();
          }) }, '✕')),
        h('div', { class: 'top badges' },
          m.params && h('span', { class: 'badge' }, m.params),
          h('span', { class: 'badge' }, gb(m.size)),
          h('span', { class: 'badge ' + ctxCls, title: m.numCtx ? 'num_ctx set on this model' : 'server default — no num_ctx on this model' }, `ctx ${kctx(ctx)}${m.numCtx ? '' : '*'}`),
          m.tools ? h('span', { class: 'badge live' }, 'tools') : h('span', { class: 'badge bad', title: 'Coding agents need tool calling; this model will likely not work' }, 'no tools'),
          m.thinking && h('span', { class: 'badge' }, 'thinking'),
          m.vision && h('span', { class: 'badge' }, 'vision'),
          m.cloud && h('span', { class: 'badge cloud' }, 'cloud'),
          where.length ? h('span', { class: 'badge ok', title: `Configured in ${where.join(', ')}` }, `✓ ${where.join(' · ')}`) : null,
          ...testBadges(m.name)),
        keepOpen(`olm:${m.name}`, h('summary', {}, canGrow ? 'details · context too small' : 'details'),
          m.usage && h('div', { class: 'usage ' + m.usage.level }, m.usage.text),
          h('div', { class: 'small muted' }, 'Configured in: ', where.length ? where.join(', ') : 'not yet — tick it and click Apply'),
          m.tools && testPanel(m),
          canGrow && h('div', { class: 'small' },
            h('button', { style: 'font-size:11px;padding:2px 6px', title: `Creates a copy of this model with num_ctx ${target}. Uses more memory on the Ollama PC.`,
              onclick: (e) => busy(e.target, async () => {
                const r = await api('POST', '/api/ollama/variant', { model: m.name, num_ctx: target });
                await loadOllama();
                const cb = [...document.querySelectorAll('.olm')].find((c) => c.value === r.name); if (cb) cb.checked = true;
              }) }, `Make agent-ready copy (${kctx(target)} ctx)`),
            h('span', { class: 'muted' }, ' — small context breaks tool calls'))))));
  }
  $('#modelsCount').textContent = `Models on this server (${s.models.length})`;
  const def = $('#ollamaDefault'), cur = def.value;
  def.replaceChildren(h('option', { value: '' }, 'default: unchanged'), ...s.models.map((m) => h('option', { value: m.name }, `default: ${m.name}`)));
  def.value = s.models.some((m) => m.name === cur) ? cur : '';
  const a = s.applied || {};
  $('#appliedInfo').textContent = OLLAMA_CLIS_ORDER
    .map((k) => {
      const list = a[k] || [];
      return `${AGENT_SHORT[k]}: ${list.length || '0'}`;
    }).join(' · ');
}

function renderPulls() {
  const box = $('#pulls'); box.replaceChildren();
  let activeCount = 0;
  for (const [name, p] of Object.entries(ollamaState.pulls || {})) {
    if (!p.done) activeCount++;
    if (p.done && p.status === 'success') continue;
    const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
    box.append(h('div', { class: 'item' },
      h('div', { class: 'top' }, h('span', { class: 'name' }, name), h('span', { class: 'spacer' }), h('span', { class: 'meta' }, p.error ? 'failed' : `${p.status} ${p.total ? pct + '%' : ''}`)),
      p.error ? h('div', { class: 'err small' }, p.error) : h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` }))));
  }
  setRailBadge('#railBadgePulls', activeCount);
}

function renderLaunchModels() {
  const sel = $('#launchModel'), cur = sel.value;
  const a = ollamaState.applied || {};
  const ollamaNames = [...new Set(OLLAMA_CLIS_ORDER.flatMap((k) => a[k] || []))].sort();
  const customNames = [...new Set([...(a.custom?.opencode || []), ...(a.custom?.pi || [])])].sort();
  const all = [...ollamaNames, ...customNames];
  sel.replaceChildren(
    h('option', { value: '' }, 'agent default'),
    ...ollamaNames.map((n) => h('option', { value: n }, `ollama · ${n}`)),
    ...customNames.map((n) => h('option', { value: n }, n)),
  );
  let saved = cur; try { saved ||= localStorage.getItem('launchModel') || ''; } catch {}
  sel.value = all.includes(saved) ? saved : '';
}

export { ollamaState, gb, kctx, testState, labCliSelection, loadTests, TEST_ICON, verdictClass, runtimeWarningText, loadOllama, pollPulls, renderOllamaModels, renderLaunchModels };
