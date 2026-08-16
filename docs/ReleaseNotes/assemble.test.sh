#!/usr/bin/env bash
#
# assemble.test.sh — behaviour tests for `assemble.sh`.
#
# `assemble.sh` decides which pending fragments belong to the day being
# assembled, and gets that decision from git history. Both halves are easy to
# break silently: a wrong answer produces a plausible-looking release-notes
# file, not an error. So the cases live here rather than in a reviewer's head.
#
# Each case builds a THROWAWAY git repo with fragments committed at chosen UTC
# timestamps, copies the real `assemble.sh` into it, and drives it there. The
# repository this script lives in is never modified.
#
# Usage:
#   bash docs/ReleaseNotes/assemble.test.sh
#
# Exits non-zero if any case fails, so it can be wired into CI.

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/assemble.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

FAILED=0
ok()   { echo "  ok   — $1"; }
fail() { echo "  FAIL — $1" >&2; FAILED=1; }
check() {  # check <condition-description> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (got '$2', want '$3')"; fi
}

# Build a repo with two fragments on two different UTC days:
#   0001-a.md — 2026-08-16 23:00 UTC, which reads as 2026-08-17 at +05:30
#               (exactly the window that misfiled fragments on #1769 and #1783)
#   0002-b.md — 2026-08-17 10:00 UTC
build() {
  local d="$1"
  mkdir -p "$d/docs/ReleaseNotes/unreleased"
  cp "$SRC" "$d/docs/ReleaseNotes/assemble.sh"
  printf '# unreleased\n' > "$d/docs/ReleaseNotes/unreleased/README.md"
  printf '## template\n'  > "$d/docs/ReleaseNotes/unreleased/_TEMPLATE.md"
  git -C "$d" init -q
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name test
  git -C "$d" add -A
  GIT_AUTHOR_DATE='2026-08-14T00:00:00Z' GIT_COMMITTER_DATE='2026-08-14T00:00:00Z' \
    git -C "$d" commit -q -m base
  _frag "$d" 0001-a '2026-08-16T23:00:00Z'
  _frag "$d" 0002-b '2026-08-17T10:00:00Z'
}
_frag() {  # _frag <dir> <stem> <iso-utc>
  printf '## %s\n' "$2" > "$1/docs/ReleaseNotes/unreleased/$2.md"
  git -C "$1" add -A
  GIT_AUTHOR_DATE="$3" GIT_COMMITTER_DATE="$3" git -C "$1" commit -q -m "$2"
}

pending() {  # pending <dir> -> count of pending fragments
  find "$1/docs/ReleaseNotes/unreleased" -name '*.md' \
    ! -name README.md ! -name _TEMPLATE.md | wc -l | tr -d ' '
}
sections() {  # sections <file> -> count of `## ` headings, 0 if absent
  if [ -f "$1" ]; then grep -c '^## ' "$1" || true; else echo 0; fi
}
says() {  # says <text> <needle> -> 1 if present, 0 if not
  if printf '%s' "$1" | grep -q "$2"; then echo 1; else echo 0; fi
}

# ── A mixed backlog must be assemblable one day at a time ────────────────────
# The whole point of dating fragments is to handle a backlog spanning days. A
# guard that REFUSED whenever two days were pending would make that backlog
# unassemblable — every date's run would see the other day's files and fail.
echo "T1: mixed backlog assembles one day at a time"
W="$ROOT/t1"; build "$W"
out="$W/docs/ReleaseNotes"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "08-16 run succeeds"            "$?"                              "0"
check "08-16 file has just its own"   "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the other day is left pending" "$(pending "$W")"                 "1"
check "it names what it held back"    "$(says "$msg" '0002-b.md')"      "1"
check "and the day to run for it"     "$(says "$msg" '2026-08-17 UTC')" "1"
bash "$out/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "08-17 run succeeds"            "$?"                              "0"
check "08-17 file has just its own"   "$(sections "$out/ReleaseNotes-2026-08-17.md")" "1"
check "nothing left pending"          "$(pending "$W")"                 "0"

# ── A day with nothing of its own must not produce an empty file ─────────────
echo "T2: a date with no fragments of its own is refused"
W="$ROOT/t2"; build "$W"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-15 >/dev/null 2>&1
check "refused"              "$?"                                                    "1"
check "no dated file made"   "$([ -f "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-15.md" ] && echo yes || echo no)" "no"
check "nothing consumed"     "$(pending "$W")"                                       "2"

# ── The deliberate-fold escape hatch ─────────────────────────────────────────
echo "T3: --allow-mixed-dates folds every pending day together"
W="$ROOT/t3"; build "$W"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "succeeds"            "$?"                                                             "0"
check "both days folded in" "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")"  "2"
check "nothing left"        "$(pending "$W")"                                                "0"

# ── Shallow history reports a fabricated add date ────────────────────────────
# A fragment older than the shallow boundary is attributed to the boundary
# commit — a date that looks ordinary and is simply wrong. Refuse rather than
# select on it.
echo "T4: a shallow repository is refused"
build "$ROOT/t4src"
git -C "$ROOT/t4src" branch -M main
git clone -q --depth 1 "file://$ROOT/t4src" "$ROOT/t4" 2>/dev/null
check "clone really is shallow" "$(git -C "$ROOT/t4" rev-parse --is-shallow-repository)" "true"
bash "$ROOT/t4/docs/ReleaseNotes/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "refused"          "$?"                 "1"
check "nothing consumed" "$(pending "$ROOT/t4")" "2"
bash "$ROOT/t4/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "override still works in a shallow clone" "$?" "0"

# ── A fragment written by the assembling PR has no day of its own ────────────
echo "T5: an untracked fragment is taken, not held back"
W="$ROOT/t5"; build "$W"
printf '## c\n' > "$W/docs/ReleaseNotes/unreleased/0003-c.md"   # never committed
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "succeeds"                       "$?"                                                            "0"
check "own-day fragment + untracked"   "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "2"
check "other day still held"           "$(pending "$W")"                                               "1"

# ── No git at all (export / tarball) degrades, it does not lie ───────────────
echo "T6: a non-git tree assembles everything and says so"
W="$ROOT/t6"; build "$W"; rm -rf "$W/.git"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "succeeds"        "$?"                                                            "0"
check "warns it cannot date" "$(says "$msg" 'not a git work tree')" "1"
check "everything folded"    "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")"    "2"

# ── Argument handling ────────────────────────────────────────────────────────
echo "T7: argument handling"
W="$ROOT/t7"; build "$W"
S="$W/docs/ReleaseNotes/assemble.sh"
bash "$S" --nope              >/dev/null 2>&1; check "unknown option refused" "$?" "1"
bash "$S" 2026-08-16 2026-08-17 >/dev/null 2>&1; check "two dates refused"   "$?" "1"
bash "$S" 20260816            >/dev/null 2>&1; check "bad date format refused" "$?" "1"
bash -n "$SRC"                >/dev/null 2>&1; check "assemble.sh parses"    "$?" "0"

echo ""
if (( FAILED )); then echo "assemble.test.sh: FAILURES above ^^^" >&2; exit 1; fi
echo "assemble.test.sh: all cases pass"
