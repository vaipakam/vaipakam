#!/usr/bin/env bash
# Deploys the deploy branch's tip to this machine, if it is not running yet.
#
# Run as root by vaipakam-keeper-update.service, every five minutes from its
# timer, never two at once (a oneshot unit does not overlap itself). One run:
#
#   1. fetches the deploy branch into root's own checkout, so no other
#      account can redirect where the code comes from;
#   2. stops if `current` is already that commit's release;
#   3. exports exactly that commit with `git archive` and builds it with
#      that commit's own build.sh in a throwaway sandbox: a fresh dynamic
#      user that cannot read
#      the env file or write the releases, keeps nothing once it ends (so no
#      build can leave tooling behind for the next), and runs the new bundle
#      with --check, so a build that cannot even load is never installed;
#   4. installs that same commit's systemd units and root-side scripts
#      (each only if it changed), so a bundle never runs under the units or
#      updater of another commit: a change that needs a new credential,
#      sandbox setting or ExecStart lands together with the code that needs
#      it;
#   5. copies the bundle into releases/<commit> and switches `current` to it
#      in one rename. Root chose the commit and built that commit's own
#      export, so the release is bound to it; nothing another account wrote
#      can be installed;
#   6. restarts a running keeper onto it gracefully, unless both the bundle
#      and the keeper's unit are unchanged (a merge that did not touch the
#      keeper), which needs no restart.
#
# Any failure exits non-zero before `current` moves, so the running keeper is
# untouched and the next run retries. A run interrupted after the switch, or
# whose restart could not be queued, leaves `restart-pending`, and the next
# run queues the restart.
#
# The kit and the release are bound by `kit-commit`, which names the commit
# whose units are installed and loaded. It is removed before a deploy touches
# the units and written again only once `current` is that commit's release,
# and the keeper unit refuses to start unless it matches current/SOURCE_COMMIT.
# So however a deploy is interrupted, the keeper never starts one commit's
# bundle under another commit's units; every run first puts back the kit of
# whatever `current` is, which also makes the keeper startable again.
#
# `update.sh --kit-only [<commit>]` does only that last step, under the same
# lock, for the installer: it installs the kit of the running release, or of
# <commit> on a machine with no release yet.
#
# What this cannot protect against is stated in docs/ops/KeeperMachine.md
# §1: whoever can merge to the branch, or tamper with a dependency the build
# fetches, controls what runs, as with the Workers' auto-deploy.
set -euo pipefail

ROOT=/opt/vaipakam-keeper
REPO="$ROOT/repo"
BRANCH="$(cat "$ROOT/deploy-branch" 2>/dev/null || echo main)"
KEEP_RELEASES=5

