#!/usr/bin/env bash
# Promotes the staged keeper build into the root-owned release area and
# moves the running keeper onto it.
#
# Run as root by vaipakam-keeper-promote.service when update.sh rewrites
# /var/lib/vaipakam-build/staging/ready, and by hand to return to the latest
# build after a rollback (docs/ops/KeeperMachine.md §6). The build user can
# offer a bundle but cannot install one: this script copies it into
# /opt/vaipakam-keeper/releases/<commit>, which only root can write, and only
# when the commit it claims is the deploy branch's current tip on GitHub. That
# keeps a stale or made-up commit from being promoted at an arbitrary time. It
# cannot prove the bundle is that commit's build: whoever can change the build
# (or merge to main) controls what runs, as with the Workers' auto-deploy.
#
# The restart is queued (--no-block) and graceful: the tick in flight
# finishes first. try-restart leaves a keeper an operator stopped stopped.
set -euo pipefail

ROOT=/opt/vaipakam-keeper
STAGING=/var/lib/vaipakam-build/staging
REPO_URL="https://github.com/vaipakam/vaipakam.git"
BRANCH="$(cat "$ROOT/deploy-branch" 2>/dev/null || echo main)"
KEEP_RELEASES=5

log() { echo "[keeper-promote] $*"; }

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
# One promotion at a time (the path unit and a manual run can coincide).
exec 9>"$ROOT/.promote.lock"
flock 9
if [ ! -f "$STAGING/keeper-host.mjs" ] || [ ! -f "$STAGING/SOURCE_COMMIT" ]; then
  log "nothing staged"
  exit 0
fi
commit="$(tr -d '[:space:]' < "$STAGING/SOURCE_COMMIT")"
if ! [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then
  log "refusing: staged commit is not a commit hash"
  exit 1
fi
tip="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | cut -f1)"
if [ "$commit" != "$tip" ]; then
  log "not promoting $commit: $BRANCH is now at ${tip:-unknown}; the next build stages it"
  exit 0
fi

release="$ROOT/releases/$commit"
tmp="$(mktemp -d "$ROOT/releases/.incoming.XXXXXX")"
install -m 644 -o root -g root "$STAGING/keeper-host.mjs" "$tmp/keeper-host.mjs"
echo "$commit" > "$tmp/SOURCE_COMMIT"
chmod 755 "$tmp"
if [ -f "$ROOT/current/keeper-host.mjs" ] && cmp -s "$tmp/keeper-host.mjs" "$ROOT/current/keeper-host.mjs"; then
  rm -rf "$tmp"
  log "$commit is the keeper already running; nothing to do"
  exit 0
fi
rm -rf "$release"
mv -T "$tmp" "$release"
ln -sfn "$release" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
log "promoted $commit"
systemctl try-restart --no-block vaipakam-keeper.service

# Keep the last few releases for a manual rollback, never the one in use.
# Release names are commit hashes, so `ls` is safe here.
in_use="$(readlink -f "$ROOT/current")"
# shellcheck disable=SC2012
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r dir; do
  dir="${dir%/}"
  [ "$dir" = "$in_use" ] || rm -rf "$dir"
done
