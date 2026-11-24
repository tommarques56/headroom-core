#!/usr/bin/env bash
# gui-capture.sh <start|stop> <out-dir>
#
# Records the real desktop (or Xvfb framebuffer) while the GUI test runs, so a
# human can watch the app window open and the button being exercised.
#
#   ./gui-capture.sh start /tmp/gui-proof   # starts ffmpeg screencast
#   ./gui-capture.sh stop  /tmp/gui-proof   # stops it (writes <out>/gui-test.mp4)
#
# Per-OS capture:
#   macos   : ffmpeg -f avfoundation (default screen device)
#   linux   : ffmpeg -f x11grab  (DISPLAY, default :99)
#   windows : ffmpeg -f gdigrab  (desktop)
set -uo pipefail

ACTION="${1:-}"
OUTDIR="${2:-/tmp/gui-proof}"
mkdir -p "$OUTDIR"
PIDFILE="$OUTDIR/capture.pid"
MP4="$OUTDIR/gui-test.mp4"

OS=$(uname -s)
is_windows() { [ "${OS#MINGW}" != "$OS" ] || [ "${OS#MSYS}" != "$OS" ] || [ "${OS#CYGWIN}" != "$OS" ]; }

case "$ACTION" in
  start)
    rm -f "$MP4"
    if is_windows; then
      ffmpeg -y -f gdigrab -framerate 10 -i desktop -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$MP4" >/tmp/capture.log 2>&1 &
    elif [ "$OS" = "Darwin" ]; then
      # macOS: "Capture screen 0" is the built-in display (avfoundation)
      ffmpeg -y -f avfoundation -framerate 10 -video_size 1440x900 -i "0:" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$MP4" >/tmp/capture.log 2>&1 &
    else
      # Linux: grab the Xvfb framebuffer
      DISPLAY="${DISPLAY:-:99}" ffmpeg -y -f x11grab -framerate 10 -video_size 1400x900 -i "$DISPLAY+0,0" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$MP4" >/tmp/capture.log 2>&1 &
    fi
    echo $! > "$PIDFILE"
    sleep 2
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "capture started (pid $(cat "$PIDFILE")) -> $MP4"
    else
      echo "capture failed to start; see /tmp/capture.log"
    fi
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      PID=$(cat "$PIDFILE")
      kill "$PID" 2>/dev/null
      # wait up to 8s for ffmpeg to finalize the mp4
      for _ in $(seq 1 8); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
      rm -f "$PIDFILE"
    fi
    if [ -f "$MP4" ] && [ -s "$MP4" ]; then
      echo "capture saved: $MP4 ($(du -h "$MP4" | cut -f1))"
    else
      echo "no video captured"
    fi
    ;;
  *)
    echo "usage: $0 <start|stop> <out-dir>"; exit 2 ;;
esac
