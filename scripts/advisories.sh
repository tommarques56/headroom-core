#!/usr/bin/env bash
# Dependency advisory audits, shared by CI's advisories job (test.yml) and the
# release train, which puts anything red at the top of its release PR. An
# advisories-only red still publishes a staging rc, so an advisory published
# overnight does not cost the night's verify; no stable ships until this passes
# (the release workflows wait for a green Test). Every accepted advisory is an
# ignore below with its reason; drop each with the pin that carries it.
# Usage: scripts/advisories.sh [rust|npm|python]... (no argument runs all three).
# Every audit runs even when an earlier one fails, so one run lists all of them.
set -u
cd "$(dirname "$0")/.."

rust() {
  # All remaining advisories have no reachable fix from this dependency
  # graph, so each is a documented ignore (the two quick-xml entries were
  # already here; the rest were added 2026-11-24 after bumping every
  # patchable crate — cookie/url/anyhow/event-listener/rustix/tokio/scc
  # were all resolved by `cargo update` alone).
  #
  # - quick-xml 0.37/0.38 (RUSTSEC-2026-0194/0195): reachable only through
  #   tauri's own tree (plist 1.8 pins ^0.38, tauri-winrt-notification 0.7
  #   pins ^0.37; both reject 0.41, so there is no upgrade from here).
  #   Neither parse path takes attacker-controlled XML -- plist reads our
  #   own bundle Info.plist, and the notification crate serializes toast XML
  #   we generate. Drop these the moment a tauri bump moves the pins;
  #   `cargo audit` prints them as unnecessary ignores when that happens.
  #
  # - Unmaintained crates with no fixed upgrade ("No fixed upgrade is
  #   available" in cargo-audit), reached transitively via deep first-party
  #   and Tauri dependency trees; none is a runtime attack surface for
  #   headroom's code paths:
  #     chrono      0.4.44    (RUSTSEC-2026-0543) direct dep, no fix
  #     fxhash      0.2.1     (RUSTSEC-2025-0057) transitive
  #     pin-utils   0.1.0     (RUSTSEC-2026-0441) transitive
  #     proc-macro-error 1.0.4 (RUSTSEC-2024-0370) transitive derive helper
  #     unic-*      0.9.0     (RUSTSEC-2025-0075/0080/0081/0098/0100) transitive
  #     zbus_names/zvariant/zvariant_derive (RUSTSEC-2026-0370/0371/0372) Linux D-Bus layer
  #
  # - glib 0.18.5 (RUSTSEC-2024-0429): the fixed version is >=0.20.0 but
  #   tauri 2.11 pins the gtk-rs 0.18 line, so bumping glib alone is not
  #   possible without a coordinated tauri upgrade (which also moves
  #   quick-xml). The unsoundness is in VariantStrIter, unused by headroom.
  #
  # - rand 0.7.3 (RUSTSEC-2026-0097): reached only through old transitive
  #   pins (e.g. the vendored Windows runtime tooling); headroom's code uses
  #   rand 0.9-style APIs or rand_chacha. Bumping to 0.8/0.9 needs a graph
  #   migration of those pins; not an attack surface here.
  #
  # Routine: each accepted advisory gets a line with its reason; drop each
  # with the bump that fixes it. `cargo audit` prints any ignore that has
  # become unnecessary, so re-running the job tells you when to delete.
  cargo audit --file src-tauri/Cargo.lock \
    --ignore RUSTSEC-2026-0194 \
    --ignore RUSTSEC-2026-0195 \
    --ignore RUSTSEC-2026-0543 \
    --ignore RUSTSEC-2025-0057 \
    --ignore RUSTSEC-2026-0441 \
    --ignore RUSTSEC-2024-0370 \
    --ignore RUSTSEC-2025-0075 \
    --ignore RUSTSEC-2025-0080 \
    --ignore RUSTSEC-2025-0081 \
    --ignore RUSTSEC-2025-0098 \
    --ignore RUSTSEC-2025-0100 \
    --ignore RUSTSEC-2026-0370 \
    --ignore RUSTSEC-2026-0371 \
    --ignore RUSTSEC-2026-0372 \
    --ignore RUSTSEC-2024-0429 \
    --ignore RUSTSEC-2026-0097
}

