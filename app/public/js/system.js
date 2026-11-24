// System tab: CLI versions and updates, notification settings.
import { $, api, busy, h, m3Confirm, setRailBadge } from './core.js';
import { loadSessions, open, sessions } from './workspace.js';
import { attach } from './terminals.js';
import { closeMobileSheet } from './nav.js';

// System section: CLI versions/updates and notification settings (uses h, api, busy, attach, loadSessions, sessions, open from app.js)

async function loadTools(fresh) {
  const d = await api('GET', '/api/tools' + (fresh ? '?fresh=1' : ''));
  const box = $('#tools'); box.replaceChildren();
  for (const t of d.tools) {
    box.append(h('div', { class: 'tool-row' },
      h('span', { class: 'n' }, t.label),
      h('span', { class: 'v', title: t.source === 'updated' ? 'Updated from the UI (stored in ~/.local/tools)' : 'Version built into the image' },
        t.installed ? (t.version || '?') : 'not installed'),
      t.outdated && h('span', { class: 'badge warn', title: `Latest is ${t.latest}` }, `→ ${t.latest}`),
      !t.outdated && t.latest && t.version && h('span', { class: 'badge live' }, 'latest'),
      t.source === 'updated' && h('span', { class: 'badge', title: 'Updated copy in ~/.local/tools' }, 'upd'),
      h('span', { class: 'spacer' }),
      h('button', { title: `Update ${t.label}`, onclick: (e) => busy(e.target, () => runUpdate([t.key])) }, 'Update')));
  }
  const n = d.tools.filter((t) => t.outdated).length;
  $('#updateAll').textContent = d.updating ? 'Update running… (watch)' : n ? `Update all CLIs (${n} outdated)` : 'Update all CLIs';
  $('#resetTools').classList.toggle('hidden', !d.hasUpdates);
  if (typeof setRailBadge === 'function') setRailBadge('#railBadgeTools', n);
  return d;
}

async function runUpdate(keys) {
  const agentSessions = sessions.filter((s) => s.agent && !['update', 'shell'].includes(s.agent) && !s.agent.startsWith('login'));
  if (agentSessions.length && !(await m3Confirm('Update CLIs', `${agentSessions.length} agent session(s) are running. They keep their current version until restarted, and updating while they run can occasionally confuse them. Update now?`, { okLabel: 'Update now' }))) return;
  const { session } = await api('POST', '/api/tools/update', keys ? { tools: keys } : {});
  await loadSessions();
  attach(session, 'Update CLIs');
  // Refresh versions once the update window says it's finished.
  const started = Date.now();
  const t = setInterval(() => {
    const buf = open.get(session)?.term.buffer.active;
    let done = false;
    if (buf) for (let i = Math.max(0, buf.length - 80); i < buf.length; i++) if ((buf.getLine(i)?.translateToString() || '').includes('[finished')) done = true;
    if (done || !buf || Date.now() - started > 20 * 60 * 1000) { clearInterval(t); loadTools(true).catch(() => {}); }
  }, 4000);
}

let notifyState = {};
async function loadNotify() {
  notifyState = await api('GET', '/api/notify');
  const s = notifyState, on = [s.ntfyUrl && 'ntfy', s.discordUrl && 'Discord', s.webhookUrl && 'webhook'].filter(Boolean);
  $('#notifySummary').replaceChildren(on.length ? `→ ${on.join(', ')}` : 'off',
    s.last?.error ? h('span', { class: 'err' }, ` (last failed: ${s.last.error})`) : '');
}
function fillNotifyForm() {
  const f = $('#notifyForm'), s = notifyState;
  for (const k of ['ntfyUrl', 'ntfyToken', 'discordUrl', 'webhookUrl']) f[k].value = s[k] || '';
  f.hubUrl.value = s.hubUrl || location.origin;
  f.jobSucceeded.checked = !!s.events?.jobSucceeded; f.jobFailed.checked = !!s.events?.jobFailed; f.idle.checked = !!s.events?.idle;
  f.idleMinutes.value = s.idleMinutes || 3;
  $('#notifyMsg').textContent = '';
}
const notifyBody = (f) => ({
  ntfyUrl: f.ntfyUrl.value, ntfyToken: f.ntfyToken.value, discordUrl: f.discordUrl.value, webhookUrl: f.webhookUrl.value, hubUrl: f.hubUrl.value,
  events: { jobSucceeded: f.jobSucceeded.checked, jobFailed: f.jobFailed.checked, idle: f.idle.checked }, idleMinutes: Number(f.idleMinutes.value),
});

// Start-up code (wires the UI). main.js calls this once every module has loaded.
function init() {
  $('#updateAll').addEventListener('click', (e) => busy(e.target, () => runUpdate(null)));
  $('#refreshTools').addEventListener('click', (e) => busy(e.target, () => loadTools(true)));
  $('#resetTools').addEventListener('click', (e) => busy(e.target, async () => {
    if (!(await m3Confirm('Reset CLIs to image versions', 'Remove the updated CLIs (and anything else installed with npm -g) from ~/.local/tools and go back to the versions built into the image?', { okLabel: 'Reset', danger: true }))) return;
    await api('POST', '/api/tools/reset'); await loadTools(true);
  }));
  $('#openNotify').addEventListener('click', (e) => busy(e.target, async () => { await loadNotify(); fillNotifyForm(); closeMobileSheet(); $('#notifyDlg').showModal(); }));
  $('#notifyClose').addEventListener('click', () => $('#notifyDlg').close());
  $('#notifyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.target.querySelector('[type=submit]'), async () => {
      await api('POST', '/api/notify', notifyBody(e.target)); await loadNotify();
      $('#notifyMsg').textContent = 'Saved.';
    });
  });
  $('#notifyTest').addEventListener('click', (e) => busy(e.target, async () => {
    const f = $('#notifyForm');
    await api('POST', '/api/notify', notifyBody(f));
    const r = await api('POST', '/api/notify/test');
    await loadNotify();
    const msg = $('#notifyMsg'); msg.replaceChildren();
    for (const x of r.sent) msg.append(h('div', { class: x.ok ? '' : 'err' }, `${x.name}: ${x.ok ? 'sent ✓' : x.error}`));
  }));
}

export { loadTools, loadNotify, init };