log() { echo "[keeper-update] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
umask 022

# One deploy lock, shared with install.sh, so a reinstall and a deploy never
# interleave their writes to the units, the scripts or `current`. The
# installer takes it itself and says so when it runs --kit-only.
if [ "${VAIPAKAM_DEPLOY_LOCK_HELD:-}" != 1 ]; then
  exec 9>/run/vaipakam-keeper-deploy.lock
  flock 9
fi

KIT_COMMIT="$ROOT/kit-commit"
WORK=""
incoming=""
# A run that fails part-way leaves neither its scratch nor a half-written
# release behind (the glob that prunes releases skips dot-directories).
trap 'rm -rf ${WORK:+"$WORK"} ${incoming:+"$incoming"}' EXIT
WORK="$(mktemp -d)"

# Replace a file only when its content changed (a unit's mtime is what
# install.sh's restart check reads), and by rename, so the copy of this
# script bash is running stays intact.
place() { # place <source> <destination> <mode>
  if ! cmp -s "$1" "$2"; then
    install -m "$3" -o root -g root "$1" "$2.new"
    mv -Tf "$2.new" "$2"
    return 0
  fi
  return 1
}

# Extract <commit>'s kit and print where. Fails, changing nothing, if its
# update.sh does not parse: installed, it would fail every later run before
# it could fetch a fix, so the working one is kept instead.
extract_kit() {
  local dir="$WORK/kit-$1"
  mkdir -p "$dir"
  git -C "$REPO" archive "$1" apps/keeper/host/deploy | tar -x --no-same-owner -C "$dir"
  dir="$dir/apps/keeper/host/deploy"
  if ! bash -n "$dir/update.sh"; then
    echo "[keeper-update] $1's update.sh does not parse; not installing it" >&2
    return 1
  fi
  echo "$dir"
}
# Install the units and update.sh of an extracted kit, then reload systemd.
# Sets keeper_unit_changed=yes when the keeper's own unit changed.
keeper_unit_changed=no
install_kit() {
  local dir="$1" unit
  for unit in vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer; do
    if place "$dir/$unit" "/etc/systemd/system/$unit" 644 && [ "$unit" = vaipakam-keeper.service ]; then
      keeper_unit_changed=yes
    fi
  done
  # Always: equal files do not prove systemd loaded them (a run interrupted
  # between placing a unit and reloading leaves exactly that), and the kit is
  # recorded as installed only after this.
  systemctl daemon-reload
  place "$dir/update.sh" "$ROOT/update.sh" 755 || true
}
# Record that <commit>'s kit is installed and loaded.
record_kit() {
  echo "$1" > "$KIT_COMMIT.new"
  mv -Tf "$KIT_COMMIT.new" "$KIT_COMMIT"
}
running_commit() {
  local c
  c="$(cat "$ROOT/current/SOURCE_COMMIT" 2>/dev/null || true)"
  if [[ "$c" =~ ^[0-9a-f]{40}$ ]]; then echo "$c"; fi
}

# Written just before `current` moves to a release the keeper must restart
# onto, and removed once that restart is queued. So a run that was stopped,
# timed out, or could not queue the restart after switching leaves it behind,
# and the next run finishes the job instead of seeing its release in place
# and stopping with the old bundle still running.
PENDING="$ROOT/restart-pending"
queue_restart() {
  systemctl try-restart --no-block vaipakam-keeper.service
  rm -f "$PENDING"
}

if [ "${1:-}" = --kit-only ]; then
  commit="$(running_commit)"
  commit="${commit:-${2:-}}"
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "--kit-only: no release and no commit given" >&2; exit 1; }
  kit_dir="$(extract_kit "$commit")"
  rm -f "$KIT_COMMIT"
  install_kit "$kit_dir"
  record_kit "$commit"
  # A running keeper is on its old unit until it restarts; install.sh's
  # restart check sees the changed unit and restarts it.
  exit 0
fi

# Put back the kit of the release in use, if an interrupted run left another
# one (or none) recorded. Until this runs, the keeper refuses to start.
running="$(running_commit)"
if [ -n "$running" ] && [ "$(cat "$KIT_COMMIT" 2>/dev/null || true)" != "$running" ]; then
  log "installing the units of $running, which is the release in use"
  kit_dir="$(extract_kit "$running")"
  rm -f "$KIT_COMMIT"
  install_kit "$kit_dir"
  record_kit "$running"
  if [ "$keeper_unit_changed" = yes ]; then touch "$PENDING"; fi
fi

# Finish a restart an earlier run left pending, before anything that can
# fail (the fetch, a build of a newer commit), so a failing newer build can
# never leave the keeper on a bundle older than `current`.
if [ -e "$PENDING" ]; then
  log "restarting the keeper onto $(readlink "$ROOT/current"), which an earlier run switched to but did not restart"
  queue_restart
fi

git -C "$REPO" fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
target="$(git -C "$REPO" rev-parse "origin/$BRANCH")"
release="$ROOT/releases/$target"
if [ "$(readlink -f "$ROOT/current" 2>/dev/null || true)" = "$release" ]; then
  exit 0
fi

