#!/usr/bin/env bash
# Builds the keeper's machine bundle from one source tarball. Run by CI
# (.github/workflows/keeper-host-release.yml), never on the keeper machine,
# which downloads the result and verifies its attestation instead (#2651).
#
# The tarball is the export build-source.sh makes of one commit: the paths
# build-paths lists, and nothing else. So the bundle depends only on what
# that export holds, and two commits with the same build-source digest are
# given the same bundle. CI runs this with `env -i` and only the variables
# it names, so a dependency's install script finds no credential in the
# environment, and starts from the lockfile every time: no package store or
# cache survives from one build to the next. Packages are checked against
# the lockfile's integrity hashes, and pnpm against npm's signing keys by
# Corepack. The build runs the new bundle with --check, so a bundle that
# cannot even load is never published.
#
#   build.sh <source tarball> <output directory>
set -euo pipefail

src_tar="$1"
out_dir="$2"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$HOME"
tar -xf "$src_tar" -C "$work"
cd "$work"
corepack pnpm install --frozen-lockfile --filter '@vaipakam/keeper...'
corepack pnpm --filter @vaipakam/keeper run build:host
node apps/keeper/dist/keeper-host.mjs --check
install -m 644 apps/keeper/dist/keeper-host.mjs "$out_dir/keeper-host.mjs"
