#!/usr/bin/env bash
# Builds the keeper bundle from one source tarball. Runs ONLY inside the
# throwaway sandbox update.sh starts (systemd-run with DynamicUser=yes): a
# fresh, unprivileged user with no access to the keeper's env file or its
# releases, which systemd deletes when the build ends. Its only writable place
# is its cache directory, which holds the package store between builds.
#
#   build.sh <source tarball> <output file>
set -euo pipefail

src_tar="$1"
out="$2"
work="$CACHE_DIRECTORY/src"

rm -rf "$work" "$out"
mkdir -p "$work"
tar -xf "$src_tar" -C "$work"
cd "$work"
corepack pnpm install --frozen-lockfile --filter '@vaipakam/keeper...' >/dev/null
corepack pnpm --filter @vaipakam/keeper run build:host >/dev/null
/usr/local/bin/node apps/keeper/dist/keeper-host.mjs --check
install -m 644 apps/keeper/dist/keeper-host.mjs "$out"
