'use strict';
// Workspace enhancements: rich git diff/actions, file & image browser, image/file upload into container,
// prompt snippets library, multi-agent Arena compare, and container/worktree health & cleanup.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AGENTS } = require('./agents');

const HOME = process.env.HOME || '/home/dev';
const HUB_DIR = path.join(HOME, '.agent-hub');
const SNIPPETS_FILE = path.join(HUB_DIR, 'snippets.json');
const UPLOAD_DIR = path.join(os.tmpdir(), 'agent-hub-uploads');
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};

const DEFAULT_SNIPPETS = [
  { id: 'def-tests', title: 'Run tests & fix', text: 'Run the test suite, inspect any failures, and fix them cleanly.' },
  { id: 'def-review', title: 'Review diff', text: 'Review my current git diff for bugs, edge cases, and security issues without editing files.' },
  { id: 'def-commit', title: 'Commit changes', text: 'Inspect git status and git diff, then create a clean, well-scoped git commit.' },
  { id: 'def-compact', title: '/compact', text: '/compact' },
  { id: 'def-explain', title: 'Explain codebase', text: 'Summarize the architecture and key entry points of this repository.' },
];

function writeAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadSnippets() {
  try {
    const arr = JSON.parse(fs.readFileSync(SNIPPETS_FILE, 'utf8'));
    if (Array.isArray(arr)) return arr;
  } catch {}
  return DEFAULT_SNIPPETS.map((s) => ({ ...s }));
}

function safeSubpath(root, rel) {
  const cleanRel = String(rel || '').replace(/^\/+/, '');
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, cleanRel);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error('path escapes repository');
  }
  return full;
}

function pruneOldUploads(maxAgeMs = 24 * 3600 * 1000) {
  let removed = 0;
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return 0;
    const now = Date.now();
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > maxAgeMs) { fs.unlinkSync(p); removed++; }
      } catch {}
    }
  } catch {}
  return removed;
}

async function detectListeningPorts(run, excludePort) {
  const ports = new Set();
  const r = await run('ss', ['-tlnH']);
  if (r.ok && r.stdout) {
    for (const line of r.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      const local = cols[3] || '';
      const m = local.match(/:(\d+)$/);
      if (m) {
        const p = Number(m[1]);
        if (p >= 1024 && p <= 65535 && p !== excludePort) ports.add(p);
      }
    }
  } else {
    // Fallback to /proc/net/tcp & /proc/net/tcp6
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        const lines = fs.readFileSync(f, 'utf8').split('\n').slice(1);
        for (const l of lines) {
          const cols = l.trim().split(/\s+/);
          if (cols[3] !== '0A') continue; // 0A = LISTEN
          const hexPort = (cols[1] || '').split(':')[1];
          const p = parseInt(hexPort, 16);
          if (p >= 1024 && p <= 65535 && p !== excludePort) ports.add(p);
        }
      } catch {}
    }
  }
  return [...ports].sort((a, b) => a - b);
}

