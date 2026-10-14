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
# run queues the restart. The only state is `current` itself, so
# there is no record of "already built" to fall out of step with it.
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
tmp="$(mktemp -d)"
incoming=""
# A run that fails part-way leaves neither its scratch nor a half-written
# release behind (the glob that prunes releases skips dot-directories).
trap 'rm -rf "$tmp" ${incoming:+"$incoming"}' EXIT
git -C "$REPO" archive --format=tar -o "$tmp/src.tar" "$target"
chmod 644 "$tmp/src.tar"
# This commit's own deploy kit: its build.sh builds it, and its units and
# scripts are installed with it below.
mkdir "$tmp/kit"
git -C "$REPO" archive "$target" apps/keeper/host/deploy | tar -x --no-same-owner -C "$tmp/kit"
kit="$tmp/kit/apps/keeper/host/deploy"
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
  -p BindReadOnlyPaths="$tmp/src.tar:/run/keeper-src.tar $kit/build.sh:/run/keeper-build.sh" \
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

# Install this commit's kit, last before the switch so a failed build changes
# nothing. Each file is replaced only when its content changed (a unit's mtime
# is what install.sh's restart check reads), and by rename, so the copy of
# this script bash is running stays intact.
place() { # place <source> <destination> <mode>
  if ! cmp -s "$1" "$2"; then
    install -m "$3" -o root -g root "$1" "$2.new"
    mv -Tf "$2.new" "$2"
    return 0
  fi
  return 1
}
units_changed=no
for unit in vaipakam-keeper.service vaipakam-keeper-update.service vaipakam-keeper-update.timer; do
  if place "$kit/$unit" "/etc/systemd/system/$unit" 644; then
    units_changed=yes
    # The keeper's own unit changed: it must restart onto it even when its
    # bundle did not.
    if [ "$unit" = vaipakam-keeper.service ]; then restart=yes; fi
  fi
done
if [ "$units_changed" = yes ]; then systemctl daemon-reload; fi
place "$kit/update.sh" "$ROOT/update.sh" 755 || true
rm -rf "$release"
mv -T "$incoming" "$release"
incoming=""
if [ "$restart" = yes ]; then touch "$PENDING"; fi
ln -sfn "$release" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
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
