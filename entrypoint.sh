#!/bin/bash
set -e

if [ "$(id -u)" = "0" ]; then
  TARGET_UID="${PUID:-$(id -u dev)}"
  TARGET_GID="${PGID:-$(id -g dev)}"
  CURR_UID="$(id -u dev)"
  CURR_GID="$(id -g dev)"

  if [ "$TARGET_GID" != "$CURR_GID" ]; then
    if getent group "$TARGET_GID" >/dev/null 2>&1; then
      usermod -g "$TARGET_GID" dev
    else
      groupmod -g "$TARGET_GID" dev 2>/dev/null || { groupadd -g "$TARGET_GID" devgrp && usermod -g "$TARGET_GID" dev; }
    fi
  fi
  if [ "$TARGET_UID" != "$CURR_UID" ]; then
    usermod -u "$TARGET_UID" dev
  fi
  if [ "$TARGET_UID" != "$CURR_UID" ] || [ "$TARGET_GID" != "$CURR_GID" ]; then
    chown -R "$TARGET_UID:$TARGET_GID" /opt/tools
  fi

  if [ "${ALLOW_SUDO:-}" = "false" ]; then
    rm -f /etc/sudoers.d/dev
  elif [ "${ALLOW_SUDO:-}" = "true" ]; then
    echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/dev && chmod 0440 /etc/sudoers.d/dev
  fi

  DEV_UID=$(id -u dev)
  DEV_GID=$(id -g dev)

  # Bind-mounted dirs may be created by Docker as root; fix top-level ownership only.
  for d in /home/dev /workspace; do
    mkdir -p "$d"
    [ "$(stat -c %u "$d")" = "$DEV_UID" ] || chown "$DEV_UID:$DEV_GID" "$d"
  done
  # Codex creates arg0 temp dirs that can become owned by another UID (e.g. nobody) and block cleanup.
  [ -d /home/dev/.codex/tmp ] && chown -R "$DEV_UID:$DEV_GID" /home/dev/.codex/tmp 2>/dev/null || true

  # Re-exec this script as `dev`.
  exec setpriv --reuid="$DEV_UID" --regid="$DEV_GID" --init-groups -- "$0" "$@"
fi

cd "$HOME"
mkdir -p .local/bin .config .agent-hub
chmod 700 .agent-hub 2>/dev/null || true

[ -f .bashrc ] || cp /etc/skel/.bashrc .bashrc 2>/dev/null || true
if ! grep -q "# agent-hub" .bashrc 2>/dev/null; then
  cat >> .bashrc <<'EOF'

# agent-hub
export PATH="$HOME/.local/tools/bin:$HOME/.local/bin:/opt/tools/npm/bin:/opt/tools/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.local/tools"
[ -f "$HOME/.agent-hub/env.sh" ] && . "$HOME/.agent-hub/env.sh"
alias ll="ls -alF"
EOF
else
  # Older .bashrc files: ensure CLI updates (~/.local/tools) come first in PATH, NPM_CONFIG_PREFIX is set, and env.sh is sourced.
  grep -q 'local/tools/bin' .bashrc || sed -i 's|^export PATH="\$HOME/.local/bin:|export PATH="$HOME/.local/tools/bin:$HOME/.local/bin:|' .bashrc
  grep -q 'NPM_CONFIG_PREFIX=' .bashrc || printf 'export NPM_CONFIG_PREFIX="$HOME/.local/tools"\n' >> .bashrc
  grep -q 'agent-hub/env.sh' .bashrc || printf '[ -f "$HOME/.agent-hub/env.sh" ] && . "$HOME/.agent-hub/env.sh"\n' >> .bashrc
fi

# CLI updates and user-installed Python/Playwright tools go to the persistent home volume.
export PATH="$HOME/.local/tools/bin:$HOME/.local/bin:/opt/tools/npm/bin:/opt/tools/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.local/tools"
export PIPX_HOME="$HOME/.local/pipx" PIPX_BIN_DIR="$HOME/.local/bin"
export UV_TOOL_DIR="$HOME/.local/uv/tools" UV_TOOL_BIN_DIR="$HOME/.local/bin"
export PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"
export CHROME_PATH="/usr/bin/chromium"

[ -n "$GIT_USER_NAME" ]  && git config --global user.name  "$GIT_USER_NAME"
[ -n "$GIT_USER_EMAIL" ] && git config --global user.email "$GIT_USER_EMAIL"
git config --global init.defaultBranch main
git config --global --add safe.directory "*" 2>/dev/null || true

# Let plain `git` (used by every agent) authenticate through gh.
if [ -n "$GH_TOKEN" ] || gh auth status >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

exec node /app/server.js
