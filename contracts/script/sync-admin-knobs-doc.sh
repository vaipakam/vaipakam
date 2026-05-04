#!/usr/bin/env bash
#
# sync-admin-knobs-doc.sh — keep the in-app copy of the Admin
# Configurable Knobs runbook in sync with the canonical docs/ops/
# version.
#
# T-042 admin dashboard renders the same markdown content from inside
# the app (info-icons deep-link to per-knob anchor IDs), so the
# canonical source of truth at `docs/ops/AdminConfigurableKnobsAndSwitches.md`
# is mirrored to `frontend/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md`
# at build time. English-only on purpose — the runbook is technical
# auditor-facing copy that translation drift would harm more than it
# would help (same policy as the Whitepaper).
#
# Usage:
#   bash contracts/script/sync-admin-knobs-doc.sh
#
# Workflow:
#   1. Edit the canonical at docs/ops/AdminConfigurableKnobsAndSwitches.md
#   2. Run this script to mirror the change into the frontend bundle
#   3. Commit both files together
#
# The frontend's vite build also picks up the change on hot-reload
# during dev because the file lives under `src/content/`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/docs/ops/AdminConfigurableKnobsAndSwitches.md"
DST="$REPO_ROOT/frontend/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md"

if [ ! -f "$SRC" ]; then
  echo "Error: canonical doc not found at $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"

echo "Synced: $SRC → $DST"
echo "Bytes:  $(wc -c < "$DST")"
echo
echo "Reminder: commit both files together so the frontend bundle"
echo "matches the canonical reference."
