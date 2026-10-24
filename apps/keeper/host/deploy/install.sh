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
# and scripts of the running release, moves Node to the latest 22.x
# (restarting a running keeper onto it) and the GitHub CLI to its latest
# release. It never ENABLES or STARTS the
# keeper. That is the explicit cutover in docs/ops/KeeperMachine.md §5, so
# a machine that is installed but not yet cut over cannot start a second
# keeper at its next boot.
#
# The machine follows main, the one branch CI builds and attests the keeper
# from (.github/workflows/keeper-host-release.yml); it never builds itself.
#
# Needs systemd 247 or newer (Ubuntu 22.04 or later) for LoadCredential=.
set -euo pipefail

main() {
  local REPO_URL="https://github.com/vaipakam/vaipakam.git"
  local NODE_MAJOR=22
  local ROOT=/opt/vaipakam-keeper

  log() { echo "[keeper-install] $*"; }
  # Nothing this script or the updater creates is group- or world-writable,
  # whatever umask it was started with.
  umask 022

  [ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
  # Machines once could follow another branch. CI publishes builds of main
  # only, so a machine on any other branch would never receive one.
  if [ -n "${KEEPER_DEPLOY_BRANCH:-}" ] && [ "$KEEPER_DEPLOY_BRANCH" != main ]; then
    echo "KEEPER_DEPLOY_BRANCH=$KEEPER_DEPLOY_BRANCH: the keeper machine follows main only, the one branch CI builds the keeper from" >&2
    exit 1
  fi
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

  # The GitHub CLI, which verifies the provenance of every keeper bundle
  # before update.sh installs it. It comes from GitHub's own apt repository,
  # whose keyring is checked against the SHA-256 GitHub publishes for it
  # (https://github.com/cli/cli/blob/trunk/docs/install_linux.md), so a
  # substituted key stops the install instead of being trusted. The keyring
  # and the source line are written again on every run, and apt moves gh to
  # its latest release.
  local GH_KEYRING_SHA256=6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b
  local gh_keyring=/etc/apt/keyrings/githubcli-archive-keyring.gpg
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$tmp/githubcli.gpg"
  if ! echo "$GH_KEYRING_SHA256  $tmp/githubcli.gpg" | sha256sum -c --quiet - >/dev/null 2>&1; then
    echo "the GitHub CLI keyring at cli.github.com does not match the SHA-256 this script pins; check docs/install_linux.md in cli/cli before changing the pin" >&2
    exit 1
  fi
  install -d -o root -g root -m 755 /etc/apt/keyrings
  install -m 644 -o root -g root "$tmp/githubcli.gpg" "$gh_keyring"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=$gh_keyring] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  log "installing the GitHub CLI"
  apt-get update -q >/dev/null
  apt-get install -y -q gh >/dev/null
  if ! gh attestation verify --help >/dev/null 2>&1; then
    echo "the installed GitHub CLI ($(gh --version | head -1)) cannot verify attestations" >&2
    exit 1
  fi

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
  #
  # Nothing in it is run, not even `node -v`, unless the whole tree is root's
  # and writable only by root; otherwise it is deleted and installed again.
  local NODE_HOME=/usr/local/lib/vaipakam-node
  if [ -L "$NODE_HOME" ]; then
    echo "$NODE_HOME must not be a link; remove it by hand and re-run" >&2
    exit 1
  fi
  if [ -e "$NODE_HOME" ] && [ -n "$(find "$NODE_HOME" \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) -print -quit)" ]; then
    log "$NODE_HOME is not entirely root's; installing Node again from nothing"
    rm -rf "$NODE_HOME"
  fi
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
  local bin
  for bin in node npm npx corepack; do ln -sfn "$NODE_HOME/current/bin/$bin" "/usr/local/bin/$bin"; done

  # Everything under /opt/vaipakam-keeper is root's: the checkout the code
  # comes from, the scripts, the releases and the state files. A new bundle
  # is verified and load-checked as a throwaway dynamic user (update.sh), and
  # the keeper runs as another, which is the only one that sees the env file.
  #
  # One rule decides whether any of it is trusted, rather than a check per
  # file: the tree is used as it stands only if a completed install made it
  # (the .installed marker) AND nothing in it is owned by anyone but root or
  # writable by anyone but root. Otherwise it is deleted and built again
  # from nothing. Before an install completes it holds nothing that cannot
  # be rebuilt, and a tree another account could ever have written (a
  # planted git config, a pre-made release, a linked state file) is not
  # something to repair piece by piece.
  #
  # The whole section holds the deploy lock update.sh takes, so a deploy
  # never runs while this rebuilds the tree or reinstalls the kit.
  exec 9>/run/vaipakam-keeper-deploy.lock
  flock 9
  if [ -L "$ROOT" ]; then
    echo "$ROOT must not be a link; remove it by hand and re-run" >&2
    exit 1
  fi
  if [ -e "$ROOT" ]; then
    if [ ! -f "$ROOT/.installed" ] || [ -L "$ROOT/.installed" ] \
      || [ -n "$(find "$ROOT" \( ! -user root -o ! -group root -o \( ! -type l -perm /022 \) \) -print -quit)" ]; then
      log "$ROOT was not made by a completed install, or another account could have written it; starting it again from nothing"
      rm -rf "$ROOT"
    fi
  fi
  local BRANCH=main
  install -d -o root -g root -m 755 "$ROOT" "$ROOT/releases"
  # Where an older install remembered a branch to follow; nothing reads it.
  rm -f "$ROOT/deploy-branch"
  if [ ! -d "$ROOT/repo/.git" ]; then
    rm -rf "$ROOT/repo"
    log "cloning $REPO_URL"
    git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$ROOT/repo"
  fi
  git -C "$ROOT/repo" remote set-url origin "$REPO_URL"
  git -C "$ROOT/repo" fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  # The kit comes from the commit that is running, so a reinstall never puts
  # a newer commit's units under the release in use (say, while deploys are
  # paused for a rollback). Only a machine with no release yet takes the
  # branch tip, and its first deploy then installs the kit of whatever
  # commit it deploys.
  local kit_commit
  kit_commit="$(cat "$ROOT/current/SOURCE_COMMIT" 2>/dev/null || git -C "$ROOT/repo" rev-parse "origin/$BRANCH")"
  if ! [[ "$kit_commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "could not tell which commit is running ($kit_commit); fix $ROOT/current by hand and re-run" >&2
    exit 1
  fi
  local kit="$tmp/kit"
  mkdir -p "$kit"
  git -C "$ROOT/repo" archive "$kit_commit" apps/keeper/host/deploy | tar -x --no-same-owner -C "$kit"
  kit="$kit/apps/keeper/host/deploy"

  # Only the updater is installed from here. It then installs the units (and
  # itself again) through --kit-only below, and from then on each deploy
  # installs the units and the updater of the commit it deploys, so code
  # never runs under another commit's kit.
  install -m 755 -o root -g root "$kit/update.sh" "$ROOT/.update.sh.new"
  mv -Tf "$ROOT/.update.sh.new" "$ROOT/update.sh"
  rm -f "$ROOT/build.sh"

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
  chown root:root /etc/vaipakam
  chmod 750 /etc/vaipakam
  # A fresh root-owned copy replaces the file, rather than a chown of it: an
  # account that could write the old file may still hold it open, and a new
  # inode is out of that descriptor's reach. The contents are kept.
  install -m 600 -o root -g root /etc/vaipakam/keeper.env /etc/vaipakam/.keeper.env.new
  mv -Tf /etc/vaipakam/.keeper.env.new /etc/vaipakam/keeper.env

  # The units, from the same code that deploys them, still under the lock.
  # It replaces a unit only when its content changed, so a unit's mtime says
  # when it last changed; the restart check below relies on that.
  VAIPAKAM_DEPLOY_LOCK_HELD=1 "$ROOT/update.sh" --kit-only "$kit_commit"
  # Released before starting a deploy below, which takes the lock itself.
  exec 9>&-
  # Deploys are turned on once, by the install that first completes. After
  # that the timer's state is the operator's: a reinstall (say, for a Node
  # security release) while deploys are paused for a rollback must not
  # resume them (§6). Completion is its own marker, written at the very end,
  # so an install interrupted before it finishes turns them on when re-run.
  if [ ! -e "$ROOT/.installed" ]; then
    systemctl enable --quiet --now vaipakam-keeper-update.timer
  fi
  if systemctl is-enabled --quiet vaipakam-keeper-update.timer; then
    log "deploying the latest release CI has published"
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
