#!/usr/bin/env bash
# Installs, or moves to a new commit, the sanctions adder on an always-on
# Ubuntu machine (ops/sanctions-adder/README.md).
#
#   C=<full commit sha on main>
#   curl -fsSL -o install.sh "https://raw.githubusercontent.com/vaipakam/vaipakam/$C/ops/sanctions-adder/install.sh"
#   sudo bash install.sh "$C"
#
# Download first and run second, so a transfer cut short can never run half a
# script; the body is one function called on the last line for the same
# reason.
#
# A deploy is a DELIBERATE act, never a merge: the adder signs compliance
# updates, so the code it runs is the commit an operator named, and that
# commit must be on main (reviewed). Nothing here follows a branch.
#
# Safe to run again. It never overwrites an env file and never ENABLES or
# STARTS a timer: enabling a chain's timer is the cutover in the README, done
# once its env file is filled in and its key appointed adder.
#
# Needs systemd 247+ (LoadCredential=) and Node 22 at /usr/local/bin/node. On
# the keeper machine the keeper's own install provides that Node.
set -euo pipefail

main() {
  local commit="${1:-}"
  local REPO_URL="https://github.com/vaipakam/vaipakam.git"
  local ROOT=/opt/vaipakam-sanctions-adder
  local ETC=/etc/vaipakam/sanctions-adder

  log() { echo "[sanctions-adder-install] $*"; }
  die() { echo "[sanctions-adder-install] $*" >&2; exit 1; }
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

  export DEBIAN_FRONTEND=noninteractive
  command -v git >/dev/null || { apt-get update -q >/dev/null; apt-get install -y -q git ca-certificates >/dev/null; }

  mkdir -p "$ROOT/releases"
  chmod 755 "$ROOT" "$ROOT/releases"

  # The source, root-owned. Fetched fresh from main every run.
  if [ ! -d "$ROOT/repo/.git" ]; then
    log "cloning $REPO_URL"
    rm -rf "$ROOT/repo"
    git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$ROOT/repo"
  fi
  git -C "$ROOT/repo" remote set-url origin "$REPO_URL"
  git -C "$ROOT/repo" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"
  git -C "$ROOT/repo" cat-file -e "${commit}^{commit}" 2>/dev/null || die "commit $commit is not in $REPO_URL"
  git -C "$ROOT/repo" merge-base --is-ancestor "$commit" origin/main || die "commit $commit is not on main: only reviewed code is deployed"

  local rel="$ROOT/releases/$commit"
  if [ ! -f "$rel/.complete" ]; then
    log "building release $commit"
    rm -rf "$rel"
    local build
    build="$(mktemp -d "$ROOT/releases/.build.XXXXXX")"
    # Only what the adder runs: the contracts package (its scripts, compiled
    # ABIs and fixture), the workspace manifests pnpm needs to honour the
    # lockfile, and this kit for the units.
    git -C "$ROOT/repo" archive "$commit" package.json pnpm-lock.yaml pnpm-workspace.yaml packages/contracts ops/sanctions-adder \
      | tar -x --no-same-owner -C "$build"
    # Dependencies exactly as the lockfile pins them, checked against its
    # hashes. --ignore-scripts: nothing a package ships runs during install.
    # Corepack's pnpm and pnpm's store live in the build directory and are
    # removed with it.
    (
      cd "$build"
      HOME="$build/.home" COREPACK_HOME="$build/.corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
        /usr/local/bin/corepack pnpm install --frozen-lockfile --ignore-scripts --filter '@vaipakam/contracts' \
        --store-dir "$build/.store" >/dev/null
    )
    rm -rf "$build/.home" "$build/.corepack"
    echo "$commit" > "$build/SOURCE_COMMIT"
    chown -R root:root "$build"
    chmod -R go-w "$build"
    /usr/bin/env -i /usr/local/bin/node "$build/packages/contracts/scripts/sanctions-adder.mjs" --check
    touch "$build/.complete"
    mv -T "$build" "$rel"
  fi

  # Units from the release itself, so they always match the code they run.
  install -m 644 "$rel/ops/sanctions-adder/vaipakam-sanctions-adder@.service" /etc/systemd/system/
  install -m 644 "$rel/ops/sanctions-adder/vaipakam-sanctions-adder@.timer" /etc/systemd/system/
  ln -sfn "$rel" "$ROOT/current.new"
  mv -T "$ROOT/current.new" "$ROOT/current"
  systemctl daemon-reload

  # Keep the release in use and the one before it.
  local keep
  keep="$(ls -1t "$ROOT/releases" | grep -E '^[0-9a-f]{40}$' | head -2)"
  for r in $(ls -1 "$ROOT/releases" | grep -E '^[0-9a-f]{40}$'); do
    grep -qx "$r" <<<"$keep" || rm -rf "${ROOT:?}/releases/$r"
  done
  rm -rf "$ROOT"/releases/.build.*

  install -d -m 700 "$ETC"
  install -m 600 "$rel/ops/sanctions-adder/adder.env.example" "$ETC/example.env.template"

  log "release $commit is current."
  log "per chain, once (see README §3):"
  log "  cp $ETC/example.env.template $ETC/<chain-slug>.env && chmod 600 $ETC/<chain-slug>.env  # fill it in"
  log "  systemctl start vaipakam-sanctions-adder@<chain-slug>.service   # one run now"
  log "  systemctl enable --now vaipakam-sanctions-adder@<chain-slug>.timer"
}

main "$@"
