#!/usr/bin/env bash
# Builds the keeper bundle from one source tarball. Runs ONLY inside the
# throwaway sandbox update.sh starts (systemd-run with DynamicUser=yes): a
# fresh, unprivileged user with no access to the keeper's env file or its
# releases, which systemd deletes when the build ends.
#
# Nothing it writes outlives the build. The source tree, HOME, Corepack's
# copy of pnpm and pnpm's package store all live in the unit's private /tmp,
# which systemd removes with the unit. So no build can leave tooling or a
# package behind for a later build to run: each one starts from the lockfile
# and downloads what it needs, checked against the lockfile's hashes (and
# pnpm against npm's signing keys, by Corepack). The only thing that leaves
# is the bundle and its list of inputs, written to the one directory
# update.sh bound in for them.
#
#   build.sh <source tarball> <output directory>
set -euo pipefail

src_tar="$1"
out_dir="$2"
work=/tmp/src

mkdir -p "$work" "$HOME"
tar -xf "$src_tar" -C "$work"
cd "$work"
corepack pnpm install --frozen-lockfile --filter '@vaipakam/keeper...' >/dev/null
corepack pnpm --filter @vaipakam/keeper run build:host >/dev/null
/usr/local/bin/node apps/keeper/dist/keeper-host.mjs --check
# The files the bundle was made from (build-inputs.mjs), so the updater can
# tell which later commits cannot change it. Recorded before the bundle is
# handed over: a build that cannot say what it read is not installed.
/usr/local/bin/node apps/keeper/host/deploy/build-inputs.mjs record \
  apps/keeper/dist/keeper-host.meta.json apps/keeper > "$out_dir/INPUTS"
install -m 644 apps/keeper/dist/keeper-host.mjs "$out_dir/keeper-host.mjs"
