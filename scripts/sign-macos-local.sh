#!/bin/bash
# sign-macos-local.sh — Re-sign Headroom.app locally with your Apple Development
# identity so macOS stops re-prompting for ~/Documents (1 prompt total, persisted
# for the signed bundle) and stops re-prompting Keychain on every read/write.
#
#   ./scripts/sign-macos-local.sh [path/to/Headroom.app]
#
# Requirements: an Apple Development code-signing identity in your keychain
# (security find-identity -p codesigning) and Xcode installed (for xcrun).
#
# IMPORTANT (learned 2026-11-24): this app MUST NOT carry the
# keychain-access-groups entitlement — with it, the binary dies 1s after launch
# (SIGKILL, no log) under ad-hoc AND Apple Development signatures. It also must
# NOT have its venv python re-signed with a team identity: the app ad-hoc signs
# its own venv native extensions at install (tool_manager
# `ad_hoc_sign_venv_natives`), so we leave the runtime venv alone.
set -euo pipefail

# ── 0. Resolve paths ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PATH="${1:-/Applications/Headroom.app}"
BRANCH_APP="${REPO_ROOT}/src-tauri/target/release/bundle/macos/Headroom.app"
if [ ! -d "$APP_PATH" ] && [ -d "$BRANCH_APP" ]; then
  APP_PATH="$BRANCH_APP"
fi
if [ ! -d "$APP_PATH" ]; then
  echo "::error:: Headroom.app introuvable. Passe le chemin: $0 /chemin/vers/Headroom.app" >&2
  exit 1
fi
echo "→ App: $APP_PATH"

# ── 1. Identité de signature ────────────────────────────────────────────────
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"[^"]+"' | head -1 | tr -d '"')"
[ -n "$IDENTITY" ] || { echo "::error:: Aucune identité codesigning (Apple Development) trouvée." >&2; exit 1; }
echo "→ Identité: $IDENTITY"

ENTITLEMENTS_SRC="${REPO_ROOT}/src-tauri/Entitlements.plist"
[ -f "$ENTITLEMENTS_SRC" ] || { echo "::error:: Entitlements.plist introuvable: $ENTITLEMENTS_SRC" >&2; exit 1; }

# ── 2. Quitter toute instance en cours (évite les locks et TCC fantômes) ───
osascript -e 'tell application "Headroom" to quit' >/dev/null 2>&1 || true
sleep 1
pkill -f "Headroom.app/Contents/MacOS/headroom-desktop" 2>/dev/null || true
sleep 1

# ── 3. Signer le bundle (SEUL — pas le venv, qui reste adhoc géré par l'app) ─
echo "→ Signature de Headroom.app (entitlements: files.user-selected.read-write seulement)"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS_SRC" \
  --sign "$IDENTITY" "$APP_PATH"

# ── 4. Vérifications ────────────────────────────────────────────────────────
echo "→ Vérifications:"
codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | tail -3 || true
echo "→ Entitlements effectifs:"
codesign -d --entitlements :- "$APP_PATH" 2>/dev/null | plutil -convert xml1 -o - - 2>/dev/null | grep -E "files.user-selected|keychain-access-groups" || true

echo ""
echo "✅ Signature OK. Relance Headroom. Première ouverture : 1 seule demande Documents,"
echo "   plus aucun prompt trousseau répété (la signature Apple Development suffit)."
echo "   (Si Gatekeeper bloque : bouton droit → Ouvrir, ou Système → Confidentialité.)"
