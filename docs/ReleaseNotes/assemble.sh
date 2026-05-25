#!/usr/bin/env bash
#
# assemble.sh — fold pending release-note fragments into a dated file.
#
# Every behaviour-changing PR drops a fragment into
# `docs/ReleaseNotes/unreleased/` (see that directory's README). This
# script concatenates the pending fragments into
# `docs/ReleaseNotes/ReleaseNotes-<date>.md` and removes them, so the
# release-notes update is mechanical rather than remembered.
#
# Usage:
#   bash docs/ReleaseNotes/assemble.sh              # today (UTC)
#   bash docs/ReleaseNotes/assemble.sh 2026-05-20   # explicit date
#
# The dated file is created with a header if absent, or appended to if
# it already exists. Review the result, add an intro paragraph by hand,
# then `git add -A docs/ReleaseNotes/` and commit.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNREL="$DIR/unreleased"
DATE="${1:-$(date -u +%Y-%m-%d)}"

if ! printf '%s' "$DATE" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
  echo "Error: date must be YYYY-MM-DD (got '$DATE')" >&2
  exit 1
fi

OUT="$DIR/ReleaseNotes-$DATE.md"

# Collect pending fragments — every *.md except the README + template.
shopt -s nullglob
frags=()
for f in "$UNREL"/*.md; do
  case "$(basename "$f")" in
    README.md | _TEMPLATE.md) continue ;;
  esac
  frags+=("$f")
done

if [ "${#frags[@]}" -eq 0 ]; then
  echo "No pending fragments in $UNREL — nothing to assemble."
  exit 0
fi

# Deterministic order — task-id-prefixed filenames sort sensibly.
IFS=$'\n' frags=($(printf '%s\n' "${frags[@]}" | sort)); unset IFS

if [ ! -f "$OUT" ]; then
  printf '# Release Notes — %s\n' "$DATE" > "$OUT"
fi

for f in "${frags[@]}"; do
  printf '\n' >> "$OUT"
  # Rewrite relative link paths from fragment-perspective
  # (docs/ReleaseNotes/unreleased/) to assembled-file-perspective
  # (docs/ReleaseNotes/) — one directory level shallower. Two
  # targeted rewrites only; links that are ALREADY correct from the
  # assembled file's perspective are left untouched:
  #   ](../../X) -> ](../X)       fragment-perspective deep path
  #                               collapses one level
  #   ](./X)     -> ](../X)       ./ meant fragment's own dir;
  #                               doesn't survive assembly, so
  #                               promote up to docs/ at least
  # NOT rewritten:
  #   ](../X)    stays            already correct from
  #                               docs/ReleaseNotes/<date>.md
  #   ](X)       stays            already in same dir as assembled
  sed -E '
    s|\]\(\.\./\.\./|](\.\./|g
    s|\]\(\./|](\.\./|g
  ' "$f" >> "$OUT"
  # Ensure a trailing newline between fragments.
  [ -z "$(tail -c1 "$f")" ] || printf '\n' >> "$OUT"
done

for f in "${frags[@]}"; do
  rm "$f"
done

echo "Assembled ${#frags[@]} fragment(s) -> $OUT"
echo ""
echo "Next:"
echo "  - review $OUT and add an intro paragraph"
echo "  - git add -A docs/ReleaseNotes/"
echo "  - git commit -m 'docs: release notes $DATE'"
