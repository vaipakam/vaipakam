#!/usr/bin/env bash
# Sets up, or brings up to date, the keeper on an always-on Ubuntu machine.
#
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/vaipakam/vaipakam/main/apps/keeper/host/deploy/install.sh
#   sudo bash install.sh
#
# Download first and run second, so a transfer cut short can never run half a
# script. The body is also one function called on the last line, for the
# same reason.
#
# Safe to run again: it never overwrites the env file, re-installs the units
# and scripts from the deploy branch, and moves Node to the latest 22.x
# (restarting a running keeper onto it). It never ENABLES or STARTS the
# keeper. That is the explicit cutover in docs/ops/KeeperMachine.md §5, so
# a machine that is installed but not yet cut over cannot start a second
# keeper at its next boot.
#
# KEEPER_DEPLOY_BRANCH (default main) picks the branch the machine follows
# from then on; it is remembered in /opt/vaipakam-keeper/deploy-branch.
set -euo pipefail

main() {
  local REPO_URL="https://github.com/vaipakam/vaipakam.git"
  local BRANCH="${KEEPER_DEPLOY_BRANCH:-main}"
  local NODE_MAJOR=22
  local ROOT=/opt/vaipakam-keeper

  log() { echo "[keeper-install] $*"; }

  [ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

  log "installing packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q >/dev/null
  apt-get install -y -q git curl ca-certificates xz-utils >/dev/null

  # Node 22 from nodejs.org, checked against the release's published SHA-256.
  # Installed outside the package manager, so every run compares the
  # installed version with the latest 22.x and replaces it when they differ:
  # re-running this script is how the machine takes Node security releases.
  local arch
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "unsupported CPU architecture $(uname -m)" >&2; exit 1 ;;
  esac
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  local file
  file="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || { echo "no Node ${NODE_MAJOR} build for linux-${arch} on nodejs.org" >&2; exit 1; }
  local latest="${file#node-}"
  latest="${latest%%-linux-*}"
  local installed=""
  if [ -x /usr/local/bin/node ]; then
    installed="$(/usr/local/bin/node -v)"
  fi
  local node_changed=no
  if [ "$installed" != "$latest" ]; then
    log "installing Node $latest (was: ${installed:-none})"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
    mkdir -p /usr/local/lib/nodejs
    tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
    local dir="/usr/local/lib/nodejs/${file%.tar.xz}"
    local bin
    for bin in node npm npx corepack; do ln -sfn "$dir/bin/$bin" "/usr/local/bin/$bin"; done
    node_changed=yes
  fi

  # Everything under /opt/vaipakam-keeper is root's: the checkout the code
  # comes from, the scripts and the releases. Builds run as a throwaway
  # dynamic user (build.sh), and the keeper as another, which is the only
  # one that sees the env file.
  install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"
  echo "$BRANCH" > "$ROOT/deploy-branch"
  if [ ! -d "$ROOT/repo/.git" ]; then
    log "cloning $REPO_URL"
    git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$ROOT/repo"
  fi
  git -C "$ROOT/repo" remote set-url origin "$REPO_URL"
  git -C "$ROOT/repo" fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  local kit="$tmp/kit"
  mkdir -p "$kit"
  git -C "$ROOT/repo" archive "origin/$BRANCH" apps/keeper/host/deploy | tar -x -C "$kit"
  kit="$kit/apps/keeper/host/deploy"

  install -m 755 -o root -g root "$kit/update.sh" "$ROOT/update.sh"
  install -m 755 -o root -g root "$kit/build.sh" "$ROOT/build.sh"

  install -d -m 750 /etc/vaipakam
  if [ ! -e /etc/vaipakam/keeper.env ]; then
    install -m 600 -o root -g root "$kit/keeper.env.example" /etc/vaipakam/keeper.env
    log "created /etc/vaipakam/keeper.env from the template; fill it in before the cutover"
  fi

  local unit
  for unit in vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer; do
    install -m 644 "$kit/$unit" "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl enable --quiet --now vaipakam-keeper-update.timer

  log "deploying the latest build (the first one can take a few minutes)"
  systemctl start vaipakam-keeper-update.service
  log "current release: $(cat "$ROOT/current/SOURCE_COMMIT" 2>/dev/null || echo none)"

  if [ "$node_changed" = yes ]; then
    systemctl try-restart --no-block vaipakam-keeper.service
  fi
  if systemctl is-active --quiet vaipakam-keeper.service; then
    log "keeper is running"
  else
    log "keeper is installed but NOT enabled or started. Fill in /etc/vaipakam/keeper.env, then follow the cutover in docs/ops/KeeperMachine.md §5"
  fi
}

main "$@"
