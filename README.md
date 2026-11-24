# Agent Hub

A single Docker container with **Claude Code, Codex, OpenCode, Pi, Antigravity (`agy`), Gemini CLI, Qwen Code, and DeepSeek Harness (`dsh`)**,
plus the GitHub CLI, behind a password-protected web UI with real browser terminals.

- Clone any of your GitHub repos into `./workspace` with one click
- Start any agent in any repo; sessions run in **tmux**, so they keep running when you close the tab
- Reattach from any device; view **2 sessions side-by-side in Split View** or run **Multi-Agent Arena** comparisons
- Drag-and-drop or paste screenshots directly into the terminal, inspect **colored diffs & commit/branch/stash**, browse repo files/images, and preview container localhost dev servers via the authenticated **Port Preview Proxy** (served on its own port, see [Dev-server previews](#dev-server-previews))
- `git` is wired through `gh`, so agents can push, open PRs (`gh pr create`), and so on

## Start

Prebuilt images are published automatically to GitHub Container Registry (`ghcr.io/rpeters1430/ai-agent:latest`) on every push to `main`:

```bash
cd /volume1/docker/cli
cp .env.example .env      # set UI_PASSWORD (and optionally GITHUB_TOKEN etc.)
docker compose pull && docker compose up -d
```

To build locally instead (for example to test uncommitted changes or custom `INSTALL_KODI` / `EXTRA_APT_PACKAGES` build args):

```bash
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build
```

Open `http://<nas-ip>:3870` (or through Tailscale via the docktail label `agents`).

## Connecting accounts

Everything is stored in `./data/home` so it survives rebuilds.

| Tool | How |
|---|---|
| GitHub | Set `GITHUB_TOKEN` in `.env` **or** click **GitHub login** (device code flow at github.com/login/device) |
| Claude Code | **Claude login**: open the URL it prints, paste the code back. Or set `ANTHROPIC_API_KEY` |
| Codex | **Codex login** uses `--device-auth` (no localhost callback needed). Or `OPENAI_API_KEY` |
| OpenCode | **OpenCode login** → `opencode auth login`, pick a provider |
| Pi | **Pi login** → type `/login` in pi. Or use an API key env var |
| Antigravity | **Antigravity login** → follow agy's first-run sign-in |
| Gemini CLI | **Gemini login** → Google OAuth on first run, or set `GEMINI_API_KEY` in **System → API keys** |
| Qwen Code | **Qwen Code login** → Qwen OAuth on first run, or set `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` |
| DeepSeek Harness | Set `DEEPSEEK_API_KEY` (and optional `DEEPSEEK_BASE_URL`) in **System → API keys** or `.env`. Starts `dsh web --no-open` (viewable via **Preview** proxy) and uses `dsh --profile headless` for automations |

If signing in ends on a `localhost:…/callback?code=…` page that won't load (Claude Code does this), copy that address
from the browser bar and paste it into **Finish login** under Accounts. The page only exists inside the container, so
Agent Hub delivers it there and the CLI completes the sign-in. Do it within a few minutes, while the login terminal is still waiting.

## Git worktrees

Each repo has a **worktrees** section: **＋ new worktree** asks for a branch (new or existing) and a base.
It creates a separate checkout in `/workspace/.worktrees/<repo>/<branch>`, so several agents can work on one
repo at the same time without interfering. Each worktree row has its own agent buttons and status / diff / push / open PR
buttons. **remove** deletes the checkout and stops agents running in it. It asks before discarding uncommitted
changes and only deletes the branch if it's fully merged.

## Automations (GitHub issues, PRs, schedules)

Similar to OpenHands' GitHub resolver, but it works with any of the installed agents. Open **Automations · GitHub → Manage automations…**:

- **Watched repositories (Issues & PRs)**: configure your workflow once (worker agent, optional separate reviewer agent, trigger labels, auto-review after working, optional auto-fix rounds, new-PR reviews, `@mentions`, and **additional label profiles**), then simply add repositories to watch — or click **Watch** directly on any repo in the **GitHub** tab.
  - Tag an issue with your fix label (default `agent-fix`): the worker agent implements the fix and opens a PR, then the reviewer agent automatically reviews that PR (and optionally triggers up to N automatic fix-and-re-review rounds if the review reports `VERDICT: CHANGES_REQUESTED`).
  - Add extra label profiles (e.g. `opencode-fix` → OpenCode + a local Ollama model) so you can choose which agent/local LLM handles an issue or PR just by which label you apply.
  - Tag a PR with `agent-review` (or open a new non-draft PR): the reviewer agent posts file:line findings without duplicating reviews already queued by auto-review.
- **Custom & scheduled rules**: per-repo overrides and recurring scheduled tasks:

| Rule | What happens |
|---|---|
| Fix issues with a label (default `agent-fix`) | On an issue: the agent works on a new branch `agent-hub/issue-N-…` and Agent Hub opens a (draft) PR that closes the issue (with optional auto-review and auto-fix rounds). On a PR: the agent addresses the review comments and pushes to the PR branch. |
| @mention (default `@agent`) | A comment such as `@agent add tests for the parser` makes the agent do what it asks. It opens a PR, pushes to the PR, or just replies if no code change is needed. |
| Review PRs with a label (default `agent-review`) | The agent posts a review comment with file:line findings. It never pushes. |
| Review every new PR | Same as above for each new non-draft PR, optionally again on new commits. |
| Scheduled task | Every N hours, runs your instructions on the default branch and opens a PR if code changed. |

How it works:
- Agent Hub **polls** GitHub (every 60s by default), so no webhook or open port is needed.
- Labels are created in the repo for you, and removed when a run starts, so you can add the label again to re-run.
- Each run gets its own worktree and runs headless with permission prompts off:
  - `claude -p`
  - `codex exec`
  - `opencode run --auto`
  - `pi -p`
  - `agy -p`
- Runs show up in **Sessions**, so you can **Watch live**. Afterwards you can read the log and prompt, **Run again**, or **Continue here** to open the agent interactively in the run's worktree.
- Fix worktrees are kept so you can continue the work. Remove them from the repo's worktrees list.
- Comments, PRs and pushes use your connected GitHub account. They carry a hidden marker, so the bot never reacts to its own comments.
- @mentions and new-PR reviews only react to the repo owner, members and collaborators, unless you tick *also for people outside the repo*.
  Leave that off for public repos: the agent runs unattended with your GitHub credentials, and issue or PR text from strangers could try to steer it.
- **Loop guard** (OpenCode and Pi): small local models sometimes repeat the same step forever, for example re-reading a file or making an edit
  that changes nothing. These runs use JSON output through `app/agentstream.js`, which prints a readable log and stops the agent when the
  same tool call returns the same result *N* times (default 4, set it in the automation settings, 0 = off). The run fails with the reason,
  and its worktree is kept.

## Local models (Ollama)

**Pi, OpenCode, Claude Code, Codex, Qwen Code, and DeepSeek Harness (`dsh`)** can all use models from an Ollama server on another PC (Gemini CLI and Antigravity use Google/managed endpoints only).

1. On the Ollama PC: set `OLLAMA_HOST=0.0.0.0`, restart Ollama, and open TCP 11434 in its firewall.
   It's also worth setting `OLLAMA_CONTEXT_LENGTH=32768`, because coding agents need a large context (especially Codex, Qwen Code, OpenCode, and DSH).
2. In Agent Hub → **Models**: enter `http://<pc-ip>:11434` and click **Connect**.
3. Open **CLI Compatibility Lab…** to run a **Models × CLIs** verification matrix across Pi, OpenCode, Claude Code, Codex, Qwen Code, and DeepSeek Harness (in either **Full coding edit** mode or **Quick tool smoke** mode). Every test runs under `app/agentstream.js` with loop-guard protection, verifies real tool calls and clean completion, and shows tool-call traces, peak prompt tokens, errors, and diffs. Click **Apply passing** to configure every model on the CLIs it passed on.
4. Or manually tick models (ideally ones with the **tools** badge and **ctx ≥ 16k**), choose target CLIs, optionally a default, and click **Apply checked models**.
5. Start any configured CLI from a repo and pick the model in **Local model (Ollama / custom)** (or use it in Automations and Multi-Agent Arena).

**Browse & pull…** opens the ollama.com library, filtered to *agent-ready* (tool-calling) models by default.
Each model shows its capabilities (tools / thinking / vision / embedding / cloud) and a plain-English line on what
it can do in Agent Hub. **Show versions** lists each size with its download size, context window and input types, plus a **Pull** button.

The panel shows each model's effective context size (and warns when Ollama's live loaded `/api/ps` context is smaller than `serverCtx`). If it's small (yellow), click **Make agent-ready copy** to create `<model>-ctx32k` on the Ollama server with `num_ctx 32768`.

Generated config: `~/.config/opencode/opencode.json` (provider `ollama`), `~/.pi/agent/models.json` (+ `settings.json`), `~/.codex/config.toml` (provider `ollama-hub`), `~/.agent-hub/dsh-ollama.yml`, and per-session env/flag injection for Claude Code (`ANTHROPIC_BASE_URL`) and Qwen Code (`--auth-type openai`) so cloud auth remains untouched when using agent defaults. Test results are persisted in `~/.agent-hub/model-tests.json`.

## Updating the CLIs

**System → Update all CLIs** (or **Update** next to one CLI) runs the update in a terminal you can watch. The list shows each
CLI's version and whether a newer one exists. Updates are installed into `~/.local/tools`, which is on the
`./data/home` volume and comes first in PATH, so they **survive rebuilds**. The CLIs' own self-updates and `npm i -g`
also go there. **Reset to image versions** deletes `~/.local/tools` and goes back to the versions built into the image.
Running agents keep their old version until you restart them.

## Notifications

**System → Set up notifications…** sends a push to one or more destinations:

- **ntfy**: a topic URL such as `https://ntfy.sh/<long-random-name>` or your own ntfy server, plus an optional access token. Subscribe to the same topic in the ntfy phone app.
- **Discord**: a channel webhook URL.
- **Other webhook**: any URL that accepts a JSON POST, such as Home Assistant or n8n.

Events:
- an automation succeeded (with a link to the PR or review)
- an automation failed
- an agent session went quiet for N minutes, which usually means it's waiting for your answer. You get one alert per quiet period.

**Send test** checks the setup.

## Notes

- **Yolo checkbox**: starts Claude with `--dangerously-skip-permissions` and Codex with
  `--dangerously-bypass-approvals-and-sandbox`. The container is the sandbox. It can only see
  `./workspace` and `./data/home`. Passwordless `sudo` for the `dev` user is **off** by default; set
  `ALLOW_SUDO=true` in `.env` if your agents need to install system packages.
- **Automations and your GitHub token**: automation runs are unattended, so use a fine-grained token limited to the
  repos you watch (Contents, Issues, Pull requests: read/write; Checks: read for CI fixes) rather than a classic `repo` token.
- **Scrolling and copying**: tmux mouse mode is on. Scroll with the wheel. Hold **Shift**
  (on macOS, **Option**) while dragging to select text.
- Don't expose port 3870 (or the preview port 3871) to the internet. Use LAN or Tailscale only, since the UI gives shell access.
- Saved API keys live in `~/.agent-hub/env.sh` (mode 600). Sessions, automations and Arena runs source that file
  instead of copying keys into scripts or command lines.
- Behind a reverse proxy that sets `X-Forwarded-For`, set `TRUST_PROXY=true` so sign-in rate limiting is per client.
- **System** checks every CLI for updates each time you open or refresh the page, and shows a notice when updates are available.

## Dev-server previews

The **Preview** button proxies a dev server running inside the container (`npm run dev`, `dsh web`, …). Previews are
served on a **separate port** (`HUB_PREVIEW_PORT`, default `3871` → container `7682`), so the browser treats them as a
different site origin. Pages from a dev server, and any third-party scripts they load, can't call the Agent Hub API with
your session, and Agent Hub's cookies are stripped before a request reaches the dev server.

- Open previews from the Preview dialog: it creates a short-lived sign-in link for the preview port.
- If you reach Agent Hub via HTTPS (e.g. docktail on 443), previews open in a new tab because an https page can't
  embed an http one. To embed them, publish the preview port behind HTTPS too and set `PREVIEW_PUBLIC_URL`
  (e.g. `https://agents-preview.your-tailnet.ts.net`).
- `PREVIEW_SAME_ORIGIN=true` brings back the old behaviour (previews on the main port). Only use it for dev servers you trust.

## Layout

```
Dockerfile           image: node 22 + gh + tmux + the agent CLIs
docker-compose.yaml
entrypoint.sh        fixes volume ownership, git/gh setup, starts the UI as `dev`
tmux.conf
app/server.js        Express API + WebSocket ↔ node-pty ↔ tmux attach
app/automations.js   GitHub polling + unattended agent runs
app/tools.js         CLI versions and updates
app/notify.js        ntfy / Discord / webhook notifications
app/ollama.js        Ollama connection, catalog, OpenCode/Pi config
app/modeltest.js     "Test with agents" for Ollama models
app/agentstream.js   readable output + loop guard for OpenCode/Pi JSON runs
app/preview.js       dev-server preview proxy (its own port / origin)
app/errors.js        shared route error handling (status codes + logging)
app/public/          UI (vanilla JS + xterm.js)
scripts/smoke-test.sh  starts a built image and checks health, sign-in, UI, preview port and CLIs
data/home/           persisted $HOME (CLI logins/config)
workspace/           your cloned repositories
```

## Development

Node 22 (see `.nvmrc`). From `app/`:

```bash
npm ci
npm run check      # ESLint + the node:test suite
```

To test a locally built image the same way CI does:

```bash
docker build -t agent-hub:local . && scripts/smoke-test.sh agent-hub:local
```

CI runs on every PR and push to `main`:
- **Lint, audit and unit tests**: `node --check` on every file, ESLint, `npm audit` (fails on high/critical issues in runtime dependencies), and the test suite.
- **Build, smoke-test and publish**: builds the image, runs `scripts/smoke-test.sh` on it, prints a Trivy vulnerability report (report only), and pushes to GHCR only if the smoke test passed (not on PRs).
- An **arm64** image is built under QEMU only when you run the workflow manually (**Actions → Build and Publish Container Image → Run workflow**, tick *arm64*), because emulated builds are slow.

Renovate keeps npm packages, the base image digest and GitHub Action digests up to date.
