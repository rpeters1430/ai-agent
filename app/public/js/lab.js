// Models × CLIs compatibility lab (runs the model tests and shows the matrix).
import { state } from './state.js';
import { $, api, busy, h, m3Confirm, showDialog } from './core.js';
import { AGENT_LABEL, AGENT_SHORT, OLLAMA_CLIS_ORDER } from './agentinfo.js';
import { status } from './workspace.js';
import { TEST_ICON, gb, kctx, labCliSelection, loadOllama, loadTests, ollamaState, pollPulls, renderLaunchModels, renderOllamaModels, runtimeWarningText, testState, verdictClass } from './ollama.js';
import { closeMobileSheet } from './nav.js';
import { ago } from './automations.js';

function openOllamaLab(initialSel) {
  if (initialSel) state.labSelected = initialSel;
  closeMobileSheet();
  const dlg = $('#ollamaLabDlg');
  if (!dlg.open) dlg.showModal();
  loadTests().then(renderLab).catch(() => renderLab());
}

function renderLabDiff(diffText) {
  const box = h('div', { class: 'diff-view', style: 'max-height:220px' });
  for (const line of String(diffText || '').split('\n')) {
    let cls = 'diff-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) cls += ' diff-meta';
    else if (line.startsWith('@@')) cls += ' diff-hunk';
    else if (line.startsWith('+')) cls += ' diff-add';
    else if (line.startsWith('-')) cls += ' diff-del';
    box.append(h('div', { class: cls }, line || ' '));
  }
  return box;
}

function renderLabDetail() {
  const box = $('#labDetailBox');
  if (!box) return;
  if (!state.labSelected) { box.classList.add('hidden'); return; }
  const { model, agent } = state.labSelected;
  const r = testState.results?.[model]?.[agent];
  const isRunning = testState.running?.model === model && testState.running?.agent === agent;
  const isQueued = testState.queue?.some((q) => q.model === model && q.agent === agent);
  box.classList.remove('hidden');
  box.replaceChildren();

  const cliMeta = testState.agents?.[agent] || {};
  box.append(
    h('div', { class: 'row wrap', style: 'justify-content:space-between' },
      h('div', { class: 'row wrap' },
        h('b', { style: 'font-size:14px' }, model),
        h('span', { class: 'badge size' }, AGENT_LABEL[agent] || agent),
        cliMeta.protocol && h('span', { class: 'badge' }, cliMeta.protocol),
        r && h('span', { class: 'badge ' + verdictClass(r.verdict) }, `${TEST_ICON[r.verdict] || '?'} ${r.verdict.replace('_', ' ')}`),
        r?.mode && h('span', { class: 'badge' }, r.mode === 'tool_smoke' ? 'tool smoke' : 'coding edit')),
      h('div', { class: 'row tight' },
        h('button', {
          class: 'primary', style: 'font-size:12px;padding:4px 12px', disabled: isRunning || isQueued,
          onclick: (e) => busy(e.target, async () => {
            await api('POST', '/api/ollama/tests', { model, agents: [agent], mode: state.labMode });
            await loadTests(); renderOllamaModels(); renderLab();
          }),
        }, isRunning ? 'Running…' : isQueued ? 'Queued' : (r ? 'Re-test' : 'Run test')),
        r && h('button', {
          style: 'font-size:12px;padding:4px 10px',
          onclick: (e) => busy(e.target, async () => {
            await api('DELETE', '/api/ollama/tests', { model, agent });
            await loadTests(); renderOllamaModels(); renderLab();
          }),
        }, 'Clear'))));

  if (isRunning) {
    const secs = Math.round((Date.now() - testState.running.startedAt) / 1000);
    box.append(h('div', { class: 'small muted' }, `Running ${testState.running.mode || 'coding'} test for ${secs}s…`));
    if (testState.running.live?.length) box.append(h('pre', { class: 'olm-live', style: 'max-height:160px' }, testState.running.live.join('\n')));
    return;
  }
  if (!r) {
    box.append(h('div', { class: 'small muted' }, 'Not tested yet. Click “Run test” above to verify tool calls and loop safety on this model × CLI pair.'));
    return;
  }

  box.append(
    h('div', { class: 'small' }, r.text),
    h('div', { class: 'row wrap small muted' },
      h('span', { class: 'badge' }, `${r.secs ?? 0}s`),
      h('span', { class: 'badge' }, `${r.tools ?? 0} tool call${r.tools === 1 ? '' : 's'}`),
      r.maxPromptTokens > 0 && h('span', { class: 'badge' }, `peak ${r.maxPromptTokens.toLocaleString()} prompt tok`),
      h('span', {}, `tested ${ago(r.at)}`)));

  if (r.loop) {
    box.append(h('div', { class: 'usage none' }, `⛔ Loop guard triggered: "${r.loop.call}" repeated ${r.loop.times}×${r.loop.kind ? ` (${r.loop.kind})` : ''}. Stopped cleanly to prevent infinite looping.`));
  }
  if (r.errors?.length) {
    box.append(h('div', { class: 'usage none' }, `Errors: ${r.errors.join(' | ')}`));
  }
  if (r.calls?.length) {
    box.append(
      h('div', { class: 'watch-group-title', style: 'margin-top:4px' }, `Tool call trace (${r.calls.length})`),
      h('ol', { class: 'lab-trace' }, ...r.calls.map((c) => h('li', {}, c))));
  }
  if (r.lastText) {
    box.append(
      h('div', { class: 'watch-group-title', style: 'margin-top:4px' }, 'Final assistant reply'),
      h('pre', { class: 'olm-live', style: 'max-height:110px' }, r.lastText));
  }
  if (r.diff) {
    box.append(
      h('div', { class: 'watch-group-title', style: 'margin-top:4px' }, 'Git diff'),
      renderLabDiff(r.diff));
  }
}

