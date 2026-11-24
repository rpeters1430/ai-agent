'use strict';
/* global document */ // used inside callbacks that run in the browser page
// Browser test of the real UI (headless Chromium via playwright-core, using an installed browser — nothing is
// downloaded). Signs in, walks every pane, opens the main dialogs, starts a Shell in a repo and types into its
// terminal, and fails on any uncaught page error or console error.
//
// Browser: $CHROME_PATH, else the first one found below. The test is skipped when there is none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CANDIDATES = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const BROWSER = CANDIDATES.find((p) => p && fs.existsSync(p));
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = !BROWSER ? 'no Chrome/Chromium found (set CHROME_PATH)' : !hasTmux ? 'tmux not installed' : false;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ui-'));
const PASSWORD = crypto.randomBytes(12).toString('hex');
const GITCONFIG = path.join(TMP, 'gitconfig');
fs.writeFileSync(GITCONFIG, '[user]\n  name = Test\n  email = test@example.com\n[init]\n  defaultBranch = main\n');
for (const d of ['home', 'tmux', 'workspace/demo']) fs.mkdirSync(path.join(TMP, d), { recursive: true });
Object.assign(process.env, {
  HOME: path.join(TMP, 'home'), WORKSPACE: path.join(TMP, 'workspace'), UI_PASSWORD: PASSWORD,
  GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CONFIG_NOSYSTEM: '1', TMUX_TMPDIR: path.join(TMP, 'tmux'),
  HISTFILE: '/dev/null', // test shells must not write into HOME while it is being deleted
});
execFileSync('git', ['init', '-q'], { cwd: path.join(TMP, 'workspace/demo') });

