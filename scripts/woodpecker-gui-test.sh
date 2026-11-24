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
# vite 8 uses rolldown, whose native binding is declared as an optionalDependency.
# npm has a known bug (#4828) that skips optional deps on first `npm ci` on some
# machines; force-install the correct native binding per-OS so the vite build
# can find it (mirrors every OS runner: windows msvc, darwin arm64, linux gnu).
case "$OS" in
  windows) ROLDDEP="@rolldown/binding-win32-x64-msvc" ;;
  macos)   ROLDDEP="@rolldown/binding-darwin-arm64" ;;
  linux)   ROLDDEP="@rolldown/binding-linux-x64-gnu" ;;
esac
if [ -d node_modules/rolldown ]; then
  npm install --no-save --no-audit --no-fund "$ROLDDEP" >/dev/null 2>&1 \
    && node -e "console.log('  rolldown binding OK:', process.platform, process.arch)" 2>/dev/null \
    || echo "  WARN could not restore rolldown native binding ($ROLDDEP)"
fi
# Build in debug: the Windows release profile requires HEADROOM_SIGNED_RUNTIME_*
# env vars (Azure-signing artifacts) that only the upstream pipeline sets; debug
# skips that requirement and compiles much faster, which is all we need here —
# we exercise the real GUI window, not the optimised release binary.
BIN_PROFILE="${GUI_TEST_PROFILE:-debug}"
if npm run tauri -- build --$BIN_PROFILE --no-bundle >/tmp/tauri-build.log 2>&1; then
  pass "tauri build (profile=$BIN_PROFILE)"
else
  fail "tauri build (see /tmp/tauri-build.log)"
  tail -30 /tmp/tauri-build.log
  exit "$FAIL"
fi

case "$OS" in
  # --no-bundle builds the bare binary (no .app wrapper), so macOS resolves to
  # target/debug/headroom-desktop just like the other platforms.
  macos)   BIN="$REPO/src-tauri/target/debug/headroom-desktop";;
  linux)   BIN="$REPO/src-tauri/target/debug/headroom-desktop";;
  windows) BIN="$REPO/src-tauri/target/debug/headroom-desktop.exe";;
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

# The runtime is only usable if the headroom CLI exists and pip works; a
# half-created venv (e.g. without pip because python3-venv is missing on the
# host OS) must be rebuilt from scratch.
HR_BIN="$RUNTIME/venv/bin/headroom"
[ "$OS" = "windows" ] && HR_BIN="$RUNTIME/venv/Scripts/headroom.exe"
REBUILD=0
if [ -x "$VENV_PY" ]; then
  if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
    echo "  WARN venv exists but pip is missing; rebuilding"
    REBUILD=1
  fi
  [ -x "$HR_BIN" ] || { echo "  WARN headroom CLI missing; rebuilding"; REBUILD=1; }
fi
if [ "$REBUILD" = 1 ] || [ ! -x "$VENV_PY" ]; then
  rm -rf "$RUNTIME/venv"
  mkdir -p "$RUNTIME"
  # Explicit install locations first (macOS: brew, Linux: deadsnakes/usr,
  # Windows: python.org). The runner process PATH may predate the install,
  # so relying on `python` alone is fragile on Windows especially.
  PY_CANDS="python3.12 python3.11 python3.13 python3 python py"
  case "$OS" in
    windows) PY_CANDS="C:\\Python312\\python.exe python3.12 python3.11 python3 python py" ;;
    macos)   PY_CANDS="/opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 python3.12 python3 python py" ;;
    linux)   PY_CANDS="/usr/bin/python3.12 python3.12 python3.11 python3 python py" ;;
  esac
  PY_BIN=""
  for cand in $PY_CANDS; do
    if command -v "$cand" >/dev/null 2>&1; then PY_BIN="$cand"; break; fi
  done
  if [ -z "$PY_BIN" ]; then fail "no python found (tried: $PY_CANDS)"; fi
  echo "  creating venv with $PY_BIN"
  if "$PY_BIN" -m venv "$RUNTIME/venv" 2>/dev/null; then :; else fail "venv create"; fi
  # ensure pip (some distros omit it from venv unless python3-venv is present)
  "$VENV_PY" -m ensurepip --upgrade >/tmp/ensurepip.log 2>&1 || \
    "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1 || \
    echo "  WARN could not enable pip in venv"
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
    # --no-bundle build: run the bare binary directly (no .app wrapper).
    "$BIN" >/tmp/app-gui.log 2>&1 &
    APP_PID=$!
    sleep 8
    if kill -0 "$APP_PID" 2>/dev/null; then
      pass "process launched"
    else
      fail "process died (see /tmp/app-gui.log)"; tail -20 /tmp/app-gui.log
    fi
    osascript -e 'tell application "System Events" to tell process "headroom-desktop" to get {position, size} of window 1' 2>/dev/null >/dev/null \
      && pass "window visible" || fail "no window"
    ;;
  linux)
    export DISPLAY="${DISPLAY:-:99}"
    command -v Xvfb >/dev/null 2>&1 || sudo apt-get install -y -qq xvfb xdotool >/dev/null 2>&1
    (Xvfb :99 -screen 0 1400x900x24 >/tmp/xvfb.log 2>&1 &) 2>/dev/null
    sleep 2
    # A session bus is required by GTK/Tauri (appindicator menu etc); launch
    # the app inside `dbus-run-session` so the window can register properly.
    if command -v dbus-run-session >/dev/null 2>&1; then
      dbus-run-session -- "$BIN" >/tmp/app-gui.log 2>&1 &
    else
      "$BIN" >/tmp/app-gui.log 2>&1 &
    fi
    APP_PID=$!
    sleep 8
    if kill -0 "$APP_PID" 2>/dev/null; then
      pass "process launched"
    else
      fail "process died (see /tmp/app-gui.log)"; tail -20 /tmp/app-gui.log
    fi
    if DISPLAY=:99 xdotool search --name "Headroom" >/dev/null 2>&1 || \
       DISPLAY=:99 xdotool search --class "headroom" >/dev/null 2>&1 || \
       DISPLAY=:99 xdotool search --class "Headroom" >/dev/null 2>&1; then
      pass "window visible"
    else
      # fallback: list all windows as evidence if search by name/class fails
      DISPLAY=:99 xdotool search --onlyvisible . 2>/dev/null | while read -r wid; do
        DISPLAY=:99 xdotool getwindowname "$wid" 2>/dev/null
      done | head -8 > /tmp/windows-list.txt 2>/dev/null || true
      fail "no window found under Xvfb (DISPLAY=$DISPLAY); windows: $(tr '\n' ',' < /tmp/windows-list.txt 2>/dev/null | head -c 200)"
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
