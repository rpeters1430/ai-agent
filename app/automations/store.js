'use strict';
// Shared automation state (settings, watched repos, rules, jobs), its files on disk, and small text helpers.
const fs = require('fs');
const path = require('path');

// ctx, data and jobs are replaced at runtime, so they live on module.exports and every module reads them as
// store.ctx / store.data / store.jobs (a destructured copy would go stale).
const store = module.exports;

const HUB_DIR = path.join(process.env.HOME || '/home/dev', '.agent-hub');
const RULES_FILE = path.join(HUB_DIR, 'automations.json');
const JOBS_FILE = path.join(HUB_DIR, 'automation-jobs.json');
const JOBS_DIR = path.join(HUB_DIR, 'jobs');
const MARK = '<!-- agent-hub -->'; // on every comment we post, so we never react to ourselves
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const FULL_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const KEYWORD_RE = /^@[A-Za-z0-9_.-]{2,39}$/;
const TRIGGERS = ['label', 'mention', 'new_pr', 'schedule', 'ci_failure'];
const MAX_PROMPT_BYTES = 110 * 1024; // stay safely below Linux MAX_ARG_STRLEN (128 KiB)
const MAX_JOBS = 150;
const MAX_AUTO_FIX_ROUNDS = 3;
const MAX_WATCH_PROFILES = 20;

const DEFAULT_SETTINGS = { pollSeconds: 60, maxConcurrent: 1, timeoutMinutes: 60, loopLimit: 4, paused: false };
const DEFAULT_WATCH = {
  agent: '',
  model: '',
  reviewAgent: '',
  reviewModel: '',
  fixEnabled: true,
  fixLabel: 'agent-fix',
  autoReviewAfterFix: true,
  autoFixRounds: 0,
  autoFixCi: false,
  reviewLabelEnabled: true,
  reviewLabel: 'agent-review',
  reviewNewPrs: true,
  rereviewOnPush: false,
  mentionEnabled: false,
  keyword: '@agent',
  draft: true,
  allowOutside: false,
  instructions: '',
  profiles: [],
};

store.ctx = null; // helpers from server.js, set by register()
store.data = { settings: {}, watch: { ...DEFAULT_WATCH }, watchedRepos: [], rules: [] };
store.jobs = [];
const running = new Map(); // job id -> { cancel }
const poll = { last: 0, error: '', busy: false };

const settings = () => ({ ...DEFAULT_SETTINGS, ...(store.data.settings || {}) });
const watchConfig = () => ({ ...DEFAULT_WATCH, ...(store.data.watch || {}) });

function load() {
  try { store.data = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); } catch { store.data = { settings: {}, watch: { ...DEFAULT_WATCH }, watchedRepos: [], rules: [] }; }
  store.data.rules ||= [];
  store.data.watchedRepos ||= [];
  store.data.watch = { ...DEFAULT_WATCH, ...(store.data.watch || {}), profiles: Array.isArray(store.data.watch?.profiles) ? store.data.watch.profiles : [] };
  try { store.jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch { store.jobs = []; }
  // The container restarted: running jobs are gone, queued ones can still run.
  for (const j of store.jobs) if (j.status === 'running') Object.assign(j, { status: 'interrupted', step: '', endedAt: Date.now(), error: 'Agent Hub restarted while this job was running. The worktree was kept.' });
}
function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const saveRules = () => writeAtomic(RULES_FILE, store.data);
function saveJobs() {
  if (store.jobs.length > MAX_JOBS) {
    const dropped = store.jobs.slice(0, store.jobs.length - MAX_JOBS);
    store.jobs = store.jobs.slice(-MAX_JOBS);
    for (const j of dropped) {
      if (j.id) fs.rmSync(path.join(JOBS_DIR, j.id), { recursive: true, force: true });
    }
  }
  writeAtomic(JOBS_FILE, store.jobs);
}
function pruneOrphanJobDirs() {
  try {
    const keep = new Set(store.jobs.map((j) => j.id));
    for (const e of fs.readdirSync(JOBS_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !keep.has(e.name)) fs.rmSync(path.join(JOBS_DIR, e.name), { recursive: true, force: true });
    }
  } catch {}
}
const readIf = (f, max = 200000) => { try { const s = fs.readFileSync(f, 'utf8'); return s.length > max ? s.slice(-max) : s; } catch { return ''; } };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?!\n)/g, '');
const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '\n…(truncated)' : s || '');
function clipBytes(s, maxBytes) {
  if (!s) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const suffix = '\n…(truncated)';
  const cut = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  // Back off from UTF-8 continuation bytes so we never split a multi-byte character.
  let end = cut;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + suffix;
}

const step = (j, s) => { j.step = s; saveJobs(); };

// Promise-chain mutex: calls with the same key run one after another, in order.
const locks = new Map();
function withLock(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

Object.assign(module.exports, { HUB_DIR, RULES_FILE, JOBS_FILE, JOBS_DIR, MARK, TRUSTED, FULL_RE, KEYWORD_RE, TRIGGERS, MAX_PROMPT_BYTES, MAX_JOBS, MAX_AUTO_FIX_ROUNDS, MAX_WATCH_PROFILES, DEFAULT_SETTINGS, DEFAULT_WATCH, running, poll, settings, watchConfig, load, writeAtomic, saveRules, saveJobs, pruneOrphanJobDirs, readIf, stripAnsi, clip, clipBytes, step, locks, withLock });
