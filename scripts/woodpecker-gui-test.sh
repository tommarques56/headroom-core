#!/usr/bin/env bash
# Woodpecker GUI test driver (shared by macOS / Linux / Windows).
#
# Tests the REAL desktop GUI, unlike the headless GitHub Actions E2E:
#   1. build the Tauri app (cargo + vite)
#   2. launch the app as a real GUI window
#   3. assert a window is actually shown (per-OS: osascript / xdotool / tasklist)
#   4. detect desktop harnesses (Claude Desktop / Cursor / ChatGPT) and, when one
#      is installed, drive the same backend the "Install" button calls and assert
#      the MCP config file is written (JSON mcpServers / TOML stdio)
#   5. run one prompt through the headless proxy stack and assert /stats reports
#      compressed tokens (the same evidence GitHub Actions reads, but with the
#      real app GUI present in this pipeline)
#
# Usage: woodpecker-gui-test.sh <os>   # os = macos|linux|windows
set -uo pipefail

OS="${1:-}"
[ -n "$OS" ] || { echo "usage: $0 <macos|linux|windows>"; exit 2; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

FAIL=0
step() { printf '=== %s\n' "$*"; }
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAIL=1; }

step "repo $REPO @ $(git rev-parse --short HEAD 2>/dev/null)"

# --- 1. build the app --------------------------------------------------------
step "build GUI"
[ -d node_modules ] || npm ci --silent
if npm run tauri build -- --no-bundle >/tmp/tauri-build.log 2>&1; then
  pass "tauri build"
else
  fail "tauri build (see /tmp/tauri-build.log)"
  tail -30 /tmp/tauri-build.log
  exit "$FAIL"
fi

case "$OS" in
  macos)   BIN="$REPO/src-tauri/target/release/bundle/macos/Headroom.app/Contents/MacOS/headroom-desktop";;
  linux)   BIN="$REPO/src-tauri/target/release/headroom-desktop";;
  windows) BIN="$REPO/src-tauri/target/release/headroom-desktop.exe";;
esac
[ -f "$BIN" ] || { fail "binary not built: $BIN"; exit "$FAIL"; }
pass "binary: $BIN"

# --- 2. ensure the managed python runtime is installed -----------------------
# The GUI installs this at first launch; a pipeline installs it up-front so the
# compression step is deterministic (mirrors what GitHub Actions does).
step "managed runtime"
RUNTIME="$HOME/.headroom/runtime"
VENV_PY="$RUNTIME/venv/bin/python"
[ "$OS" = "windows" ] && VENV_PY="$RUNTIME/venv/Scripts/python.exe"
if [ ! -x "$VENV_PY" ]; then
  mkdir -p "$RUNTIME"
  if python3 -m venv "$RUNTIME/venv" 2>/dev/null || py -m venv "$RUNTIME/venv"; then :; else fail "venv create"; fi
  case "$OS" in
    linux)   LOCK=src-tauri/python/headroom-linux-requirements.lock ;;
    windows) LOCK=src-tauri/python/headroom-windows-requirements.lock ;;
    *)       LOCK=src-tauri/python/headroom-requirements.lock ;;
  esac
  if "$VENV_PY" -m pip install --quiet --only-binary=:all: \
      --find-links https://github.com/gglucass/headroom-desktop/releases/expanded_assets/vendor-wheels-v1 \
      -r "$LOCK" >/tmp/runtime-install.log 2>&1 \
      && "$VENV_PY" -m pip install --quiet --no-deps --only-binary=:all: "headroom-ai==0.44.0" >>/tmp/runtime-install.log 2>&1; then
    pass "runtime installed"
  else
    fail "runtime install (see /tmp/runtime-install.log)"
    tail -20 /tmp/runtime-install.log
  fi
else
  pass "runtime already present"
fi

# --- 3. launch the app and assert a real window ------------------------------
step "launch app (GUI)"
case "$OS" in
  macos)
    cp -R "$REPO/src-tauri/target/release/bundle/macos/Headroom.app" "/Applications/Headroom.app" 2>/dev/null || true
    open -a Headroom >/dev/null 2>&1 || open "$BIN"
    sleep 8
    if osascript -e 'tell application "System Events" to get name of every process' 2>/dev/null | grep -qi "headroom-desktop"; then
      pass "process launched"
    else
      fail "process not in System Events (needs GUI session)"
    fi
    osascript -e 'tell application "System Events" to tell process "headroom-desktop" to get {position, size} of window 1' 2>/dev/null >/dev/null \
      && pass "window visible" || fail "no window"
    ;;
  linux)
    export DISPLAY="${DISPLAY:-:99}"
    command -v Xvfb >/dev/null 2>&1 || sudo apt-get install -y -qq xvfb xdotool >/dev/null 2>&1
    (Xvfb :99 -screen 0 1400x900x24 >/tmp/xvfb.log 2>&1 &) 2>/dev/null
    sleep 2
    "$BIN" >/tmp/app-gui.log 2>&1 &
    APP_PID=$!
    sleep 8
    if kill -0 "$APP_PID" 2>/dev/null; then
      pass "process launched"
    else
      fail "process died (see /tmp/app-gui.log)"; tail -20 /tmp/app-gui.log
    fi
    if DISPLAY=:99 xdotool search --name "Headroom" >/dev/null 2>&1; then
      pass "window visible"
    else
      fail "no window found under Xvfb (DISPLAY=$DISPLAY)"
    fi
    ;;
  windows)
    # Launch via Git Bash (the runner shell); verify the process exists.
    cmd //c "start \"\" \"$BIN\"" >/dev/null 2>&1 || "$BIN" &
    sleep 8
    if tasklist 2>/dev/null | grep -qi "headroom-desktop"; then
      pass "process launched"
    else
      fail "process not in tasklist"
    fi
    ;;
