#!/usr/bin/env bash
# Sets up, or brings up to date, the keeper on an always-on Ubuntu machine.
#
#   curl -fsSL https://raw.githubusercontent.com/vaipakam/vaipakam/main/apps/keeper/host/deploy/install.sh | sudo bash
#
# Safe to run again: it never overwrites the env file and re-installs the
# units and update script from the deploy branch. It does NOT start the
# keeper. Fill in /etc/vaipakam/keeper.env first, then
#   sudo systemctl start vaipakam-keeper
# Full procedure: docs/ops/KeeperMachine.md.
#
# KEEPER_DEPLOY_BRANCH (default main) picks the branch the machine follows
# from then on; it is remembered in /opt/vaipakam-keeper/deploy-branch.
set -euo pipefail

REPO_URL="https://github.com/vaipakam/vaipakam.git"
BRANCH="${KEEPER_DEPLOY_BRANCH:-main}"
NODE_MAJOR=22
ROOT=/opt/vaipakam-keeper
BUILD_USER=vaipakam-build
BUILD_HOME=/var/lib/vaipakam-build

log() { echo "[keeper-install] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }

log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
apt-get install -y -q git curl ca-certificates xz-utils >/dev/null

# Node 22 from nodejs.org, checked against the release's published SHA-256.
# Installed outside the package manager, so every run compares the installed
# version with the latest 22.x and replaces it when they differ: re-running
# this script is how the machine takes Node security releases.
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) echo "unsupported CPU architecture $(uname -m)" >&2; exit 1 ;;
esac
base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
file="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
[ -n "$file" ] || { echo "no Node ${NODE_MAJOR} build for linux-${arch} on nodejs.org" >&2; exit 1; }
latest="${file#node-}"
latest="${latest%%-linux-*}"
installed=""
if [ -x /usr/local/bin/node ]; then
  installed="$(/usr/local/bin/node -v)"
fi
if [ "$installed" != "$latest" ]; then
  log "installing Node $latest (was: ${installed:-none})"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
  dir="/usr/local/lib/nodejs/${file%.tar.xz}"
  for bin in node npm npx corepack; do ln -sfn "$dir/bin/$bin" "/usr/local/bin/$bin"; done
fi
log "node $(/usr/local/bin/node -v)"

# Two areas, two owners. The build user owns only its home: the checkout, the
# package cache and the staging area. /opt/vaipakam-keeper (the releases the
# keeper runs, and the scripts) is root's, so a compromised build can offer a
# bundle but never install one (promote.sh). The keeper runs as a third,
# dynamic user and is the only one that sees the env file.
if ! id "$BUILD_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$BUILD_HOME" --create-home --shell /usr/sbin/nologin "$BUILD_USER"
fi
install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"
install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 755 "$BUILD_HOME" "$BUILD_HOME/staging"
echo "$BRANCH" > "$ROOT/deploy-branch"
if [ ! -d "$BUILD_HOME/repo/.git" ]; then
  log "cloning $REPO_URL"
  runuser -u "$BUILD_USER" -- git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$BUILD_HOME/repo"
fi
runuser -u "$BUILD_USER" -- git -C "$BUILD_HOME/repo" fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
runuser -u "$BUILD_USER" -- git -C "$BUILD_HOME/repo" checkout --quiet --force --detach "origin/$BRANCH"
deploy="$BUILD_HOME/repo/apps/keeper/host/deploy"

install -m 755 -o root -g root "$deploy/update.sh" "$ROOT/update.sh"
install -m 755 -o root -g root "$deploy/promote.sh" "$ROOT/promote.sh"

install -d -m 750 /etc/vaipakam
if [ ! -e /etc/vaipakam/keeper.env ]; then
  install -m 600 -o root -g root "$deploy/keeper.env.example" /etc/vaipakam/keeper.env
  log "created /etc/vaipakam/keeper.env from the template; fill it in before starting the keeper"
fi

for unit in vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer \
  vaipakam-keeper-promote.path vaipakam-keeper-promote.service; do
  install -m 644 "$deploy/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --quiet vaipakam-keeper.service
systemctl enable --quiet --now vaipakam-keeper-promote.path vaipakam-keeper-update.timer

log "building the keeper (first build can take a few minutes)"
systemctl start vaipakam-keeper-update.service
# The path unit promotes in the background; promote here too so the result
# is known before this script reports it (promote.sh is idempotent).
"$ROOT/promote.sh"
log "running release: $(cat "$ROOT/current/SOURCE_COMMIT" 2>/dev/null || echo none)"
if systemctl is-active --quiet vaipakam-keeper.service; then
  log "keeper is running"
else
  log "keeper is installed but NOT started. Fill in /etc/vaipakam/keeper.env, then: systemctl start vaipakam-keeper"
fi
