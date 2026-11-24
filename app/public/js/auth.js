// Sign-in screen, the "finish login" OAuth callback form, and background polling timers.
import { state } from './state.js';
import { $, api, busy, m3Confirm } from './core.js';
import { loadStatus, open } from './workspace.js';
import { start } from './main.js';

function stopBackgroundPolling() {
  clearInterval(state.sessionsTimer); state.sessionsTimer = null;
  clearInterval(state.openUrlsTimer); state.openUrlsTimer = null;
  clearTimeout(state.pullTimer); state.pullTimer = null;
  clearTimeout(state.testTimer); state.testTimer = null;
  for (const e of open.values()) {
    clearTimeout(e.reconnTimer); e.reconnTimer = null;
    e.paused = true;
    try { e.ws?.close(); } catch {}
  }
}
function showLogin() {
  stopBackgroundPolling();
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#pw').focus();
}

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  $('#oauthForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target, msg = $('#oauthMsg');
    busy(f.querySelector('button'), async () => {
      msg.className = ''; msg.textContent = '';
      try { const r = await api('POST', '/api/oauth-callback', { url: f.url.value }); msg.className = r.ok ? 'ok' : 'err'; msg.textContent = r.message; if (r.ok) f.url.value = ''; setTimeout(() => loadStatus().catch(() => {}), 3000); }
      catch (err) { msg.className = 'err'; msg.textContent = err.message; }
    });
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#loginErr').textContent = '';
    try { await api('POST', '/api/login', { password: $('#pw').value }); $('#pw').value = ''; start(); }
    catch (err) { $('#loginErr').textContent = err.message; }
  });
  $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.reload(); });
  $('#logoutAll').addEventListener('click', async () => {
    if (!(await m3Confirm('Sign out all devices', 'Revoke sessions on every browser and device? You will need to sign in again everywhere.', { okLabel: 'Sign out all', danger: true }))) return;
    await api('POST', '/api/logout', { all: true });
    location.reload();
  });
}

export { showLogin, init };