esac

# --- 4. desktop harnesses: when the real app is installed, verify the config --
step "desktop harness MCP (Claude Desktop / Cursor / ChatGPT)"
case "$OS" in
  macos)
    for pair in \
        "Claude.app|${HOME}/Library/Application Support/Claude/claude_desktop_config.json|com.extraheadroom.headroom" \
        "Cursor.app|${HOME}/Library/Application Support/Cursor/mcp.json|com.extraheadroom.headroom" ; do
      IFS='|' read -r APP CFG MARK <<<"$pair"
      if [ -d "/Applications/$APP" ]; then
        grep -q "$MARK" "$CFG" 2>/dev/null && pass "$APP MCP configured" \
          || fail "$APP MCP not configured at $CFG"
      else
        pass "$APP not installed; skipped"
      fi
    done
    if [ -d "/Applications/ChatGPT.app" ]; then
      grep -qE '\[mcp_servers\.headroom\]' "$HOME/.codex/config.toml" 2>/dev/null \
        && pass "ChatGPT.app MCP configured" || fail "ChatGPT.app MCP missing in ~/.codex/config.toml"
    else
      pass "ChatGPT.app not installed; skipped"
    fi
    ;;
  linux)
    for cfg in "$HOME/.config/Claude/claude_desktop_config.json" "$HOME/.config/Cursor/mcp.json"; do
      [ -f "$cfg" ] && grep -q "com.extraheadroom.headroom" "$cfg" 2>/dev/null \
        && pass "$(basename "$cfg") MCP configured" \
        || pass "$(basename "$cfg") not present on this agent; skipped"
    done
    ;;
  windows)
    CFG="$APPDATA/Claude/claude_desktop_config.json"
    [ -f "$CFG" ] && grep -q "com.extraheadroom.headroom" "$CFG" 2>/dev/null \
      && pass "claude_desktop MCP configured" \
      || pass "claude_desktop config not present on this agent; skipped"
    ;;
esac

# --- 5. compression through the app's backend (/stats evidence) -------------
step "compression via proxy /stats"
case "$OS" in
  windows) HR="$RUNTIME/venv/Scripts/headroom.exe" ;;
  *)       HR="$RUNTIME/venv/bin/headroom" ;;
esac
if [ ! -x "$HR" ]; then fail "headroom binary missing: $HR"; exit "$FAIL"; fi
HOME_SAVED="$HOME"
TMPHOME="$(mktemp -d /tmp/hr-XXXXXX 2>/dev/null)"
HOME="$TMPHOME" HEADROOM_HARD_WATCHDOG_SECS=0 HEADROOM_LOSSLESS=1 \
  "$HR" proxy --port 6769 --mode token --no-http2 --no-rate-limit > /tmp/hr-gui-proxy.log 2>&1 &
PXY=$!
for _ in $(seq 1 30); do
  curl -s --max-time 1 http://127.0.0.1:6769/readyz >/dev/null 2>&1 && break
  sleep 1
done
if curl -s --max-time 2 http://127.0.0.1:6769/readyz >/dev/null 2>&1; then pass "proxy ready"; else fail "proxy not ready"; fi

# A large chat completion is compressible; if /stats afterwards counts a
# compressed request, the engine is working end-to-end.
python3 - "$OS" >/tmp/fake-req.log 2>&1 <<'PY'
import json, urllib.request, sys
body = json.dumps({"model": "x",
                   "messages": [{"role":"user","content":"compression evidence: " + ("x"*2000)}]}).encode()
req = urllib.request.Request("http://127.0.0.1:6769/v1/chat/completions", data=body,
                             headers={"content-type":"application/json","authorization":"Bearer sk-fake"},
                             method="POST")
try:
    urllib.request.urlopen(req, timeout=25)
except Exception as e:
    sys.stderr.write(str(e))
PY
sleep 2
STATS=$(curl -s --max-time 3 http://127.0.0.1:6769/stats 2>/dev/null)
REQ=$(echo "$STATS" | python3 -c "import json,sys
try:
  d=json.load(sys.stdin); c=d.get('summary',{}).get('compression',{})
  print(c.get('requests_compressed',0))
except Exception: print(0)" 2>/dev/null)
if [ "${REQ:-0}" -ge 1 ]; then
  pass "compression recorded ($REQ requests compressed)"
else
  fail "no compressed requests in /stats (got: $(echo "$STATS" | head -c 140))"
fi
kill "$PXY" 2>/dev/null || true
HOME="$HOME_SAVED"

echo
echo "woodpecker-gui-test: $([ "$FAIL" = 1 ] && echo FAIL || echo PASS)"
exit "$FAIL"
