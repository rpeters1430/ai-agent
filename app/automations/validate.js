'use strict';
// Validation and normalisation of automation settings: repos, labels, models, cron, watch workflow and rules.
const { HEADLESS_AGENTS: HEADLESS } = require('../agents');
const { MODEL_RE: DEFAULT_MODEL_RE, OLLAMA_CLI_KEYS } = require('../ollama');
const { newId } = require('./queue');
const { DEFAULT_WATCH, FULL_RE, KEYWORD_RE, MAX_AUTO_FIX_ROUNDS, MAX_WATCH_PROFILES, TRIGGERS } = require('./store');
const store = require('./store'); // store.ctx / store.data / store.jobs are replaced at runtime: always read them through store

function normalizeRepo(raw) {
  const repo = String(raw || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!FULL_RE.test(repo)) throw new Error('Repository must look like owner/name');
  return repo;
}

function validateLabel(raw, fallback = '') {
  const label = String(raw ?? fallback).trim();
  if (!label || label.length > 50 || /[\n\r,]/.test(label)) throw new Error('Label must be 1-50 characters, no commas');
  return label;
}

function validateModel(agent, model) {
  if (!model) return '';
  if (!OLLAMA_CLI_KEYS.includes(agent)) throw new Error(`A local Ollama model only works with: ${OLLAMA_CLI_KEYS.join(', ')}`);
  if (!(store.ctx?.MODEL_RE || DEFAULT_MODEL_RE).test(model)) throw new Error('invalid model');
  return model;
}

function defaultAgent() {
  if (store.data.watch?.agent && HEADLESS[store.data.watch.agent]) return store.data.watch.agent;
  for (const r of store.data.rules || []) {
    if (r.agent && HEADLESS[r.agent] && (!store.ctx || store.ctx.isBinInstalled(HEADLESS[r.agent].bin))) return r.agent;
  }
  const order = ['claude', 'agy', 'codex', 'gemini', 'qwen', 'dsh', 'opencode', 'pi'];
  for (const k of order) {
    if (HEADLESS[k] && (!store.ctx || store.ctx.isBinInstalled(HEADLESS[k].bin))) return k;
  }
  return Object.keys(HEADLESS)[0] || 'claude';
}

const CRON_BOUNDS = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7],  // day of week (0 and 7 both mean Sunday)
];

