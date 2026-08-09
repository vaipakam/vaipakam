#!/usr/bin/env bash
#
# sync-admin-knobs-doc.sh — keep the in-app copy of the Admin
# Configurable Knobs runbook in sync with the canonical docs/ops/
# version.
#
# The `/protocol-console/docs` route lives on the marketing apex
# (`apps/www`) — the connected-app surface (`apps/defi`) keeps only
# the interactive `/protocol-console` dashboard whose info-icons
# deep-link cross-domain to the prose docs via the `marketingUrl()`
# helper. So the canonical source of truth at
# `docs/ops/AdminConfigurableKnobsAndSwitches.md` is mirrored into
# `apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md`
# (NOT apps/defi any more). English-only on purpose — the runbook is
# technical auditor-facing copy that translation drift would harm more
# than it would help (same policy as the Whitepaper).
#
# Usage:
#   bash contracts/script/sync-admin-knobs-doc.sh
#
# Workflow:
#   1. Edit the canonical at docs/ops/AdminConfigurableKnobsAndSwitches.md
#   2. Run this script to mirror the change into the marketing-site bundle
#   3. Commit both files together
#
# The www app's vite build picks up the change on hot-reload during
# dev because the file lives under `apps/www/src/content/`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/docs/ops/AdminConfigurableKnobsAndSwitches.md"
DST="$REPO_ROOT/apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md"

if [ ! -f "$SRC" ]; then
  echo "Error: canonical doc not found at $SRC" >&2
  exit 1
fi

# Stop BEFORE copying, not after. The first revision of this warning
# sat below the `cp` — it told the operator their mirror-only edits had
# been discarded, one line after discarding them (#1624 review r1).
#
# The discriminator is NOT "the two files differ" — after you edit the
# canonical they always do, and that is the whole point of running this.
# The dangerous case is narrower: the MIRROR has been hand-edited, so
# copying would destroy work that exists nowhere else. Git can tell the
# two apart, because a hand-edited mirror is dirty against HEAD while a
# mirror merely awaiting a sync is not.
# BOTH comparisons are needed. A bare `git diff` compares the worktree
# against the INDEX, so an edit that has been `git add`-ed looks clean —
# the `cp` would then overwrite the worktree while the divergent bytes
# sat staged, and a plain `git commit` would commit them with the script
# reporting success (#1624 review r2). `--cached` catches that half.
MIRROR_DIRTY=0
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  if ! git -C "$REPO_ROOT" diff --quiet -- "$DST" 2>/dev/null \
    || ! git -C "$REPO_ROOT" diff --cached --quiet -- "$DST" 2>/dev/null; then
    MIRROR_DIRTY=1
  fi
fi

if [ "$MIRROR_DIRTY" = "1" ]; then
  {
    echo "REFUSING TO SYNC — the mirror has uncommitted local edits."
    echo
    echo "  canonical: $SRC"
    echo "  mirror:    $DST"
    echo
    echo "What is currently in the mirror and nowhere else:"
    # `|| true` because `head` closing the pipe SIGPIPEs git, and under
    # `set -o pipefail` that aborts the script before it can print the
    # advice below — leaving the operator with a truncated refusal and
    # exit 141. Caught by testing the refusal path rather than reading it.
    { git -C "$REPO_ROOT" diff -- "$DST" | head -40; } || true
    { git -C "$REPO_ROOT" diff --cached -- "$DST" | head -40; } || true
    echo
    echo "Copying now would DISCARD whatever the mirror holds. That is how"
    echo "these two swapped roles in the first place: edits landed on the"
    echo "generated copy, went unnoticed for months, and a routine sync"
    echo "would have reverted an excised legal surface back onto a"
    echo "published page (#1624)."
    echo
    echo "Decide which side is right:"
    echo "  canonical is right → SYNC_FORCE=1 bash contracts/script/sync-admin-knobs-doc.sh"
    echo "  mirror is right    → port the change into the canonical first"
  } >&2
  if [ "${SYNC_FORCE:-}" != "1" ]; then
    exit 1
  fi
  echo >&2
  echo "SYNC_FORCE=1 set — overwriting the mirror." >&2
fi

mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"

echo "Synced: $SRC → $DST"
echo "Bytes:  $(wc -c < "$DST")"
echo
echo "Reminder: commit both files together so the marketing-site"
echo "bundle matches the canonical reference. CI enforces it —"
echo "\`pnpm --filter @vaipakam/www check:admin-mirror\`."