function renderLab() {
  const dlg = $('#ollamaLabDlg');
  if (!dlg || !dlg.open) return;

  // Mode segmented buttons
  for (const b of document.querySelectorAll('#labModePicker button')) {
    b.classList.toggle('active', b.dataset.mode === state.labMode);
  }

  // CLI filter chips
  const chips = $('#labCliChips');
  chips.replaceChildren(...OLLAMA_CLIS_ORDER.map((k) => {
    const installed = status.agents?.[k]?.installed !== false;
    const cb = h('input', {
      type: 'checkbox', checked: labCliSelection.has(k), disabled: !installed,
      onchange: (e) => { if (e.target.checked) labCliSelection.add(k); else labCliSelection.delete(k); },
    });
    return h('label', { class: 'chip-check', title: `${AGENT_LABEL[k]} · ${testState.agents?.[k]?.protocol || ''}${installed ? '' : ' (not installed)'}` },
      cb, h('span', {}, AGENT_SHORT[k]));
  }));

  // Unsupported CLIs note
  const unsup = testState.unsupportedAgents || ollamaState.unsupportedClis || {};
  const unsupParts = Object.values(unsup).map((u) => `${u.label} (${u.reason})`);
  $('#labUnsupportedNote').textContent = unsupParts.length ? `Not Ollama-compatible: ${unsupParts.join(' · ')}` : '';

  // Runtime context warning
  const warn = runtimeWarningText(ollamaState);
  const warnEl = $('#labRuntimeWarn');
  warnEl.textContent = warn;
  warnEl.classList.toggle('hidden', !warn);

  // Live run banner + Stop button
  const running = testState.running;
  const qLen = testState.queue?.length || 0;
  $('#labStop').classList.toggle('hidden', !running && !qLen);
  const liveBox = $('#labLiveBox');
  if (running || qLen) {
    liveBox.classList.remove('hidden');
    const secs = running ? Math.round((Date.now() - running.startedAt) / 1000) : 0;
    liveBox.replaceChildren(
      h('div', { class: 'row wrap', style: 'justify-content:space-between' },
        h('div', { class: 'row wrap' },
          h('span', { class: 'badge warn' }, '● Running'),
          running && h('b', {}, `${running.model} × ${AGENT_LABEL[running.agent] || running.agent}`),
          running && h('span', { class: 'badge' }, running.mode === 'tool_smoke' ? 'tool smoke' : 'coding edit'),
          running && h('span', { class: 'small muted' }, `${secs}s elapsed`)),
        qLen > 0 && h('span', { class: 'badge' }, `+${qLen} queued`)),
      running?.live?.length
        ? h('pre', { class: 'olm-live', style: 'max-height:110px' }, running.live.slice(-8).join('\n'))
        : h('div', { class: 'small muted' }, 'Waiting for model response / tool calls…'));
  } else {
    liveBox.classList.add('hidden');
  }

  // Matrix table
  const wrap = $('#labMatrixWrap');
  const models = ollamaState.models || [];
  if (!models.length) {
    wrap.replaceChildren(h('p', { class: 'small muted' }, 'No models found on the connected Ollama server.'));
    renderLabDetail();
    return;
  }

  const tbody = h('tbody');
  for (const m of models) {
    const rMap = testState.results?.[m.name] || {};
    const ctx = m.numCtx || ollamaState.serverCtx;
    const row = h('tr', {},
      h('td', { class: 'lab-model-col' },
        h('div', { class: 'lab-model-name', title: m.name }, m.name),
        h('div', { class: 'row wrap', style: 'gap:4px;margin-top:3px' },
          m.params && h('span', { class: 'badge' }, m.params),
          h('span', { class: 'badge' }, gb(m.size)),
          h('span', { class: 'badge ' + (ctx >= 32768 ? 'live' : ctx >= 16384 ? '' : 'warn') }, `ctx ${kctx(ctx)}`),
          m.tools ? h('span', { class: 'badge live' }, 'tools') : h('span', { class: 'badge bad' }, 'no tools'),
          m.thinking && h('span', { class: 'badge' }, 'thinking'))),
      ...OLLAMA_CLIS_ORDER.map((cliKey) => {
        const isRun = running?.model === m.name && running.agent === cliKey;
        const isQ = testState.queue?.some((q) => q.model === m.name && q.agent === cliKey);
        const res = rMap[cliKey];
        const isSel = state.labSelected?.model === m.name && state.labSelected?.agent === cliKey;
        let pillCls = 'lab-pill idle', pillTxt = '▶ Test', tip = `Click to run ${state.labMode} test for ${m.name} on ${AGENT_LABEL[cliKey]}`;
        if (isRun) {
          pillCls = 'lab-pill running';
          pillTxt = `● ${Math.round((Date.now() - running.startedAt) / 1000)}s`;
          tip = 'Currently testing — click to view live log';
        } else if (isQ) {
          pillCls = 'lab-pill queued';
          pillTxt = 'queued';
          tip = 'Queued for testing';
        } else if (res) {
          pillCls = `lab-pill ${verdictClass(res.verdict)}`;
          pillTxt = res.verdict === 'pass' ? `✓ ${res.secs}s (${res.tools}t)` : `${TEST_ICON[res.verdict] || '?'} ${res.verdict.replace('_', ' ')}`;
          tip = `${AGENT_LABEL[cliKey]} (${res.mode || 'coding'}): ${res.text}`;
        }
        return h('td', { class: 'lab-cell' + (isSel ? ' selected' : '') },
          h('button', {
            type: 'button', class: pillCls, title: tip,
            onclick: (e) => {
              state.labSelected = { model: m.name, agent: cliKey };
              if (!res && !isRun && !isQ && m.tools) {
                busy(e.target, async () => {
                  await api('POST', '/api/ollama/tests', { model: m.name, agents: [cliKey], mode: state.labMode });
                  await loadTests(); renderOllamaModels(); renderLab();
                });
              } else {
                renderLab();
              }
            },
          }, pillTxt));
      }),
      h('td', { class: 'lab-act-col' },
        h('button', {
          type: 'button', style: 'font-size:11px;padding:4px 9px', disabled: !m.tools,
          title: `Queue selected CLIs for ${m.name}`,
          onclick: (e) => busy(e.target, async () => {
            const agents = [...labCliSelection];
            if (!agents.length) throw new Error('Select at least one CLI above.');
            await api('POST', '/api/ollama/tests', { model: m.name, agents, mode: state.labMode });
            await loadTests(); renderOllamaModels(); renderLab();
          }),
        }, 'Test row')));
    tbody.append(row);
  }

  const table = h('table', { class: 'lab-table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Ollama Model'),
        ...OLLAMA_CLIS_ORDER.map((k) => h('th', { title: testState.agents?.[k]?.protocol || '' }, AGENT_SHORT[k])),
        h('th', {}, ''))),
    tbody);
  wrap.replaceChildren(table);
  renderLabDetail();
}

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  $('#openOllamaLab')?.addEventListener('click', () => openOllamaLab(null));
  $('#labClose')?.addEventListener('click', () => $('#ollamaLabDlg').close());
  $('#labRefresh')?.addEventListener('click', (e) => busy(e.target, loadOllama));
  for (const b of document.querySelectorAll('#labModePicker button')) {
    b.addEventListener('click', () => { state.labMode = b.dataset.mode; renderLab(); });
  }
  $('#labRunAll')?.addEventListener('click', (e) => busy(e.target, async () => {
    const models = (ollamaState.models || []).filter((m) => m.tools).map((m) => m.name);
    const agents = [...labCliSelection];
    if (!models.length) throw new Error('No tool-capable models on Ollama.');
    if (!agents.length) throw new Error('Select at least one CLI to test.');
    await api('POST', '/api/ollama/tests', { models, agents, mode: state.labMode });
    await loadTests(); renderOllamaModels(); renderLab();
  }));
  $('#labStop')?.addEventListener('click', (e) => busy(e.target, async () => {
    await api('POST', '/api/ollama/tests/cancel');
    await loadTests(); renderOllamaModels(); renderLab();
  }));
  $('#labClear')?.addEventListener('click', (e) => busy(e.target, async () => {
    if (!(await m3Confirm('Clear test results', 'Clear all saved Ollama × CLI test results?', { okLabel: 'Clear', danger: true }))) return;
    await api('DELETE', '/api/ollama/tests');
    state.labSelected = null;
    await loadTests(); renderOllamaModels(); renderLab();
  }));
  $('#labApplyPassing')?.addEventListener('click', (e) => busy(e.target, async () => {
    const installed = new Set((ollamaState.models || []).map((m) => m.name));
    const perCli = {};
    for (const [model, map] of Object.entries(testState.results || {})) {
      if (!installed.has(model)) continue;
      for (const cli of OLLAMA_CLIS_ORDER) {
        if (map[cli]?.verdict === 'pass') (perCli[cli] ||= []).push(model);
      }
    }
    const clis = Object.keys(perCli);
    if (!clis.length) throw new Error('No passing test results yet. Run tests first.');
    let appliedRes = null;
    for (const cli of clis) {
      appliedRes = await api('POST', '/api/ollama/apply', { models: perCli[cli], targets: [cli] });
    }
    if (appliedRes?.applied) ollamaState.applied = appliedRes.applied;
    renderOllamaModels(); renderLaunchModels(); renderLab();
    showDialog('Passing models applied', clis.map((c) => `${AGENT_LABEL[c]}: ${perCli[c].join(', ')}`).join('\n'));
  }));

  $('#ollamaUrlForm').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || e.target, async () => {
    $('#ollamaStatus').textContent = 'Connecting…';
    try { await api('POST', '/api/ollama/url', { url: $('#ollamaUrl').value }); }
    finally { await loadOllama(); }
  }); });
  $('#ctxForm').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || e.target, async () => {
    await api('POST', '/api/ollama/server-ctx', { serverCtx: Number($('#serverCtx').value) }); await loadOllama();
  }); });
  $('#pullForm').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter || e.target, async () => {
    const model = $('#pullName').value.trim(); if (!model) return;
    await api('POST', '/api/ollama/pull', { model }); $('#pullName').value = '';
    setTimeout(() => pollPulls().catch(() => {}), 300);
  }); });
  $('#applyOllama').addEventListener('click', (e) => busy(e.target, async () => {
    const models = [...document.querySelectorAll('.olm:checked')].map((c) => c.value);
    const tgtMap = [
      ['pi', '#tgtPi'], ['opencode', '#tgtOpencode'], ['claude', '#tgtClaude'],
      ['codex', '#tgtCodex'], ['qwen', '#tgtQwen'], ['dsh', '#tgtDsh'],
    ];
    const targets = tgtMap.filter(([, sel]) => $(sel)?.checked).map(([k]) => k);
    let def = $('#ollamaDefault').value;
    if (def && !models.includes(def)) throw new Error('The default model must also be checked.');
    const r = await api('POST', '/api/ollama/apply', { models, targets, default: def || undefined });
    ollamaState.applied = r.applied; renderOllamaModels(); renderLaunchModels();
    showDialog('Local models applied', `${models.length} model(s) configured for ${targets.map((t) => AGENT_LABEL[t] || t).join(', ')}.\n\n` +
      `Start any of those CLIs from a repo — pick the model in "Local model (Ollama / custom)". Already-running sessions need a restart to see the change.`);
  }));
  $('#refreshOllama').addEventListener('click', (e) => busy(e.target, loadOllama));
  $('#launchModel').addEventListener('change', () => { try { localStorage.setItem('launchModel', $('#launchModel').value); } catch {} });
}

export { openOllamaLab, renderLab, init };