log "building $BRANCH at $target"
tmp="$WORK/build"
mkdir -m 700 "$tmp"
git -C "$REPO" archive --format=tar -o "$tmp/src.tar" "$target"
chmod 644 "$tmp/src.tar"
# This commit's own kit: its build.sh builds it, and its units and updater go
# in with it below. Checked before the build, so a commit whose updater does
# not parse costs no build and changes nothing.
kit_dir="$(extract_kit "$target")"
build_script="$kit_dir/build.sh"
# The one directory the sandbox may write. `$tmp` itself stays 0700, so no
# other account on the machine can reach it; the sandbox sees only the
# bind-mounted paths below.
mkdir "$tmp/out"
chmod 777 "$tmp/out"
# `env -i`: the build sees only the variables named below, never anything
# the service manager would otherwise pass on (DefaultEnvironment=,
# set-environment), so a dependency's install script cannot find a secret
# that was left there.
# One fixed unit name: systemd refuses to start a second unit of the same
# name, so two builds can never run at once, even one orphaned by a stopped
# or timed-out updater. PartOf stops the build when the updater stops.
systemd-run --quiet --wait --pipe --collect \
  --unit=vaipakam-keeper-build \
  -p PartOf=vaipakam-keeper-update.service \
  -p DynamicUser=yes \
  -p BindReadOnlyPaths="$tmp/src.tar:/run/keeper-src.tar $build_script:/run/keeper-build.sh" \
  -p BindPaths="$tmp/out:/run/keeper-out" \
  -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes -p PrivateDevices=yes \
  -p NoNewPrivileges=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
  -p ProtectControlGroups=yes -p RestrictNamespaces=yes -p LockPersonality=yes \
  -p Nice=10 \
  /usr/bin/env -i \
  HOME=/tmp/home \
  COREPACK_HOME=/tmp/corepack \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  PATH=/usr/local/bin:/usr/bin:/bin \
  /bin/bash /run/keeper-build.sh /run/keeper-src.tar /run/keeper-out
built="$tmp/out/keeper-host.mjs"
# The sandbox wrote this file and is gone now. Take only a regular file, never
# a link, so the build cannot point root at something else to copy.
if [ -L "$built" ] || [ ! -f "$built" ]; then
  echo "[keeper-update] the build left no regular keeper-host.mjs" >&2
  exit 1
fi

incoming="$(mktemp -d "$ROOT/releases/.incoming.XXXXXX")"
install -m 644 -o root -g root "$built" "$incoming/keeper-host.mjs"
echo "$target" > "$incoming/SOURCE_COMMIT"
chmod 755 "$incoming"
restart=yes
if [ -f "$ROOT/current/keeper-host.mjs" ] && cmp -s "$incoming/keeper-host.mjs" "$ROOT/current/keeper-host.mjs"; then
  restart=no
fi

# This commit's kit goes in only now, after the build succeeded. From
# removing kit-commit until it names this commit again, the keeper refuses to
# start.
rm -f "$KIT_COMMIT"
install_kit "$kit_dir"
# The keeper's own unit changed: it must restart onto it even when its bundle
# did not.
if [ "$keeper_unit_changed" = yes ]; then restart=yes; fi
rm -rf "$release"
mv -T "$incoming" "$release"
incoming=""
if [ "$restart" = yes ]; then touch "$PENDING"; fi
ln -sfn "$release" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
record_kit "$target"
if [ "$restart" = yes ]; then
  log "deployed $target; a running keeper restarts onto it after its current tick"
  queue_restart
else
  log "deployed $target; the keeper is byte-identical to the running one, so no restart"
fi

# Keep the last few releases for a manual rollback, never the one in use.
# Release names are commit hashes, so `ls` is safe here.
in_use="$(readlink -f "$ROOT/current")"
# shellcheck disable=SC2012
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r dir; do
  dir="${dir%/}"
  [ "$dir" = "$in_use" ] || rm -rf "$dir"
done
