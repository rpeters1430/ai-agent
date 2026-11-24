#!/usr/bin/env bash
# Smoke-test a built Agent Hub image: start it, wait for health, sign in, and check the UI, preview port and CLIs.
#   scripts/smoke-test.sh <image>      (used by CI; also handy after a local build)
set -euo pipefail
IMAGE="${1:?usage: smoke-test.sh <image>}"
NAME="agent-hub-smoke-$$"
PW="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"   # random per run
fail() { echo "SMOKE TEST FAILED: $*" >&2; echo "--- container logs ---" >&2; docker logs "$NAME" >&2 || true; exit 1; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -e UI_PASSWORD="$PW" -p 127.0.0.1::7681 -p 127.0.0.1::7682 "$IMAGE" >/dev/null
HUB="http://$(docker port "$NAME" 7681/tcp | head -1)"
PREVIEW="http://$(docker port "$NAME" 7682/tcp | head -1)"
echo "hub $HUB · preview $PREVIEW"

for i in $(seq 1 90); do
  curl -fsS "$HUB/healthz" >/dev/null 2>&1 && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || fail "container exited"
  [ "$i" = 90 ] && fail "/healthz not up after 90s"
  sleep 1
done
echo "ok   /healthz"

curl -fsS "$PREVIEW/healthz" >/dev/null || fail "preview server not answering"
echo "ok   preview port"

code="$(curl -s -o /dev/null -w '%{http_code}' "$HUB/api/status")"
[ "$code" = 401 ] || fail "/api/status without sign-in returned $code, expected 401"
echo "ok   API requires sign-in"

JAR="$(mktemp)"
code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -H 'Content-Type: application/json' -H "Origin: $HUB" \
  -d "{\"password\":\"$PW\"}" "$HUB/api/login")"
[ "$code" = 200 ] || fail "sign-in returned $code"
echo "ok   sign-in"

curl -fsS -b "$JAR" "$HUB/" | grep -q '<script src="/app.js">' || fail "UI page not served"
curl -fsS -b "$JAR" "$HUB/vendor/xterm/lib/xterm.js" >/dev/null || fail "xterm assets missing"
echo "ok   UI + vendored xterm"

STATUS="$(curl -fsS -b "$JAR" "$HUB/api/status")"
missing="$(printf '%s' "$STATUS" | node -e '
  const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const want = ["claude", "codex", "opencode", "pi", "gemini", "qwen", "dsh", "shell"];
  process.stdout.write(want.filter((k) => !s.agents?.[k]?.installed).join(" "));
' 2>/dev/null || echo "unparseable")"
[ -z "$missing" ] || fail "CLIs not installed: $missing"
echo "ok   agent CLIs installed"

docker exec "$NAME" tmux -V >/dev/null || fail "tmux missing"
docker exec "$NAME" gh --version >/dev/null || fail "gh missing"
echo "ok   tmux + gh"
echo "SMOKE TEST PASSED"
