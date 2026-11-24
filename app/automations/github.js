'use strict';
// GitHub REST client used by automations, plus comment/label helpers.
const crypto = require('crypto');
const { HEADLESS_AGENTS: HEADLESS } = require('../agents');
const { MARK } = require('./store');
const store = require('./store'); // store.ctx / store.data / store.jobs are replaced at runtime: always read them through store


async function gh(method, url, body) {
  const token = await store.ctx.githubToken();
  if (!token) throw new Error('GitHub is not connected');
  const r = await fetch((process.env.GITHUB_API_URL || 'https://api.github.com') + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-hub', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let out; try { out = text ? JSON.parse(text) : null; } catch { out = text; }
  if (!r.ok) {
    const e = new Error(`GitHub ${method} ${url.split('?')[0]} → ${r.status} ${out?.message || ''}${out?.errors ? ' ' + JSON.stringify(out.errors) : ''}`.trim());
    e.status = r.status; throw e;
  }
  return out;
}
const comment = (repo, n, body) => gh('POST', `/repos/${repo}/issues/${n}/comments`, { body: `${body}\n\n${MARK}` });
let me = null;
let meTokenHash = '';
async function whoami() {
  const token = await store.ctx.githubToken();
  const h = token ? crypto.createHash('sha256').update(token).digest('hex') : '';
  if (!me || meTokenHash !== h) {
    me = await gh('GET', '/user');
    meTokenHash = h;
  }
  return me;
}

async function ensureLabels(repo, defs) {
  const warnings = [];
  for (const def of defs) {
    try {
      await gh('POST', `/repos/${repo}/labels`, def);
    } catch (e) {
      if (e.status !== 422) warnings.push(`${repo}: couldn't create label "${def.name}": ${e.message}`);
    }
  }
  return warnings;
}

function watchLabelDefs(w) {
  const defs = [];
  const workerLabel = HEADLESS[w.agent]?.label || w.agent || 'Agent Hub';
  const revKey = w.reviewAgent || w.agent;
  const revLabel = HEADLESS[revKey]?.label || revKey || 'Agent Hub';
  if (w.fixEnabled && w.fixLabel) {
    defs.push({
      name: w.fixLabel,
      color: 'e0864a',
      description: `Agent Hub: fix${w.autoReviewAfterFix ? ' & review' : ''} with ${workerLabel}${w.model ? ` (${w.model})` : ''}`.slice(0, 100),
    });
  }
  if (w.reviewLabelEnabled && w.reviewLabel) {
    defs.push({
      name: w.reviewLabel,
      color: '1d76db',
      description: `Agent Hub: review this PR with ${revLabel}${w.reviewModel ? ` (${w.reviewModel})` : ''}`.slice(0, 100),
    });
  }
  for (const p of w.profiles || []) {
    if (p.enabled === false || !p.label) continue;
    const pAgent = HEADLESS[p.agent]?.label || p.agent || 'Agent Hub';
    const isRev = p.action === 'review';
    defs.push({
      name: p.label,
      color: isRev ? '5319e7' : '0e8a16',
      description: `Agent Hub: ${isRev ? 'review PR' : `fix${p.autoReview ? ' & review' : ''}`} with ${pAgent}${p.model ? ` (${p.model})` : ''}`.slice(0, 100),
    });
  }
  return defs;
}

Object.assign(module.exports, { gh, comment, whoami, ensureLabels, watchLabelDefs });
