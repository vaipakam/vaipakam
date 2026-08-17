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
# A fragment belongs to the UTC day its PR merged, and only the fragments
# belonging to the requested day are folded in; the rest are named and left
# for their own run. See "UTC-day selection" below for why.
#
# Usage:
#   bash docs/ReleaseNotes/assemble.sh                     # today (UTC)
#   bash docs/ReleaseNotes/assemble.sh 2026-05-20          # explicit date
#   bash docs/ReleaseNotes/assemble.sh --allow-mixed-dates # take every pending
#                                                          # fragment, any day
#
# The dated file is created with a header if absent, or appended to if
# it already exists. Review the result, add an intro paragraph by hand,
# then `git add -A docs/ReleaseNotes/` and commit.

set -euo pipefail

# `pwd -P`, not `pwd`. Every path comparison below is against
# `git rev-parse --show-toplevel`, which is always PHYSICAL. A logical `pwd`
# through a symlinked checkout returns the symlink path instead, the repo-root
# prefix then fails to strip, and every fragment's `HEAD:<rel>` lookup misses —
# so each one reads as newly written and the whole selection pass silently
# becomes a no-op. Not an edge case when it happens: it disables the guard
# entirely, for every fragment, while looking like an ordinary successful run.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UNREL="$DIR/unreleased"

DATE=""
ALLOW_MIXED=0
for a in "$@"; do
  case "$a" in
    --allow-mixed-dates) ALLOW_MIXED=1 ;;
    -*)
      echo "Error: unknown option '$a'" >&2
      exit 1
      ;;
    *)
      if [ -n "$DATE" ]; then
        echo "Error: more than one date given ('$DATE' and '$a')" >&2
        exit 1
      fi
      DATE="$a"
      ;;
  esac
done
DATE="${DATE:-$(date -u +%Y-%m-%d)}"

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
#
# `mapfile`, not `frags=($(...))`. An unquoted command substitution is both
# word-split AND pathname-expanded, and `nullglob` is on a few lines above — so
# a fragment whose name contains a glob metacharacter expands to nothing and
# VANISHES from the list. It is then neither assembled nor removed, while the
# run still reports success and a count that silently excludes it. `mapfile`
# does neither expansion.
mapfile -t frags < <(printf '%s\n' "${frags[@]}" | sort)

# ── UTC-day selection ────────────────────────────────────────────────────────
# A fragment belongs to the day its PR merged, measured in UTC — the same clock
# `date -u` above uses to pick the default. But the operator reads merge dates
# in local time, and for `+05:30` every merge between 18:30 and 24:00 UTC shows
# a local date one day AHEAD. Assemble on the local day and those fragments get
# folded into a file dated a day after the day they actually shipped.
#
# That gap has produced the same misfiling twice — once caught in review
# (#1769), once caught by hand on the next assembly (#1783). Both times the
# tooling was silent: assembly took whatever was pending and asked no questions.
# So ask here. Each fragment's own add-commit carries the answer, and comparing
# it to the target date costs one `git log` per file.
#
# SELECT, don't refuse. Refusing the whole run whenever two days are pending
# would make a mixed backlog unassemblable: every date's run sees the other
# day's files and fails, so neither day can be produced without moving files by
# hand — and a mixed backlog is precisely the case this exists to handle. So a
# run takes the fragments belonging to ITS day, says which ones it held back and
# for when, and leaves those in place for their own run.
#
# A fragment with NO add-commit is taken, not held back: it is untracked, which
# means it was written in the PR doing the assembling, so it has no day of its
# own yet and belongs to the run creating it.
if (( ALLOW_MIXED )); then
  : # take every pending fragment, whatever day it came from
elif ! git -C "$DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # No git — an export or tarball. Dating is impossible, so say the guard is
  # off rather than let it look like it ran and found nothing.
  echo "note: not a git work tree — cannot date fragments, assembling all pending." >&2