function parseCronField(field, min, max) {
  const vals = new Set();
  for (const part of String(field || '').split(',')) {
    const [rangeStr, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}"`);
    let lo, hi;
    if (rangeStr === '*') {
      lo = min; hi = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) throw new Error(`Invalid cron range "${part}"`);
      lo = a; hi = b;
    } else {
      const n = Number(rangeStr);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid cron value "${part}"`);
      lo = n; hi = stepStr === undefined ? n : max;
    }
    for (let v = lo; v <= hi; v += step) vals.add(v);
  }
  if (!vals.size) throw new Error('Empty cron field');
  return vals;
}

function validateCron(expr) {
  const clean = String(expr || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  const parts = clean.split(' ');
  if (parts.length !== 5) throw new Error('Cron expression must have 5 fields: min hour dom month dow (e.g. "0 2 * * 1-5")');
  parts.forEach((p, i) => parseCronField(p, CRON_BOUNDS[i][0], CRON_BOUNDS[i][1]));
  return clean;
}

function matchesCron(expr, date = new Date()) {
  const parts = String(expr || '').trim().replace(/\s+/g, ' ').split(' ');
  if (parts.length !== 5) return false;
  try {
    const [mins, hrs, doms, mons, dows] = parts.map((p, i) => parseCronField(p, CRON_BOUNDS[i][0], CRON_BOUNDS[i][1]));
    if (dows.has(7)) dows.add(0);
    return mins.has(date.getMinutes()) && hrs.has(date.getHours()) && doms.has(date.getDate())
      && mons.has(date.getMonth() + 1) && dows.has(date.getDay());
  } catch { return false; }
}

function cleanWatch(b, old = {}) {
  const w = { ...DEFAULT_WATCH, ...old };
  const agent = String(b.agent ?? w.agent ?? '').trim();
  if (!HEADLESS[agent]) throw new Error('Choose a valid worker agent');
  w.agent = agent;
  w.model = validateModel(w.agent, String(b.model ?? '').trim());

  const reviewAgent = String(b.reviewAgent ?? '').trim();
  if (reviewAgent && !HEADLESS[reviewAgent]) throw new Error('unknown reviewer agent');
  w.reviewAgent = reviewAgent;
  w.reviewModel = reviewAgent ? validateModel(reviewAgent, String(b.reviewModel ?? '').trim()) : '';

  w.fixEnabled = b.fixEnabled !== false;
  w.fixLabel = w.fixEnabled ? validateLabel(b.fixLabel, DEFAULT_WATCH.fixLabel) : String(b.fixLabel ?? w.fixLabel ?? DEFAULT_WATCH.fixLabel).trim();
  w.autoReviewAfterFix = w.fixEnabled ? b.autoReviewAfterFix !== false : !!b.autoReviewAfterFix;
  w.autoFixRounds = w.autoReviewAfterFix ? Math.max(0, Math.min(MAX_AUTO_FIX_ROUNDS, Number(b.autoFixRounds) | 0)) : 0;
  w.autoFixCi = !!b.autoFixCi;

  w.reviewLabelEnabled = b.reviewLabelEnabled !== false;
  w.reviewLabel = w.reviewLabelEnabled ? validateLabel(b.reviewLabel, DEFAULT_WATCH.reviewLabel) : String(b.reviewLabel ?? w.reviewLabel ?? DEFAULT_WATCH.reviewLabel).trim();

  const rawProfiles = Array.isArray(b.profiles) ? b.profiles : (Array.isArray(old.profiles) ? old.profiles : []);
  if (rawProfiles.length > MAX_WATCH_PROFILES) throw new Error(`At most ${MAX_WATCH_PROFILES} label profiles are allowed`);
  w.profiles = rawProfiles.map((p) => {
    const enabled = p.enabled !== false;
    const label = validateLabel(p.label);
    const action = p.action === 'review' ? 'review' : 'fix';
    const pAgent = String(p.agent || '').trim();
    if (!HEADLESS[pAgent]) throw new Error(`Label “${label}”: choose a valid agent`);
    const pModel = validateModel(pAgent, String(p.model || '').trim());
    const autoReview = action === 'fix' && p.autoReview !== false;
    const pRevAgent = autoReview ? String(p.reviewAgent || '').trim() : '';
    if (pRevAgent && !HEADLESS[pRevAgent]) throw new Error(`Label “${label}”: unknown reviewer agent`);
    const pRevModel = pRevAgent ? validateModel(pRevAgent, String(p.reviewModel || '').trim()) : '';
    const autoFixRounds = autoReview ? Math.max(0, Math.min(MAX_AUTO_FIX_ROUNDS, Number(p.autoFixRounds) | 0)) : 0;
    const id = String(p.id || '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || newId();
    return { id, label, action, agent: pAgent, model: pModel, autoReview, reviewAgent: pRevAgent, reviewModel: pRevModel, autoFixRounds, enabled };
  });

  const usedLabels = new Set();
  const claimLabel = (lbl) => {
    const k = lbl.toLowerCase();
    if (usedLabels.has(k)) throw new Error(`Duplicate label “${lbl}” — each enabled trigger label must be unique`);
    usedLabels.add(k);
  };
  if (w.fixEnabled && w.fixLabel) claimLabel(w.fixLabel);
  if (w.reviewLabelEnabled && w.reviewLabel) claimLabel(w.reviewLabel);
  for (const p of w.profiles) if (p.enabled) claimLabel(p.label);

  w.reviewNewPrs = b.reviewNewPrs !== false;
  w.rereviewOnPush = !!b.rereviewOnPush;

  w.mentionEnabled = !!b.mentionEnabled;
  let kw = String(b.keyword ?? w.keyword ?? '@agent').trim();
  if (kw && !kw.startsWith('@')) kw = '@' + kw;
  if (w.mentionEnabled && !KEYWORD_RE.test(kw)) throw new Error('Keyword must look like @agent');
  w.keyword = kw || '@agent';

  w.draft = b.draft !== false;
  w.allowOutside = !!b.allowOutside;
  w.instructions = String(b.instructions ?? '').slice(0, 20000);
  return w;
}

function cleanRule(b, old = {}) {
  const r = { ...old };
  r.repo = normalizeRepo(b.repo);
  if (!TRIGGERS.includes(b.trigger)) throw new Error('unknown trigger');
  r.trigger = b.trigger;
  if (!HEADLESS[b.agent]) throw new Error('unknown agent');
  r.agent = b.agent;
  r.model = validateModel(r.agent, String(b.model || '').trim());
  r.action = r.trigger === 'label' && b.action === 'review' ? 'review' : 'fix';
  r.label = String(b.label || '').trim();
  if (r.trigger === 'label') r.label = validateLabel(r.label);
  r.keyword = String(b.keyword || '@agent').trim();
  if (!r.keyword.startsWith('@')) r.keyword = '@' + r.keyword;
  if (r.trigger === 'mention' && !KEYWORD_RE.test(r.keyword)) throw new Error('Keyword must look like @agent');
  r.everyHours = Math.max(1, Math.min(24 * 30, Number(b.everyHours) || 24));
  r.cron = r.trigger === 'schedule' ? validateCron(b.cron || '') : '';
  r.instructions = String(b.instructions || '').slice(0, 20000);
  if (r.trigger === 'schedule' && !r.instructions.trim()) throw new Error('A scheduled task needs instructions');
  r.rereview = !!b.rereview;
  r.allowOutside = !!b.allowOutside;
  r.draft = b.draft !== false;
  r.enabled = b.enabled !== false;

  const canAutoReview = (r.trigger === 'label' && r.action === 'fix') || r.trigger === 'mention' || r.trigger === 'ci_failure';
  r.autoReview = canAutoReview && !!b.autoReview;
  const revAgent = canAutoReview && r.autoReview ? String(b.reviewAgent || '').trim() : '';
  if (revAgent && !HEADLESS[revAgent]) throw new Error('unknown reviewer agent');
  r.reviewAgent = revAgent;
  r.reviewModel = revAgent ? validateModel(revAgent, String(b.reviewModel || '').trim()) : '';
  r.autoFixRounds = r.autoReview ? Math.max(0, Math.min(MAX_AUTO_FIX_ROUNDS, Number(b.autoFixRounds) | 0)) : 0;

  const auto = {
    label: `${r.action === 'review' ? 'Review PRs' : (r.autoReview ? 'Fix & review issues' : 'Fix issues')} labeled ${r.label}`,
    mention: `Answer ${r.keyword} mentions`,
    new_pr: 'Review new PRs',
    ci_failure: 'Auto-fix failing CI checks on PRs',
    schedule: `${r.cron ? `Cron (${r.cron})` : `Every ${r.everyHours}h`}: ${r.instructions.split('\n')[0].slice(0, 40)}`,
  }[r.trigger];
  r.name = String(b.name || '').trim().slice(0, 80) || auto;
  return r;
}

Object.assign(module.exports, { normalizeRepo, validateLabel, validateModel, defaultAgent, CRON_BOUNDS, parseCronField, validateCron, matchesCron, cleanWatch, cleanRule });