npm() {
  # --omit=dev: a devDependency advisory is not in the shipped bundle and
  # would block releases on something users never run.
  command npm audit --audit-level=high --omit=dev
}

python() {
  # Audits the pins each platform installs, not the lock files as-is:
  # pip-audit evaluates environment markers against the runner, so a
  # direct audit silently skips the Intel-Mac-only pins. --export
  # resolves markers per target first (offline). The ignores:
  # - PYSEC-2025-194 (torch.jit.script memory corruption): exploiting it
  #   means running attacker-written TorchScript locally, and nothing in
  #   headroom calls torch.jit. The fix is torch 2.13, a native bump with
  #   its own macOS-arch review; drop the ignore with that bump.
  # - PYSEC-2026-3447 (setuptools MANIFEST.in excludes vs NFD names):
  #   only reachable when building an sdist, which the runtime never does
  #   (--only-binary=:all:). Drop when setuptools moves to >=83.
  # - PYSEC-2026-3552/3553/3554: cryptography 48.0.1 on Intel Macs only,
  #   GHSA-g6cj-pr64-35w5 / GHSA-jwv3-5hgf-82ww / GHSA-m2h6-j472-rp4c,
  #   verified unreachable 2026-08-17 (see headroom-requirements.lock).
  #   Drop with that pin.
  # - GHSA-xmj3-9gf7-h52w (setuptools 81.0.0, macOS and Windows locks:
  #   Wheel.install_as_egg writes an __init__.py stub at a path a wheel's
  #   namespace_packages.txt picks, Windows only): fix 84.1.0, but torch
  #   2.12.1 requires setuptools<82, so no lock resolves. Reached only by a
  #   legacy setup_requires egg fetch; nothing outside setuptools and pip
  #   calls install_as_egg, setuptools.wheel or fetch_build_egg, and the
  #   runtime installs --only-binary. Drop with the torch 2.13 bump (which
  #   lifts the cap to >=77.0.3), with PYSEC-2026-3447.
  # - GHSA-g5ff-637f-6q2m (litellm <1.95.0, every lock: an authenticated
  #   LiteLLM PROXY SERVER user reads local files by sending
  #   vertex_ai_credentials to /utils/transform_request). headroom uses
  #   litellm only as a library (cost_per_token, get_model_info,
  #   token_counter, acompletion); its one litellm.proxy reference is a
  #   usage example in integrations/asgi.py's docstring, so that server
  #   never runs. 1.95.0 has no macOS wheels, and 1.95.1 swaps the pure
  #   Python wheel for a 17 MB Rust native (its macOS arm64 wheel names it
  #   for cp310) plus price-map churn that feeds savings. Accepted by Garm
  #   2026-10-28. Drop with the locks' move to >=1.95; revisit when litellm
  #   ships a clean py3 wheel or headroom imports litellm.proxy.
  local py pa targets target status=0
  # The submodule: the repo's own packaging/ dir imports as an empty namespace package.
  if python3 -c 'import packaging.requirements' 2>/dev/null; then py=(python3); else py=(uvx --with packaging python); fi
  if command -v pip-audit >/dev/null; then pa=(pip-audit); else pa=(uvx pip-audit@2.10.1); fi
  targets=$(mktemp -d)
  "${py[@]}" scripts/hash-python-locks.py --export "$targets" || { rm -rf "$targets"; return 1; }
  for target in "$targets"/*.txt; do
    echo "== $(basename "$target" .txt)"
    "${pa[@]}" -r "$target" --disable-pip --progress-spinner off \
      --ignore-vuln PYSEC-2025-194 \
      --ignore-vuln PYSEC-2026-3447 \
      --ignore-vuln PYSEC-2026-3552 \
      --ignore-vuln PYSEC-2026-3553 \
      --ignore-vuln PYSEC-2026-3554 \
      --ignore-vuln GHSA-xmj3-9gf7-h52w \
      --ignore-vuln GHSA-g5ff-637f-6q2m || status=1
  done
  rm -rf "$targets"
  return "$status"
}

status=0
[ $# -gt 0 ] || set -- rust npm python
for audit in "$@"; do
  case $audit in
    rust|npm|python) echo "=== $audit advisories"; "$audit" || status=1 ;;
    *) echo "usage: scripts/advisories.sh [rust|npm|python]..." >&2; exit 2 ;;
  esac
done
exit "$status"
