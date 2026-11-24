'use strict';
// Update the agent CLIs from the UI. Updates go to ~/.local/tools (on the persistent home volume),
// which comes first in PATH, so they survive container rebuilds. "Reset" falls back to the image's versions.
const fs = require('fs');
const path = require('path');
const { UPDATABLE_TOOLS: TOOLS } = require('./agents');

const HOME = process.env.HOME || '/home/dev';
const PREFIX = path.join(HOME, '.local', 'tools');
const SESSION = 'update-clis';
const latestCache = new Map(); // pkg -> { t, v }
const VER_RE = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/;

let ctx;

async function latest(pkg) {
  const c = latestCache.get(pkg);
  if (c && Date.now() - c.t < 30 * 60 * 1000) return c.v;
  let v = '';
  const enc = pkg.replace('/', '%2F');
  try {
    const r = await fetch(`https://registry.npmjs.org/${enc}/latest`, { headers: { Accept: 'application/json', 'User-Agent': 'agent-hub' }, signal: AbortSignal.timeout(15000) });
    if (r.ok) v = (await r.json()).version || '';
    else {
      // Prerelease-only packages (e.g. @deepseek-ai/dsh) may only have next/alpha/beta dist-tags.
      const r2 = await fetch(`https://registry.npmjs.org/-/package/${enc}/dist-tags`, { headers: { Accept: 'application/json', 'User-Agent': 'agent-hub' }, signal: AbortSignal.timeout(15000) });
      if (r2.ok) {
        const dt = await r2.json();
        v = dt.latest || dt.next || dt.alpha || dt.beta || Object.values(dt)[0] || '';
      }
    }
  } catch {}
  if (v) latestCache.set(pkg, { t: Date.now(), v });
  return v || c?.v || '';
}

// Installed versions change only when something updates, so cache them briefly.
let infoCache = { t: 0, tools: null };
async function toolInfo(t) {
  const binName = t.bin || t.key;
  const [where, ver, lv] = await Promise.all([
    ctx.run('bash', ['-lc', `command -v ${binName}`]),
    ctx.run('bash', ['-lc', `${binName} --version 2>/dev/null | head -3`], { timeout: 60000 }),
    t.pkg ? latest(t.pkg) : Promise.resolve(''),
  ]);
  const bin = where.stdout.trim();
  const version = (ver.stdout.match(VER_RE) || [''])[0];
  return {
    key: t.key, label: t.label, installed: where.ok, version, latest: lv,
    outdated: !!(lv && version && lv !== version),
    source: bin.startsWith(PREFIX + '/') ? 'updated' : bin ? 'image' : '',
  };
}

function updateScript(keys) {
  const list = TOOLS.filter((t) => keys.includes(t.key));
  const standardPkgs = list.filter((t) => t.pkg && t.pkg !== '@deepseek-ai/dsh').map((t) => `${t.pkg}@latest`);
  const hasDsh = list.some((t) => t.pkg === '@deepseek-ai/dsh');
  const lines = ['set -u', 'export NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false', `mkdir -p '${PREFIX}/bin'`, 'fail=0'];
  if (standardPkgs.length) lines.push(`echo "== npm: ${standardPkgs.join(' ')}"`, `npm install -g --prefix '${PREFIX}' ${standardPkgs.join(' ')} || fail=1`);
  if (hasDsh) {
    lines.push(
      'echo; echo "== DeepSeek Harness (@deepseek-ai/dsh)"',
      `npm install -g --prefix '${PREFIX}' @deepseek-ai/dsh@latest || npm install -g --prefix '${PREFIX}' @deepseek-ai/dsh@next || npm install -g --prefix '${PREFIX}' @deepseek-ai/dsh@alpha || fail=1`
    );
  }
  for (const t of list.filter((x) => x.installer)) {
    lines.push(`echo; echo "== ${t.label}"`, `curl -fsSL '${t.installer}' | bash -s -- --dir '${PREFIX}/bin' || fail=1`);
  }
  lines.push('hash -r', 'echo; echo "== Versions now:"');
  for (const t of list) {
    const b = t.bin || t.key;
    lines.push(`printf '%-14s ' '${b}'; v="$(${b} --version 2>/dev/null | head -1)"; [ -n "$v" ] && printf '%s\\n' "$v" || (${b} --version 2>&1 | head -1)`);
  }
  lines.push('echo', 'if [ $fail = 0 ]; then echo "Done. New sessions use the new versions; restart running agents to pick them up."; else echo "Some updates failed - see above."; fi');
  return lines.join('\n');
}

function register(app, wrap, helpers) {
  ctx = helpers;

  app.get('/api/tools', wrap(async (req, res) => {
    if (req.query.fresh || !infoCache.tools || Date.now() - infoCache.t > 10 * 60 * 1000) {
      const tools = [];
      for (const t of TOOLS) tools.push(await toolInfo(t)); // one at a time: starting 5 CLIs at once is slow on a NAS
      infoCache = { t: Date.now(), tools };
    }
    const tools = infoCache.tools;
    const updating = (await ctx.run('tmux', ['has-session', '-t', `=${SESSION}`])).ok;
    res.json({ tools, updating, session: SESSION, hasUpdates: fs.existsSync(PREFIX) });
  }));

  app.post('/api/tools/update', wrap(async (req, res) => {
    const keys = Array.isArray(req.body?.tools) && req.body.tools.length ? req.body.tools.map(String) : TOOLS.map((t) => t.key);
    if (!keys.every((k) => TOOLS.some((t) => t.key === k))) throw new Error('unknown tool');
    if ((await ctx.run('tmux', ['has-session', '-t', `=${SESSION}`])).ok) return res.json({ ok: true, session: SESSION });
    latestCache.clear(); infoCache.tools = null;
    const script = `${updateScript(keys)}\necho; echo "[finished - this window stays open until you close it]"; exec bash -l`;
    const r = await ctx.run('tmux', ['new-session', '-d', '-s', SESSION, '-c', HOME, '-x', '200', '-y', '50', 'bash', '-lc', script]);
    if (!r.ok) throw new Error(r.stderr.trim() || 'tmux failed');
    await ctx.run('tmux', ['set-option', '-t', SESSION, '@agent', 'update']);
    await ctx.run('tmux', ['set-option', '-t', SESSION, '@label', 'Update CLIs']);
    res.json({ ok: true, session: SESSION });
  }));

  // Remove the updated copies and go back to the versions baked into the image.
  app.post('/api/tools/reset', wrap(async (req, res) => {
    fs.rmSync(PREFIX, { recursive: true, force: true });
    infoCache.tools = null;
    res.json({ ok: true });
  }));
}

module.exports = { register, PREFIX };
