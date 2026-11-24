// Entry point: loads every module in order, wires the main buttons, and starts the app once signed in.
import { init as init_auth } from './auth.js';
import { init as init_terminals } from './terminals.js';
import { init as init_lab } from './lab.js';
import { init as init_catalog } from './catalog.js';
import { init as init_nav } from './nav.js';
import { init as init_automations } from './automations.js';
import { init as init_system } from './system.js';
import { state } from './state.js';
import { $, api, busy, m3Confirm, m3Prompt } from './core.js';
import { initTheme } from './theme.js';
import { showLogin } from './auth.js';
import { loadGh, loadLocal, loadSessions, loadStatus, open, renderGh, renderLocal, sessions, status } from './workspace.js';
import { activate, connect, initKeybar, pasteDialog, setFontSize, termFontSize } from './terminals.js';
import { loadOllama } from './ollama.js';
import { pollOpenUrls } from './openurls.js';
import { closeMobileSheet, initNavRail, openMobileSheet } from './nav.js';
import { loadAuto } from './automations.js';
import { loadNotify, loadTools } from './system.js';
import { showNoticeToast } from './upload.js';
import { initFeatures } from './features.js';

async function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  await loadStatus();
  await Promise.all([loadLocal(), loadSessions(), loadOllama().catch(() => {}), typeof loadAuto === 'function' ? loadAuto().catch(() => {}) : null]);
  if (typeof loadTools === 'function') {
    // Check every CLI for updates on each page load (asks npm for the latest versions, skipping the server cache).
    loadTools(true).then((d) => {
      const outdated = (d?.tools || []).filter((t) => t.outdated);
      if (outdated.length && !d.updating && typeof showNoticeToast === 'function') {
        showNoticeToast(`${outdated.length} CLI update${outdated.length > 1 ? 's' : ''} available`,
          `${outdated.map((t) => `${t.label} ${t.version} → ${t.latest}`).join(' · ')}. Update them under System.`);
      }
    }).catch(() => {});
    loadNotify().catch(() => {});
  }
  if (typeof initFeatures === 'function') initFeatures();
  if (status.github.connected) loadGh();
  for (const [name, e] of open) {
    if (e.paused && !e.closed && sessions.some((s) => s.name === name)) connect(name, e);
  }
  clearInterval(state.sessionsTimer);
  clearInterval(state.openUrlsTimer);
  state.sessionsTimer = setInterval(() => loadSessions().catch(() => {}), 15000);
  state.openUrlsTimer = setInterval(() => pollOpenUrls().catch(() => {}), 2000);
}

// Run every module's start-up code in the old <script> order, now that all of them are loaded.
init_auth();
init_terminals();
init_lab();
init_catalog();
init_nav();
init_automations();
init_system();

$('#pasteBtn').addEventListener('click', pasteDialog);
$('#fontDown').addEventListener('click', () => setFontSize(termFontSize - 1));
$('#fontUp').addEventListener('click', () => setFontSize(termFontSize + 1));
initKeybar();
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (document.querySelector('dialog[open]')) return;
  const idx = Number(e.key) - 1;
  if (idx >= 0 && idx < 9) {
    const names = [...open.keys()];
    if (names[idx]) { e.preventDefault(); activate(names[idx]); }
  }
});
$('#refreshStatus').addEventListener('click', (e) => busy(e.target, async () => { await loadStatus(); renderLocal(); if (status.github.connected) loadGh(); }));
$('#refreshLocal').addEventListener('click', (e) => busy(e.target, loadLocal));
$('#refreshSessions').addEventListener('click', (e) => busy(e.target, loadSessions));
$('#loadGh').addEventListener('click', (e) => busy(e.target, () => loadGh()));
$('#ghFilter').addEventListener('input', renderGh);
$('#openSide').addEventListener('click', openMobileSheet);
$('#closeSide').addEventListener('click', closeMobileSheet);
$('#sideScrim').addEventListener('click', closeMobileSheet);
$('#newRepoBtn').addEventListener('click', (e) => busy(e.target, async () => {
  const name = await m3Prompt('New repository', 'Repository name (letters, digits, . _ -):', '', { placeholder: 'my-project', okLabel: 'Next' });
  if (!name) return;
  const github = status.github.connected && await m3Confirm('Create on GitHub?', `Also create a private GitHub repository "${name.trim()}" and set it as origin?`, { okLabel: 'Create on GitHub' });
  await api('POST', '/api/repos/create', { name: name.trim(), github });
  await loadLocal();
}));
try { $('#yolo').checked = localStorage.getItem('yolo') === '1'; } catch {}
$('#yolo').addEventListener('change', () => { try { localStorage.setItem('yolo', $('#yolo').checked ? '1' : '0'); } catch {} });
initTheme();
initNavRail();

(async () => {
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({}));
  if (me.authed) start(); else showLogin();
})();

export { start };