else
  # A shallow repository does NOT get a blanket refusal, though an earlier
  # revision gave it one. The refusal was correct about the danger and wrong
  # about its reach: only a fragment whose add-commit falls AT the shallow
  # boundary has a fabricated date — one added after the boundary has a genuine
  # add-commit and reads correctly. Refusing every shallow clone made the tool
  # unusable in the environment it actually runs in (this repository's own
  # checkout is shallow), and the only escape offered was --allow-mixed-dates,
  # which turns the dating off entirely. A guard whose realistic outcome is
  # "operator reaches for the override every time" protects nothing.
  #
  # So load the boundary commits instead and check each fragment against them.
  # `git rev-parse --git-common-dir`, not --git-dir: in a linked worktree the
  # shallow file lives in the common dir.
  git_root="$(git -C "$DIR" rev-parse --show-toplevel)"

  declare -A SHALLOW_BOUNDARY=()
  if [ "$(git -C "$DIR" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
    # `--git-common-dir` answers RELATIVE TO THE DIRECTORY GIT RAN IN, which is
    # `$DIR`, not the repo root — resolving it against the root instead walks
    # out of the repository and the file is simply never found, leaving the
    # boundary set empty and this whole check silently inert. Resolve it where
    # git actually meant it, and make it absolute and physical while here.
    common_dir="$(cd "$DIR" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
    if [ -r "$common_dir/shallow" ]; then
      while IFS= read -r boundary_sha; do
        [ -n "$boundary_sha" ] && SHALLOW_BOUNDARY["$boundary_sha"]=1
      done < "$common_dir/shallow"
    fi
  fi

  # An UNCOMMITTED rename defeats `--follow`: no commit connects the new name to
  # the old one, so the history query comes back empty and the fragment reads as
  # newly written — assembled under whatever day was asked, then deleted. The
  # index knows better, and `git status -M` will say so (`R old -> new`), so ask
  # it once up front and date the old name instead.
  #
  # Scope: a rename staged in the INDEX. A rename made with plain `mv` and left
  # unstaged is NOT recoverable — git reports it as an unrelated deletion plus an
  # untracked file (` D old.md` / `?? new.md`) because rename detection needs the
  # index — and is genuinely indistinguishable from having deleted one fragment
  # and written another. `git mv`, or staging the rename, is what makes it
  # knowable.
  #
  # `-z` rather than parsing quoted paths: a rename record is the status byte
  # pair, then the NEW path, then the OLD path, each NUL-terminated.
  declare -A RENAMED_FROM=()
  staged_adds=()
  staged_dels=()
  while IFS= read -r -d '' entry; do
    xy="${entry:0:2}"
    newpath="${entry:3}"
    if [ "${xy:0:1}" = "R" ] || [ "${xy:1:1}" = "R" ]; then
      IFS= read -r -d '' oldpath || break
      RENAMED_FROM["$git_root/$newpath"]="$git_root/$oldpath"
    elif [ "${xy:0:1}" = "A" ]; then
      staged_adds+=("$(basename "$newpath")")
    elif [ "${xy:0:1}" = "D" ]; then
      staged_dels+=("$(basename "$newpath")")
    fi
  done < <(git -C "$DIR" status --porcelain=v1 -z -M -- "$UNREL")

  # `-M` is rename DETECTION, by similarity index — not a record of what the
  # operator did. `git mv` followed by a substantial rewrite before staging
  # drops below the threshold, and git then reports a plain add and a plain
  # delete with nothing linking them. The rename map is empty, the new path has
  # no history, and the fragment reads as newly written.
  #
  # That state is genuinely ambiguous: a heavily-rewritten rename and a
  # deliberate "drop that fragment, write this one" are the same two records.
  # Guessing either way would be wrong half the time, so say what was seen and
  # let the operator decide — the alternative is a silent misfiling, which is
  # the failure this whole selection pass exists to prevent.
  if (( ${#staged_adds[@]} > 0 && ${#staged_dels[@]} > 0 )); then
    echo "note: the index holds both a staged new fragment and a staged deletion:"
    echo "        added:   ${staged_adds[*]}"
    echo "        deleted: ${staged_dels[*]}"
    echo "      If that was one fragment renamed and rewritten, git could not pair"
    echo "      the two (rename detection is by similarity), so the new name will be"
    echo "      dated to THIS run rather than to when it was written. Commit the"
    echo "      rename first if that matters."
    echo ""
  fi

  selected=()
  held=()
  for f in "${frags[@]}"; do
    # `--follow` because a rename is otherwise indistinguishable from an add:
    # path-limited history starts at the new name, so renaming a fragment re-
    # dates it to the rename. The routine trigger is renaming a fragment to
    # match its PR number once the number is known, which is often the next day
    # — this script's own fragment was renamed that way, though within the same
    # UTC day, so it read correctly either way.
    #
    # The status is captured rather than swallowed. `git log` exits 0 with EMPTY
    # output for a path it has no history for, which is how an uncommitted
    # fragment is recognised — so a NON-zero exit means something else entirely
    # (unreadable or partial history), and `|| true` would launder that into
    # "uncommitted", select the fragment for whatever date was asked, and then
    # DELETE it after misfiling it. stderr is deliberately not redirected, so
    # git's own diagnosis reaches the operator.
    #
    # The query runs against the pre-rename path when the index reports one, so
    # a staged rename dates from where the fragment was actually written.
    #
    # It runs at all ONLY for a path the current commit actually has. Fragment
    # names are reused — `<TASK-ID>-<slug>.md` recurs — and history is keyed by
    # PATH, not by content: a name that was used, assembled and deleted months
    # ago still has an add-commit. Asking about a brand-new file that happens to
    # reuse that name returns the OLD file's date, which held the new fragment
    # back for a day it has nothing to do with. Existing in HEAD is what
    # separates "this fragment was committed and has a day" from "this name was
    # committed once, by someone else's fragment".
    probe=""
    rel="${f#"$git_root"/}"
    if [ -n "${RENAMED_FROM[$f]:-}" ]; then
      probe="${RENAMED_FROM[$f]}"
    elif git -C "$DIR" cat-file -e "HEAD:$rel" 2>/dev/null; then
      probe="$f"
    fi

    status=0
    added=""
    added_sha=""
    if [ -n "$probe" ]; then
      raw="$(TZ=UTC git -C "$DIR" log --follow --diff-filter=A \
        --format='%H %cd' --date=format-local:'%Y-%m-%d' -1 -- "$probe")" || status=$?
      added_sha="${raw%% *}"
      added="${raw#* }"
      [ "$added" = "$raw" ] && added=""   # empty result: no add-commit at all
    fi
    if (( status != 0 )); then
      echo "" >&2
      echo "Error: cannot read git history for $(basename "$f") (git exited $status)." >&2
      echo "Fragment dates are unavailable, and assembling would consume the" >&2
      echo "fragment under a date nothing verified. Repair the repository, or" >&2
      echo "pass --allow-mixed-dates to assemble without dating." >&2
      exit 1
    fi
    # An add-commit that IS a shallow boundary is not this fragment's commit —
    # it is where the truncated history stops, wearing an ordinary-looking date.
    if [ -n "$added_sha" ] && [ -n "${SHALLOW_BOUNDARY[$added_sha]:-}" ]; then
      echo "" >&2
      echo "Error: $(basename "$f") dates to the shallow boundary, not to its own" >&2
      echo "add-commit — the history that would answer was truncated away, and" >&2
      echo "$added is the boundary's date rather than this fragment's." >&2
      echo "" >&2
      echo "Run 'git fetch --unshallow' (or clone at full depth) and retry, or" >&2
      echo "pass --allow-mixed-dates to assemble without dating." >&2
      exit 1
    fi
    if [ -z "$added" ] || [ "$added" = "$DATE" ]; then
      selected+=("$f")
    else
      held+=("$(basename "$f")  ($added UTC)")
    fi
  done
  if (( ${#held[@]} > 0 )); then
    echo "Holding back ${#held[@]} fragment(s) that belong to another UTC day:"
    printf '  %s\n' "${held[@]}"
    echo "Run this script again with each of those dates to assemble them."
    echo ""
  fi
  if (( ${#selected[@]} == 0 )); then
    echo "Error: no pending fragment belongs to $DATE — nothing to assemble." >&2
    echo "Re-run with one of the dates listed above." >&2
    exit 1
  fi
  frags=("${selected[@]}")
fi

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
