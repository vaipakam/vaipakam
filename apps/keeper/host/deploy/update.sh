#!/usr/bin/env bash
# Builds the keeper from the deploy branch and stages it, if it changed.
#
# Run by vaipakam-keeper-update.service (every five minutes, as the
# unprivileged build user). One run:
#
#   1. fetches the deploy branch (main unless install.sh was told otherwise);
#   2. if it has not moved since the last build, stops;
#   3. checks it out, installs the keeper's dependencies from the lockfile
#      and builds the single-file bundle;
#   4. runs the new bundle with --check, so a build that cannot even load
#      never replaces the one that is running;
#   5. if the bundle is byte-identical to the running one (a merge that did
#      not touch the keeper), records the commit and stops;
#   6. otherwise stages it as a new release, switches `current` to it in one
#      rename, and rewrites restart-request, which makes systemd restart the
#      keeper gracefully onto it.
#
# Any failure exits non-zero before `current` moves, so the running keeper is
# untouched and the next run retries. Comparing bundles rather than changed
# paths means there is no list of "keeper files" to keep in step.
set -euo pipefail

ROOT=/opt/vaipakam-keeper
REPO="$ROOT/repo"
BRANCH="$(cat "$ROOT/deploy-branch" 2>/dev/null || echo main)"
KEEP_RELEASES=5
NODE=/usr/local/bin/node

log() { echo "[keeper-update] $*"; }

cd "$REPO"
git fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
target="$(git rev-parse "origin/$BRANCH")"
built="$(cat "$ROOT/built-sha" 2>/dev/null || true)"
if [ "$target" = "$built" ]; then
  exit 0
fi

log "building $BRANCH at $target (last built: ${built:-none})"
git checkout --quiet --force --detach "$target"
git clean -fdxq -e node_modules
corepack pnpm install --frozen-lockfile --filter '@vaipakam/keeper...' >/dev/null
corepack pnpm --filter @vaipakam/keeper run build:host >/dev/null
bundle="$REPO/apps/keeper/dist/keeper-host.mjs"
"$NODE" "$bundle" --check

new_hash="$(sha256sum "$bundle" | cut -d' ' -f1)"
cur_hash=""
if [ -f "$ROOT/current/keeper-host.mjs" ]; then
  cur_hash="$(sha256sum "$ROOT/current/keeper-host.mjs" | cut -d' ' -f1)"
fi
if [ "$new_hash" = "$cur_hash" ]; then
  log "$target builds the keeper that is already staged; nothing to restart"
  echo "$target" > "$ROOT/built-sha"
  exit 0
fi

release="$ROOT/releases/$target"
mkdir -p "$release"
install -m 644 "$bundle" "$release/keeper-host.mjs"
echo "$target" > "$release/SOURCE_COMMIT"
ln -sfn "$release" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"
echo "$target" > "$ROOT/built-sha"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $target" > "$ROOT/restart-request"
log "staged $target; a running keeper restarts onto it after its current tick"

# Keep the last few releases for a manual rollback, never the one in use.
# Release names are commit hashes, so `ls` is safe here.
in_use="$(readlink -f "$ROOT/current")"
# shellcheck disable=SC2012
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r dir; do
  dir="${dir%/}"
  [ "$dir" = "$in_use" ] || rm -rf "$dir"
done
