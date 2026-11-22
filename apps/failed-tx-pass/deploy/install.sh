#!/usr/bin/env bash
# Installs, or moves to a new commit, the failed transaction pass on the
# keeper machine (apps/failed-tx-pass/README.md).
#
#   C=<full commit sha on main>
#   curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/apps/failed-tx-pass/deploy/install.sh"
#   sudo bash install.sh "$C"
#
# Download first and run second, so a transfer cut short can never run half a
# script; the body is one function called on the last line for the same
# reason.
#
# A deploy names a commit, and that commit must be on main (reviewed). It
# builds the pass's bundle in a release directory of its own, never in the
# keeper's, and points /opt/vaipakam-failed-tx/current at it.
#
# Safe to run again. It creates the env file from its template only when the
# file does not exist, never overwrites one, and never ENABLES or STARTS the
# timer: enabling it is the cutover in the README, done once the env file is
# filled in and the indexer holds the same writer token.
#
# Needs systemd 247+ (LoadCredential=) and Node 22+ at /usr/local/bin/node,
# which the keeper's install provides.
set -euo pipefail

main() {
  local commit="${1:-}"
  local REPO_URL="https://github.com/vaipakam/vaipakam.git"
  local ROOT=/opt/vaipakam-failed-tx
  local UNITS=(vaipakam-failed-tx.service vaipakam-failed-tx.timer)

  log() { echo "[failed-tx-install] $*"; }
  die() { echo "[failed-tx-install] $*" >&2; exit 1; }
  umask 022

  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "usage: sudo bash install.sh <full 40-character commit sha on main>"
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
  local systemd_version
  systemd_version="$(systemctl --version | awk 'NR==1 { print $2 }')"
  [ "${systemd_version%%.*}" -ge 247 ] 2>/dev/null || die "systemd ${systemd_version:-unknown} is too old: 247 or newer is needed"
  [ -x /usr/local/bin/node ] || die "no Node at /usr/local/bin/node: install Node 22 first (the keeper's install.sh does)"
  local node_major
  node_major="$(/usr/local/bin/node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] 2>/dev/null || die "Node $node_major at /usr/local/bin/node: 22 or newer is needed"

  exec 9>/run/vaipakam-failed-tx-deploy.lock
  flock -n 9 || { log "waiting for another install to finish"; flock 9; }

  mkdir -p "$ROOT/releases"
  local rel="$ROOT/releases/$commit"
  if [ ! -f "$rel/apps/failed-tx-pass/dist/failed-tx-pass.mjs" ]; then
    local tmp="$ROOT/releases/.build-$commit"
    rm -rf "$tmp"
    log "fetching $commit"
    git init -q "$tmp"
    git -C "$tmp" remote add origin "$REPO_URL"
    git -C "$tmp" fetch -q --filter=blob:none origin main "$commit"
    git -C "$tmp" merge-base --is-ancestor "$commit" FETCH_HEAD 2>/dev/null \
      || git -C "$tmp" merge-base --is-ancestor "$commit" origin/main \
      || die "$commit is not on main"
    git -C "$tmp" -c advice.detachedHead=false checkout -q "$commit"
    log "building the bundle"
    (
      cd "$tmp"
      export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
      PATH="/usr/local/bin:$PATH" corepack pnpm install --frozen-lockfile --filter @vaipakam/failed-tx-pass... >/dev/null
      PATH="/usr/local/bin:$PATH" corepack pnpm --filter @vaipakam/failed-tx-pass build >/dev/null
    )
    [ -f "$tmp/apps/failed-tx-pass/dist/failed-tx-pass.mjs" ] || die "the build left no bundle"
    # The pass's mode per network comes from the node capability check's
    # committed results (#3913); a commit without them would install a pass
    # that fails every network at its first read, so it is refused here.
    compgen -G "$tmp/ops/node-capability/results/*.json" >/dev/null \
      || die "$commit carries no node capability results (ops/node-capability/results/*.json, #3913): install a commit on main that includes them"
    # Only the bundle and the capability results are read at run time.
    rm -rf "$tmp/node_modules" "$tmp"/apps/*/node_modules "$tmp"/packages/*/node_modules
    mv "$tmp" "$rel"
  fi
  chown -R root:root "$rel"
  chmod -R go-w "$rel"
  ln -sfn "$rel" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
  log "current -> $commit"

  for u in "${UNITS[@]}"; do
    install -m 0644 "$rel/apps/failed-tx-pass/deploy/$u" "/etc/systemd/system/$u"
  done
  systemctl daemon-reload

  mkdir -p /etc/vaipakam
  chmod 0755 /etc/vaipakam
  if [ ! -f /etc/vaipakam/failed-tx.env ]; then
    install -m 0600 -o root -g root "$rel/apps/failed-tx-pass/deploy/failed-tx.env.example" /etc/vaipakam/failed-tx.env
    log "created /etc/vaipakam/failed-tx.env from the template: fill it in, then enable the timer"
  fi

  # Keep the current release and the one before it.
  ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +3 | while read -r old; do
    [ "$(readlink -f "$ROOT/current")" = "$(readlink -f "$old")" ] || rm -rf "$old"
  done
  log "done. The timer is not enabled by this script: systemctl enable --now vaipakam-failed-tx.timer"
}

main "$@"
