#!/usr/bin/env bash
# Builds the keeper from the deploy branch and stages it for promotion.
#
# Run by vaipakam-keeper-update.service every five minutes, as the
# unprivileged build user. It can write only its own home
# (/var/lib/vaipakam-build): the running releases under /opt/vaipakam-keeper
# are root's, so this account can never replace the code that runs with the
# signing key. One run:
#
#   1. fetches the deploy branch (main unless install.sh was told otherwise);
#   2. if it has not moved since the last build, stops;
#   3. checks it out, installs the keeper's dependencies from the lockfile
#      and builds the single-file bundle;
#   4. runs the new bundle with --check, so a build that cannot even load is
#      never offered for promotion;
#   5. if the bundle is byte-identical to the running one (a merge that did
#      not touch the keeper), records the commit and stops;
#   6. otherwise stages it and rewrites staging/ready, which makes root's
#      promote.sh (vaipakam-keeper-promote.path) take it.
#
# Any failure exits non-zero with nothing staged, so the running keeper is
# untouched and the next run retries. Comparing bundles rather than changed
# paths means there is no list of "keeper files" to keep in step.
set -euo pipefail

ROOT=/opt/vaipakam-keeper
HOME_DIR=/var/lib/vaipakam-build
REPO="$HOME_DIR/repo"
STAGING="$HOME_DIR/staging"
BRANCH="$(cat "$ROOT/deploy-branch" 2>/dev/null || echo main)"
NODE=/usr/local/bin/node

log() { echo "[keeper-update] $*"; }

cd "$REPO"
git fetch --quiet --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
target="$(git rev-parse "origin/$BRANCH")"
built="$(cat "$HOME_DIR/built-sha" 2>/dev/null || true)"
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
  log "$target builds the keeper that is already running; nothing to promote"
  echo "$target" > "$HOME_DIR/built-sha"
  exit 0
fi

mkdir -p "$STAGING"
install -m 644 "$bundle" "$STAGING/keeper-host.mjs.next"
mv -f "$STAGING/keeper-host.mjs.next" "$STAGING/keeper-host.mjs"
echo "$target" > "$STAGING/SOURCE_COMMIT"
echo "$target" > "$HOME_DIR/built-sha"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $target" > "$STAGING/ready"
log "staged $target for promotion"
