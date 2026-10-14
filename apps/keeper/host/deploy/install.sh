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
# KEEPER_DEPLOY_BRANCH picks the branch the machine follows from then on; it
# is remembered in /opt/vaipakam-keeper/deploy-branch, and a later run
# without it keeps the remembered branch (main on a first install).
#
# Needs systemd 247 or newer (Ubuntu 22.04 or later) for LoadCredential=.
set -euo pipefail

main() {
  local REPO_URL="https://github.com/vaipakam/vaipakam.git"
  local NODE_MAJOR=22
  local ROOT=/opt/vaipakam-keeper
  # A reinstall must never move the machine to other code by itself.
  local BRANCH="${KEEPER_DEPLOY_BRANCH:-$(cat "$ROOT/deploy-branch" 2>/dev/null || echo main)}"

  log() { echo "[keeper-install] $*"; }

  [ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
  # The keeper unit reads its env file through LoadCredential= (systemd 247).
  local systemd_version
  systemd_version="$(systemctl --version | awk 'NR==1 { print $2 }')"
  if ! [ "${systemd_version%%.*}" -ge 247 ] 2>/dev/null; then
    echo "systemd ${systemd_version:-unknown} is too old: the keeper needs 247 or newer (Ubuntu 22.04 or later)" >&2
    exit 1
  fi

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
  # Global, not local: the EXIT trap runs after main() has returned, when a
  # local would be out of scope (and `set -u` would fail the install).
  INSTALL_TMP="$(mktemp -d)"
  trap 'rm -rf "${INSTALL_TMP:-}"' EXIT
  local tmp="$INSTALL_TMP"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  local file
  file="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || { echo "no Node ${NODE_MAJOR} build for linux-${arch} on nodejs.org" >&2; exit 1; }
  local latest="${file#node-}"
  latest="${latest%%-linux-*}"
  # The runtime lives in a directory this script owns outright, so every
  # rule below applies only there: versions side by side, `current` naming
  # the one in use, and the four commands in /usr/local/bin pointing through
  # it. Nothing outside NODE_HOME is ever chowned, chmodded or pruned.
  local NODE_HOME=/usr/local/lib/vaipakam-node
  install -d -o root -g root -m 755 "$NODE_HOME"
  local installed=""
  if [ -x "$NODE_HOME/current/bin/node" ]; then
    installed="$("$NODE_HOME/current/bin/node" -v)"
  fi
  if [ "$installed" != "$latest" ]; then
    log "installing Node $latest (was: ${installed:-none})"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
    local incoming
    incoming="$(mktemp -d "$NODE_HOME/.incoming.XXXXXX")"
    # Root's tar would otherwise keep the archive's owner ids, which can match
    # a local account that could then replace the runtime the keeper runs.
    tar --no-same-owner -xJf "$tmp/$file" -C "$incoming" --strip-components=1
    chown -R root:root "$incoming"
    chmod -R go-w "$incoming"
    chmod 755 "$incoming"
    rm -rf "${NODE_HOME:?}/$latest"
    mv -T "$incoming" "$NODE_HOME/$latest"
    ln -sfn "$latest" "$NODE_HOME/current.next"
    mv -Tf "$NODE_HOME/current.next" "$NODE_HOME/current"
  fi
  # Keep the version in use and the one before it; remove older ones (and
  # any half-extracted .incoming left by an interrupted run).
  local keep_prev="$installed" entry
  for entry in "$NODE_HOME"/* "$NODE_HOME"/.incoming.*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in
      current | "$latest" | "${keep_prev:-$latest}") ;;
      *) rm -rf "$entry" ;;
    esac
  done
  # Enforced every run, within NODE_HOME only.
  chown -R root:root "$NODE_HOME"
  chmod -R go-w "$NODE_HOME"
  local bin
  for bin in node npm npx corepack; do ln -sfn "$NODE_HOME/current/bin/$bin" "/usr/local/bin/$bin"; done

  # Everything under /opt/vaipakam-keeper is root's: the checkout the code
  # comes from, the scripts and the releases. Builds run as a throwaway
  # dynamic user (build.sh), and the keeper as another, which is the only
  # one that sees the env file.
  if [ -L "$ROOT" ] || [ -L "$ROOT/releases" ] || [ -L "$ROOT/repo" ]; then
    echo "$ROOT and its releases/ and repo/ must not be links; fix them by hand and re-run" >&2
    exit 1
  fi
  install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"
  echo "$BRANCH" > "$ROOT/deploy-branch"
  # The updater runs git as root in this checkout, and a git config can name
  # programs git runs. So a checkout any other account could ever have
  # written is not repaired in place: it is deleted and cloned again.
  if [ -e "$ROOT/repo" ] && [ -n "$(find "$ROOT/repo" \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) -print -quit)" ]; then
    log "the existing checkout is not entirely root-owned and root-only-writable; cloning it again"
    rm -rf "$ROOT/repo"
  fi
  if [ ! -d "$ROOT/repo/.git" ]; then
    rm -rf "$ROOT/repo"
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

  if [ -L /etc/vaipakam ] || [ -L /etc/vaipakam/keeper.env ]; then
    echo "/etc/vaipakam and its keeper.env must not be links; fix them by hand and re-run" >&2
    exit 1
  fi
  install -d -o root -g root -m 750 /etc/vaipakam
  if [ ! -e /etc/vaipakam/keeper.env ]; then
    install -m 600 -o root -g root "$kit/keeper.env.example" /etc/vaipakam/keeper.env
    log "created /etc/vaipakam/keeper.env from the template; fill it in before the cutover"
  fi
  # Enforced on every run, not only at creation: a file or directory made
  # earlier by hand or by other tooling keeps its contents but not looser
  # access. The file holds the signing key and an account-wide D1 token.
  if [ ! -f /etc/vaipakam/keeper.env ]; then
    echo "/etc/vaipakam/keeper.env must be a regular file; fix it by hand and re-run" >&2
    exit 1
  fi
  chown root:root /etc/vaipakam /etc/vaipakam/keeper.env
  chmod 750 /etc/vaipakam
  chmod 600 /etc/vaipakam/keeper.env

  # A unit file is replaced only when its content changed, so its mtime says
  # when it last changed; the restart check below relies on that.
  local unit
  for unit in vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer; do
    if ! cmp -s "$kit/$unit" "/etc/systemd/system/$unit"; then
      install -m 644 "$kit/$unit" "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload
  # Deploys are turned on once, by the install that first completes. After
  # that the timer's state is the operator's: a reinstall (say, for a Node
  # security release) while deploys are paused for a rollback must not
  # resume them (§6). Completion is its own marker, written at the very end,
  # so an install interrupted before it finishes turns them on when re-run.
  if [ ! -e "$ROOT/.installed" ]; then
    systemctl enable --quiet --now vaipakam-keeper-update.timer
  fi
  if systemctl is-enabled --quiet vaipakam-keeper-update.timer; then
    log "deploying the latest build (the first one can take a few minutes)"
    systemctl start vaipakam-keeper-update.service
  else
    log "deploys are paused (the update timer is disabled), so nothing was deployed; resume per docs/ops/KeeperMachine.md §6"
  fi
  log "current release: $(cat "$ROOT/current/SOURCE_COMMIT" 2>/dev/null || echo none)"

  # daemon-reload alone leaves a running keeper on its old unit and its old
  # Node. Rather than remember what this run changed (which an interrupted
  # run would forget), compare what is installed now with when the running
  # keeper started: restart it, after its current tick, if Node or its unit
  # changed since then. Re-running after any interruption reaches the same
  # answer.
  if systemctl is-active --quiet vaipakam-keeper.service; then
    local started changed
    started="$(date -d "$(systemctl show -p ActiveEnterTimestamp --value vaipakam-keeper.service)" +%s 2>/dev/null || echo 0)"
    changed="$(stat -c %Y "$NODE_HOME/current" /etc/systemd/system/vaipakam-keeper.service | sort -n | tail -1)"
    if [ "$changed" -ge "$started" ]; then
      log "Node or the keeper unit changed since the keeper started; it restarts after its current tick"
      systemctl try-restart --no-block vaipakam-keeper.service
    fi
  fi
  if systemctl is-active --quiet vaipakam-keeper.service; then
    log "keeper is running"
  else
    log "keeper is installed but NOT enabled or started. Fill in /etc/vaipakam/keeper.env, then follow the cutover in docs/ops/KeeperMachine.md §5"
  fi
  touch "$ROOT/.installed"
}

main "$@"