function register(app, wrap, helpers) {
  const { run, targetDir, repoDir, wtDir, WT_ROOT, WORKSPACE, branchSlug, tmuxName, tmuxSessions, envOverrides, PORT } = helpers;

  // ---- Image / File Upload (saves into container /tmp/agent-hub-uploads so agents can read it) ----
  app.post('/api/upload', wrap(async (req, res) => {
    const rawName = String(req.body?.filename || 'paste.png');
    const rawData = String(req.body?.data || '');
    if (!rawData) throw new Error('No file data provided');
    const b64 = rawData.includes(',') && rawData.startsWith('data:') ? rawData.slice(rawData.indexOf(',') + 1) : rawData;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('Empty file');
    if (buf.length > MAX_UPLOAD_BYTES) throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit`);
    const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'upload.bin';
    fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    pruneOldUploads();
    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName.slice(0, 60)}`;
    const dest = path.join(UPLOAD_DIR, id);
    fs.writeFileSync(dest, buf, { mode: 0o644 });
    res.json({ ok: true, path: dest, filename: id, size: buf.length, url: `/api/uploads/${encodeURIComponent(id)}` });
  }));

  app.get('/api/uploads/:name', wrap(async (req, res) => {
    const name = path.basename(String(req.params.name || ''));
    if (!name || name !== req.params.name) throw new Error('invalid filename');
    const full = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    const ext = path.extname(name).toLowerCase();
    res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(full).pipe(res);
  }));

  // ---- Rich Git Diff & Branch/Commit/Stash Actions ----
  app.get('/api/repos/:name/diff', wrap(async (req, res) => {
    const wt = req.query.wt ? String(req.query.wt) : '';
    const dir = targetDir(req.params.name, wt);
    if (!fs.existsSync(dir)) throw new Error('not found');
    const [br, brList, statusR, diffHead, diffStaged, statR] = await Promise.all([
      run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD']),
      run('git', ['-C', dir, 'branch', '--format=%(refname:short)']),
      run('git', ['-C', dir, 'status', '--porcelain']),
      run('git', ['-C', dir, 'diff', '--no-color', 'HEAD']),
      run('git', ['-C', dir, 'diff', '--no-color', '--cached']),
      run('git', ['-C', dir, 'diff', '--stat', 'HEAD']),
    ]);
    const files = statusR.stdout.split('\n').filter(Boolean).map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3).trim(),
      untracked: line.startsWith('??'),
    }));
    const fullDiff = (diffHead.ok ? diffHead.stdout : diffStaged.stdout || '').slice(0, 500000);
    const branches = brList.ok ? brList.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    res.json({
      branch: br.stdout.trim() || '(detached)',
      branches,
      files,
      stat: statR.stdout.trim(),
      diff: fullDiff,
      truncated: (diffHead.stdout || '').length > 500000,
    });
  }));

  app.post('/api/repos/:name/git/action', wrap(async (req, res) => {
    const wt = req.body?.wt ? String(req.body.wt) : '';
    const dir = targetDir(req.params.name, wt);
    if (!fs.existsSync(dir)) throw new Error('not found');
    const action = String(req.body?.action || '');
    if (action === 'commit') {
      const msg = String(req.body?.message || '').trim();
      if (!msg) throw new Error('Commit message is required');
      if (req.body?.addAll !== false) {
        const a = await run('git', ['-C', dir, 'add', '-A']);
        if (!a.ok) throw new Error((a.stderr || a.stdout).trim() || 'git add failed');
      }
      const c = await run('git', ['-C', dir, 'commit', '-m', msg]);
      if (!c.ok) throw new Error((c.stderr || c.stdout).trim() || 'git commit failed');
      return res.json({ ok: true, output: (c.stdout + c.stderr).trim() });
    }
    if (action === 'checkout') {
      const branch = String(req.body?.branch || '').trim();
      if (!branch || branch.startsWith('-')) throw new Error('invalid branch');
      const args = req.body?.create ? ['checkout', '-b', branch] : ['checkout', branch];
      const r = await run('git', ['-C', dir, ...args]);
      if (!r.ok) throw new Error((r.stderr || r.stdout).trim() || 'checkout failed');
      return res.json({ ok: true, output: (r.stdout + r.stderr).trim() });
    }
    if (action === 'stash') {
      const args = req.body?.pop ? ['stash', 'pop'] : ['stash', 'push', '-u', '-m', String(req.body?.message || 'agent-hub stash').slice(0, 120)];
      const r = await run('git', ['-C', dir, ...args]);
      if (!r.ok) throw new Error((r.stderr || r.stdout).trim() || 'stash failed');
      return res.json({ ok: true, output: (r.stdout + r.stderr).trim() });
    }
    if (action === 'discard') {
      const file = String(req.body?.file || '').trim();
      if (!file) throw new Error('file is required');
      const full = safeSubpath(dir, file);
      const st = await run('git', ['-C', dir, 'status', '--porcelain', '--', file]);
      if (st.stdout.startsWith('??')) {
        fs.rmSync(full, { recursive: true, force: true });
        return res.json({ ok: true, output: `Removed untracked ${file}` });
      }
      const r = await run('git', ['-C', dir, 'checkout', 'HEAD', '--', file]);
      if (!r.ok) throw new Error((r.stderr || r.stdout).trim() || 'discard failed');
      return res.json({ ok: true, output: `Reverted ${file}` });
    }
    throw new Error('unknown git action');
  }));

  // ---- File Explorer & Preview ----
  app.get('/api/repos/:name/files', wrap(async (req, res) => {
    const wt = req.query.wt ? String(req.query.wt) : '';
    const rel = String(req.query.dir || '');
    const root = targetDir(req.params.name, wt);
    if (!fs.existsSync(root)) throw new Error('not found');
    const dir = safeSubpath(root, rel);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = 0;
        try { if (e.isFile()) size = fs.statSync(full).size; } catch {}
        const ext = path.extname(e.name).toLowerCase();
        return {
          name: e.name,
          path: path.posix.join(rel.replace(/\\/g, '/'), e.name),
          dir: e.isDirectory(),
          size,
          isImage: e.isFile() && IMAGE_EXTS.has(ext),
        };
      })
      .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    res.json({ dir: rel, entries: entries.slice(0, 500) });
  }));

  app.get('/api/repos/:name/file', wrap(async (req, res) => {
    const wt = req.query.wt ? String(req.query.wt) : '';
    const rel = String(req.query.path || '');
    if (!rel) throw new Error('path required');
    const root = targetDir(req.params.name, wt);
    const full = safeSubpath(root, rel);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error('not a file');
    const ext = path.extname(full).toLowerCase();
    const isImage = IMAGE_EXTS.has(ext);
    if (req.query.raw === '1') {
      res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
      return fs.createReadStream(full).pipe(res);
    }
    if (isImage) {
      return res.json({ path: rel, size: st.size, isImage: true, rawUrl: `/api/repos/${encodeURIComponent(req.params.name)}/file?wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(rel)}&raw=1` });
    }
    const maxBytes = 300 * 1024;
    const fd = fs.openSync(full, 'r');
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    const isBinary = buf.includes(0);
    res.json({
      path: rel,
      size: st.size,
      isImage: false,
      isBinary,
      truncated: st.size > maxBytes,
      content: isBinary ? '' : buf.toString('utf8'),
    });
  }));

  // ---- Prompt Snippets ----
  app.get('/api/snippets', wrap(async (req, res) => {
    res.json({ snippets: loadSnippets() });
  }));

  app.post('/api/snippets', wrap(async (req, res) => {
    const title = String(req.body?.title || '').trim().slice(0, 60);
    const text = String(req.body?.text || '').trim().slice(0, 8000);
    if (!title || !text) throw new Error('Title and prompt text are required');
    const list = loadSnippets();
    const id = req.body?.id ? String(req.body.id) : crypto.randomBytes(4).toString('hex');
    const idx = list.findIndex((s) => s.id === id);
    const item = { id, title, text };
    if (idx >= 0) list[idx] = item; else list.push(item);
    writeAtomic(SNIPPETS_FILE, list);
    res.json({ ok: true, snippet: item, snippets: list });
  }));

  app.delete('/api/snippets/:id', wrap(async (req, res) => {
    const list = loadSnippets().filter((s) => s.id !== req.params.id);
    writeAtomic(SNIPPETS_FILE, list);
    res.json({ ok: true, snippets: list });
  }));

  // ---- Multi-Agent Compare / Arena ----
  app.post('/api/repos/:name/arena', wrap(async (req, res) => {
    const repo = req.params.name;
    const dir = repoDir(repo);
    if (!fs.existsSync(path.join(dir, '.git'))) throw new Error('not a git repository');
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) throw new Error('Enter a prompt for the agents to compare');
    const picks = Array.isArray(req.body?.agents) ? req.body.agents : [];
    if (picks.length < 2 || picks.length > 4) throw new Error('Pick 2 to 4 agents to compare');
    const base = String(req.body?.base || '').trim() || 'HEAD';
    if (base.startsWith('-')) throw new Error('invalid base');

    const arenaId = crypto.randomBytes(3).toString('hex');
    const promptDir = path.join(HUB_DIR, 'arena', arenaId);
    fs.mkdirSync(promptDir, { recursive: true });
    const promptFile = path.join(promptDir, 'prompt.md');
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

    const existing = new Set((await tmuxSessions()).map((s) => s.name));
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const envPrefix = Object.entries(envOverrides ? envOverrides() : {})
      .map(([k, v]) => `export ${k}=${q(v)}`).join('\n');

    const runs = [];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i] || {};
      const agentKey = String(p.agent || '');
      const model = String(p.model || '').trim();
      const a = AGENTS[agentKey];
      if (!a || typeof a.headless !== 'function') throw new Error(`Agent "${agentKey}" does not support headless arena runs`);
      const branch = `arena/${arenaId}-${i + 1}-${agentKey}`;
      const wt = branchSlug(branch);
      const wdir = wtDir(repo, wt);
      fs.mkdirSync(path.dirname(wdir), { recursive: true });
      const wr = await run('git', ['-C', dir, 'worktree', 'add', '-b', branch, wdir, base], { timeout: 120000 });
      if (!wr.ok) throw new Error((wr.stderr || wr.stdout).trim() || 'git worktree add failed');

      let sess = tmuxName(`arena-${arenaId}-${i + 1}-${agentKey}`);
      let n = 2;
      while (existing.has(sess)) sess = `${sess}-${n++}`;
      existing.add(sess);

      const jobDir = path.join(promptDir, `run-${i + 1}`);
      fs.mkdirSync(jobDir, { recursive: true });
      const label = `Arena ${i + 1} · ${a.label}${model ? ` (${model})` : ''}`;
      const script = [
        envPrefix,
        `JOBDIR=${q(jobDir)}`,
        `P="$(cat ${q(promptFile)})"`,
        `echo "== ${label} (branch ${branch})"`,
        a.headless(model, 4),
        `code=$?; echo; echo "[${label} exited with code $code - dropping to shell]"`,
        'exec bash -l',
      ].filter(Boolean).join('\n');
      const runFile = path.join(jobDir, 'run.sh');
      fs.writeFileSync(runFile, script + '\n', { mode: 0o700 });
      const tr = await run('tmux', ['new-session', '-d', '-s', sess, '-c', wdir, '-x', '200', '-y', '50', 'bash', '-lc', `bash ${q(runFile)}`]);
      if (!tr.ok) throw new Error((tr.stderr || tr.stdout).trim() || 'tmux failed');
      await run('tmux', ['set-option', '-t', sess, '@agent', agentKey]);
      await run('tmux', ['set-option', '-t', sess, '@repo', repo]);
      await run('tmux', ['set-option', '-t', sess, '@label', label]);
      await run('tmux', ['set-option', '-t', sess, '@wt', wt]);
      runs.push({ session: sess, label, agent: agentKey, model, wt, branch });
    }
    res.json({ ok: true, id: arenaId, runs });
  }));

  // ---- Container & Worktree Health + Prune ----
  app.get('/api/system/health', wrap(async (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const [dfR, wtDuR, ports] = await Promise.all([
      run('df', ['-B1', WORKSPACE], { timeout: 5000 }),
      fs.existsSync(WT_ROOT) ? run('du', ['-sb', WT_ROOT], { timeout: 10000 }) : Promise.resolve({ ok: true, stdout: '0\t' }),
      detectListeningPorts(run, PORT),
    ]);
    let disk = null;
    if (dfR.ok) {
      const cols = (dfR.stdout.trim().split('\n')[1] || '').trim().split(/\s+/);
      if (cols.length >= 5) {
        disk = { total: Number(cols[1]) || 0, used: Number(cols[2]) || 0, avail: Number(cols[3]) || 0, pct: cols[4] || '' };
      }
    }
    const worktreesBytes = wtDuR.ok ? Number((wtDuR.stdout.trim().split(/\s+/)[0]) || 0) : 0;
    let worktreeCount = 0;
    if (fs.existsSync(WT_ROOT)) {
      for (const r of fs.readdirSync(WT_ROOT, { withFileTypes: true })) {
        if (!r.isDirectory()) continue;
        try { worktreeCount += fs.readdirSync(path.join(WT_ROOT, r.name)).length; } catch {}
      }
    }
    res.json({
      uptimeSec: Math.round(os.uptime()),
      processUptimeSec: Math.round(process.uptime()),
      cpus: os.cpus().length,
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      mem: { total: totalMem, used: totalMem - freeMem, free: freeMem },
      disk,
      worktrees: { count: worktreeCount, bytes: worktreesBytes },
      ports,
    });
  }));

  app.post('/api/system/prune', wrap(async (req, res) => {
    const removedUploads = pruneOldUploads(2 * 3600 * 1000);
    let prunedRepos = 0;
    let removedWorktrees = 0;
    const activeSessions = await tmuxSessions();
    const activeWts = new Set(activeSessions.filter((s) => s.wt).map((s) => `${s.repo}/${s.wt}`));

    if (fs.existsSync(WORKSPACE)) {
      for (const e of fs.readdirSync(WORKSPACE, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const dir = path.join(WORKSPACE, e.name);
        if (!fs.existsSync(path.join(dir, '.git'))) continue;
        await run('git', ['-C', dir, 'worktree', 'prune']);
        prunedRepos++;
        if (req.body?.removeMerged) {
          const base = path.join(WT_ROOT, e.name);
          if (!fs.existsSync(base)) continue;
          const mainBr = (await run('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
          const mergedR = mainBr ? await run('git', ['-C', dir, 'branch', '--merged', mainBr, '--format=%(refname:short)']) : { ok: false, stdout: '' };
          const merged = new Set(mergedR.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
          for (const wtName of fs.readdirSync(base)) {
            if (activeWts.has(`${e.name}/${wtName}`)) continue;
            const wdir = path.join(base, wtName);
            const dirty = (await run('git', ['-C', wdir, 'status', '--porcelain'])).stdout.trim();
            const br = (await run('git', ['-C', wdir, 'symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
            if (!dirty && (!br || merged.has(br))) {
              const rem = await run('git', ['-C', dir, 'worktree', 'remove', wdir]);
              if (rem.ok) {
                removedWorktrees++;
                if (br && br !== mainBr) await run('git', ['-C', dir, 'branch', '-d', br]);
              }
            }
          }
          await run('git', ['-C', dir, 'worktree', 'prune']);
        }
      }
    }
    res.json({ ok: true, removedUploads, prunedRepos, removedWorktrees });
  }));
}

module.exports = { register, safeSubpath, detectListeningPorts, UPLOAD_DIR };