// Stop this test's tmux server and wait until it has really exited (its shells may still be finishing).
async function killTmux() {
  try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch { return; }
  for (let i = 0; i < 50; i++) {
    try { execFileSync('tmux', ['has-session'], { stdio: 'ignore' }); } catch { return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

let hub, browser, base;
test.before(async () => {
  if (skip) return;
  hub = require('../server');
  const { port } = await hub.start({ port: 0, previewPort: 0, host: '127.0.0.1', handleSignals: false });
  base = `http://127.0.0.1:${port}`;
  const { chromium } = require('playwright-core');
  browser = await chromium.launch({ executablePath: BROWSER, args: ['--no-sandbox'] });
});
test.after(async () => {
  if (skip) return;
  await browser?.close();
  await hub.stop();
  await killTmux();
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // the killed shells may still be writing history
});

test('UI: sign in, every pane, main dialogs, repo tools, Shell in a repo with a working terminal, no page errors', { skip }, async () => {
  // reducedMotion: the UI's hover/press animations would otherwise keep elements "unstable" for Playwright.
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Expected: the sign-in probe and failed network calls to the outside world in a sandbox.
    if (/401 \(Unauthorized\)|Failed to load resource|ERR_|net::/.test(t)) return;
    problems.push(`console: ${t}`);
  });

  // Clicking the rail button of the pane that is already open collapses the side panel, so only click when needed.
  const showPane = async (pane) => {
    if (!(await page.locator(`section.pane.active[data-pane="${pane}"]`).count())) await page.locator(`.rail-btn[data-pane="${pane}"]`).click();
    if (await page.locator('#app.pane-collapsed').count()) await page.locator(`.rail-btn[data-pane="${pane}"]`).click();
    await page.locator(`section.pane.active[data-pane="${pane}"]`).waitFor();
    assert.equal(await page.locator('#app.pane-collapsed').count(), 0, 'side panel is open');
  };
  // Panes scroll inside .pane-scroll. Playwright's own scroll-into-view step also scrolls the overflow:hidden
  // sidebar, which slides it under the terminal area, so scroll the pane like a user would and click the element's
  // on-screen centre with the real mouse instead.
  const click = async (sel) => {
    const loc = typeof sel === 'string' ? page.locator(sel) : sel;
    await loc.waitFor();
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const b = await loc.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };

  await page.goto(base);
  await page.locator('#pw').fill('wrong');
  await page.locator('#pw').press('Enter');
  await page.locator('#loginErr').filter({ hasText: /wrong password/i }).waitFor();
  await page.locator('#pw').fill(PASSWORD);
  await page.locator('#pw').press('Enter');
  await page.locator('#app').waitFor({ state: 'visible' });

  // Repos pane lists the workspace repo, with an agent button per CLI.
  const repoRow = page.locator('#localRepos .item', { hasText: 'demo' }).first();
  await repoRow.waitFor();

  // Every pane opens.
  for (const pane of ['sessions', 'ollama', 'automations', 'github', 'system', 'workspace']) await showPane(pane);

  // System pane: the CLI list finished its (fresh) update check.
  await showPane('system');
  await page.locator('#tools .tool-row').first().waitFor({ timeout: 60000 });

  // Dialogs open and close.
  for (const [open, dlg, close] of [['#openNotify', '#notifyDlg', '#notifyClose'], ['#openAuto', '#autoDlg', '#autoClose']]) {
    const pane = open === '#openAuto' ? 'automations' : 'system';
    await showPane(pane);
    await click(open);
    await page.locator(`${dlg}[open]`).waitFor();
    await click(close);
    await page.locator(`${dlg}[open]`).waitFor({ state: 'detached' });
  }
  await page.locator('#previewBtn').click();
  await page.locator('#previewDlg[open]').waitFor();
  await page.locator('#previewClose').click();

  // System pane: API keys dialog lists the known keys.
  await showPane('system');
  await click('#openEnvBtn');
  await page.locator('#envDlg[open]').waitFor();
  await page.locator('#envDlg', { hasText: 'ANTHROPIC_API_KEY' }).waitFor();
  await click('#envClose');
  // Snippets: the default snippets are listed.
  await click('#snippetsBtn');
  await page.locator('#snippetsDlg[open]', { hasText: 'Run tests & fix' }).waitFor();
  await click('#snippetsClose');

  // Repo tools: diff viewer, file browser, Arena.
  fs.writeFileSync(path.join(TMP, 'workspace/demo/hello.txt'), 'hi\n');
  await showPane('workspace');
  await click('#refreshLocal');
  await repoRow.locator('summary', { hasText: 'git & tools' }).click();
  await click(repoRow.getByRole('button', { name: 'diff & commit' }));
  await page.locator('#diffDlg[open]', { hasText: 'hello.txt' }).waitFor();
  await click('#diffClose');
  await click(repoRow.getByRole('button', { name: 'files' }));
  await page.locator('#filesDlg[open]', { hasText: 'hello.txt' }).waitFor();
  await click('#filesClose');
  await click(repoRow.getByRole('button', { name: '⚔ arena' }));
  await page.locator('#arenaDlg[open]').waitFor();
  await click('#arenaCancel');

  // Start a Shell in the repo and use its terminal.
  await showPane('workspace');
  await click(repoRow.getByRole('button', { name: 'Shell', exact: true }));
  const term = page.locator('#terms .term .xterm').first();
  await term.waitFor();
  await page.waitForTimeout(800);
  await term.click();
  await page.keyboard.type('echo "$((6*7))-ui-$(basename $PWD)"');
  await page.keyboard.press('Enter');
  await page.locator('#terms .xterm-rows', { hasText: '42-ui-demo' }).waitFor({ timeout: 15000 });

  // Split view needs two sessions: with one it explains why; with two it shows both side by side.
  await click('#splitBtn');
  await page.locator('#dlg[open]', { hasText: 'Open at least 2 terminal sessions' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#dlg[open]').waitFor({ state: 'detached' });
  await showPane('workspace');
  await click(repoRow.getByRole('button', { name: 'Shell', exact: true }));
  await page.locator('#terms .term .xterm').nth(1).waitFor();
  await click('#splitBtn');
  await page.waitForFunction(() => [...document.querySelectorAll('#terms .term')].filter((t) => t.getBoundingClientRect().width > 0).length === 2);
  await click('#splitBtn');

  // It shows up in the Sessions pane.
  await showPane('sessions');
  await page.locator('#sessions .item', { hasText: 'demo' }).first().waitFor();
  assert.equal(await page.locator('#sessions .item', { hasText: 'demo' }).count(), 2);

  assert.deepEqual(problems, []);
  await page.close();
});
