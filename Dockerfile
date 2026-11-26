# AI coding agents workstation: Claude Code, Codex, OpenCode, Pi, Antigravity (agy),
# Gemini CLI, Qwen Code, Cline CLI (cline) + GitHub CLI + browser terminal UI.
FROM node:26-bookworm@sha256:893ea48106e988a5f91e69629d6472600daa9d0494adf7db87eb0b886ce82255

ARG PUID=1000
ARG PGID=10
ARG ALLOW_SUDO=true
ARG INSTALL_AGY=true
ARG INSTALL_KODI=false
ARG EXTRA_APT_PACKAGES=""
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TERM=xterm-256color \
    HOME=/home/dev \
    USER=dev \
    WORKSPACE=/workspace \
    BROWSER=/usr/local/bin/hub-open \
    NPM_CONFIG_PREFIX=/opt/tools/npm \
    PIPX_HOME=/home/dev/.local/pipx \
    PIPX_BIN_DIR=/home/dev/.local/bin \
    UV_TOOL_DIR=/home/dev/.local/uv/tools \
    UV_TOOL_BIN_DIR=/home/dev/.local/bin \
    PLAYWRIGHT_BROWSERS_PATH=/home/dev/.cache/ms-playwright \
    CHROME_PATH=/usr/bin/chromium \
    PATH=/home/dev/.local/tools/bin:/home/dev/.local/bin:/opt/tools/npm/bin:/opt/tools/bin:$PATH

# --- System packages, dev/debug tools, Playwright/Chromium deps & media ----
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      git git-lfs gh tmux curl wget ca-certificates gnupg jq ripgrep fd-find less \
      nano vim-tiny openssh-client rsync build-essential cmake pkg-config sudo \
      procps unzip zip tini htop tree file patch sqlite3 \
      dnsutils iputils-ping iproute2 netcat-openbsd lsof strace \
      python3 python-is-python3 python3-pip python3-venv python3-dev pipx \
      libffi-dev libssl-dev zlib1g-dev libjpeg-dev libxml2-dev libxslt1-dev \
      ffmpeg libchromaprint-tools python3-mutagen imagemagick pngquant xmlstarlet \
      chromium xvfb xauth fonts-dejavu-core fonts-liberation \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 \
      libdrm2 libdbus-1-3 libxkbcommon0 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
      libasound2 libxshmfence1 \
      $EXTRA_APT_PACKAGES \
 && if [ "$INSTALL_KODI" = "true" ]; then \
      apt-get install -y --no-install-recommends kodi kodi-inputstream-adaptive \
        || apt-get install -y --no-install-recommends kodi; \
    fi \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# --- Unprivileged user (Claude Code refuses some modes as root) ------------
RUN userdel -r node 2>/dev/null || true \
 && (getent group "${PGID}" >/dev/null || groupadd -g "${PGID}" dev) \
 && useradd -m -u "${PUID}" -g "${PGID}" -s /bin/bash dev \
 && if [ "$ALLOW_SUDO" = "true" ]; then \
      echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && chmod 0440 /etc/sudoers.d/dev; \
    fi \
 && mkdir -p /opt/tools/npm /opt/tools/bin /workspace \
 && chown -R "${PUID}:${PGID}" /opt/tools /workspace

# Tool dirs are owned by `dev` so the CLIs can self-update without root.
USER dev

# --- Coding agents & debugging CLIs ----------------------------------------
RUN npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
      @earendil-works/pi-coding-agent \
      @google/gemini-cli \
      @qwen-code/qwen-code \
      cline \
      agent-browser \
 && npm cache clean --force \
 && rm -rf /home/dev/.npm/_cacache

# uv/uvx (fast Python venv & tool installer, bypasses Debian PEP 668 headaches)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/opt/tools/bin sh \
 && /opt/tools/bin/uv --version

# Antigravity CLI (agy) - official installer, into a dev-owned dir
# On non-amd64 builds a missing agy build is a warning, not a failed image.
RUN if [ "$INSTALL_AGY" = "true" ]; then \
      if curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/tools/bin \
         && test -x /opt/tools/bin/agy; then \
        /opt/tools/bin/agy --version || true; \
      elif [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        echo "Antigravity (agy) install failed" >&2; exit 1; \
      else \
        echo "WARNING: Antigravity (agy) is not available for $(dpkg --print-architecture); skipping" >&2; \
      fi; \
    fi

# --- Web UI ----------------------------------------------------------------
USER root
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN NPM_CONFIG_PREFIX= npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /root/.npm/_cacache
COPY app/ ./
COPY tmux.conf /etc/tmux.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY hub-open /usr/local/bin/hub-open
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/hub-open \
 && for b in xdg-open x-www-browser www-browser sensible-browser; do ln -sf /usr/local/bin/hub-open /usr/local/bin/$b; done \
 && printf '%s\n' \
      'export PATH="$HOME/.local/tools/bin:$HOME/.local/bin:/opt/tools/npm/bin:/opt/tools/bin:$PATH"' \
      'export NPM_CONFIG_PREFIX="$HOME/.local/tools"' \
      'export PIPX_HOME="$HOME/.local/pipx" PIPX_BIN_DIR="$HOME/.local/bin"' \
      'export UV_TOOL_DIR="$HOME/.local/uv/tools" UV_TOOL_BIN_DIR="$HOME/.local/bin"' \
      'export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"' \
      'export CHROME_PATH="/usr/bin/chromium"' \
      > /etc/profile.d/agent-hub.sh

EXPOSE 7681 7682
LABEL org.opencontainers.image.source="https://github.com/rpeters1430/ai-agent" \
      org.opencontainers.image.description="Agent Hub: browser terminal UI for coding agent CLIs"
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7681/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
