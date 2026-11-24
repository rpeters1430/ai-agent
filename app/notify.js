'use strict';
// Push notifications (ntfy, Discord, generic webhook) for finished automations and agents that went quiet.
const fs = require('fs');
const path = require('path');

const FILE = path.join(process.env.HOME || '/home/dev', '.agent-hub', 'notify.json');
const DEFAULTS = {
  ntfyUrl: '', ntfyToken: '', discordUrl: '', webhookUrl: '', hubUrl: '',
  events: { jobSucceeded: true, jobFailed: true, idle: true },
  idleMinutes: 3,
};
let ctx;
let cfg = { ...DEFAULTS };
const lastSent = { at: 0, error: '' };

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); cfg = { ...DEFAULTS, ...d, events: { ...DEFAULTS.events, ...(d.events || {}) } }; } catch { cfg = { ...DEFAULTS }; }
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
const enabled = () => !!(cfg.ntfyUrl || cfg.discordUrl || cfg.webhookUrl);
const httpUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };

// n = { event, title, message, url?, priority? (1-5), tags? [] }
async function send(n) {
  if (!enabled()) return { sent: [] };
  const click = n.url || cfg.hubUrl || undefined;
  const jobs = [];
  if (cfg.ntfyUrl) {
    // JSON publishing keeps emoji/UTF-8 intact (headers can't carry it).
    const u = new URL(cfg.ntfyUrl);
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    jobs.push(['ntfy', fetch(u.origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.ntfyToken ? { Authorization: `Bearer ${cfg.ntfyToken}` } : {}) },
      body: JSON.stringify({ topic, title: n.title, message: n.message || n.title, priority: n.priority || 3, tags: n.tags || [], ...(click ? { click } : {}) }),
      signal: AbortSignal.timeout(15000),
    })]);
  }
  if (cfg.discordUrl) {
    jobs.push(['discord', fetch(cfg.discordUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Agent Hub', content: `**${n.title}**\n${n.message || ''}${click ? `\n${click}` : ''}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(15000),
    })]);
  }
  if (cfg.webhookUrl) {
    jobs.push(['webhook', fetch(cfg.webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'agent-hub', event: n.event, title: n.title, message: n.message, url: click, ts: Date.now() }),
      signal: AbortSignal.timeout(15000),
    })]);
  }
  const results = await Promise.all(jobs.map(async ([name, p]) => {
    try {
      const r = await p;
      return r.ok ? { name, ok: true } : { name, ok: false, error: `HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}` };
    } catch (e) { return { name, ok: false, error: e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code || e.message) }; }
  }));
  lastSent.at = Date.now();
  lastSent.error = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`).join('; ');
  if (lastSent.error) console.warn('[notify]', lastSent.error);
  return { sent: results };
}

// Called by automations when a run ends.
function jobEnded(j) {
  const ok = j.status === 'succeeded';
  if (ok ? !cfg.events.jobSucceeded : !cfg.events.jobFailed) return;
  if (j.status === 'cancelled') return;
  const what = { fix_issue: `Fix #${j.number}`, pr_task: `PR #${j.number}`, review: `Review #${j.number}`, task: j.ruleName }[j.kind] || j.kind;
  send({
    event: ok ? 'job.succeeded' : 'job.failed',
    title: `${ok ? '✅' : '❌'} ${what} · ${j.repo}`,
    message: ok ? `${j.title ? j.title + '\n' : ''}${j.result || 'done'}` : `${j.title ? j.title + '\n' : ''}${j.error || j.status}`,
    url: j.resultUrl || j.url,
    priority: ok ? 3 : 4,
    tags: [ok ? 'white_check_mark' : 'x'],
  }).catch(() => {});
}

// ---- "went quiet": a session produced output, then nothing for N minutes (usually waiting for you) ----
const seen = new Map(); // session -> last activity we've already notified about (or baseline)
async function checkIdle() {
  const r = await ctx.run('tmux', ['list-sessions', '-F', '#{session_name}\t#{window_activity}\t#{session_created}\t#{@label}\t#{@repo}\t#{@wt}\t#{@agent}']);
  const now = Math.floor(Date.now() / 1000);
  const alive = new Set();
  for (const line of (r.ok ? r.stdout.trim().split('\n') : []).filter(Boolean)) {
    const [name, act, created, label, repo, wt, agent] = line.split('\t');
    alive.add(name);
    const activity = Number(act);
    if (!seen.has(name)) { seen.set(name, activity); continue; }     // baseline: don't notify for old silence
    if (!cfg.events.idle || !enabled()) { seen.set(name, activity); continue; }
    if (agent === 'update' || name.startsWith('auto-')) continue;      // automations notify when they finish
    if (activity <= seen.get(name) || activity - Number(created) < 5) continue;
    if (now - activity < Math.max(1, cfg.idleMinutes) * 60) continue;
    seen.set(name, activity);
    send({
      event: 'session.idle',
      title: `💤 ${label || name} is waiting`,
      message: `${repo ? `${repo}${wt ? ' / ' + wt : ''}: ` : ''}no output for ${cfg.idleMinutes} min. It may need your answer.`,
      tags: ['hourglass'],
    }).catch(() => {});
  }
  for (const k of seen.keys()) if (!alive.has(k)) seen.delete(k);
}

function register(app, wrap, helpers) {
  ctx = helpers;
  load();
  setInterval(() => checkIdle().catch(() => {}), 20000);

  app.get('/api/notify', wrap(async (req, res) => {
    res.json({ ...cfg, ntfyToken: cfg.ntfyToken ? '••••' : '', enabled: enabled(), last: lastSent });
  }));
  app.post('/api/notify', wrap(async (req, res) => {
    const b = req.body || {};
    const next = { ...cfg };
    for (const k of ['ntfyUrl', 'discordUrl', 'webhookUrl', 'hubUrl']) {
      if (b[k] === undefined) continue;
      const v = String(b[k] || '').trim();
      if (v && !httpUrl(v)) throw new Error(`${k}: must be an http(s) URL`);
      next[k] = v;
    }
    if (next.ntfyUrl && !new URL(next.ntfyUrl).pathname.replace(/\//g, '')) throw new Error('ntfy URL needs a topic, e.g. https://ntfy.sh/my-agent-hub-8f3k');
    if (b.ntfyToken !== undefined && b.ntfyToken !== '••••') next.ntfyToken = String(b.ntfyToken || '').trim();
    if (b.events) next.events = { jobSucceeded: !!b.events.jobSucceeded, jobFailed: !!b.events.jobFailed, idle: !!b.events.idle };
    if (b.idleMinutes !== undefined) next.idleMinutes = Math.max(1, Math.min(120, Number(b.idleMinutes) | 0 || 3));
    cfg = next; save();
    res.json({ ok: true });
  }));
  app.post('/api/notify/test', wrap(async (req, res) => {
    if (!enabled()) throw new Error('Add an ntfy, Discord or webhook URL first');
    const r = await send({ event: 'test', title: '🔔 Agent Hub test', message: 'Notifications are working.', tags: ['bell'] });
    res.json(r);
  }));
}

module.exports = { register, jobEnded, send };
