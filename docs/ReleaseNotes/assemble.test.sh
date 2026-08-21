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
  # Refuse to reuse a directory. Two cases sharing one has already produced a
  # wrong result twice while this suite was being written: the second `build`
  # layers fresh fragments on top of whatever the first case left behind, and
  # the assertions then measure a state no case intended. Loud beats subtle.
  if [ -e "$d" ]; then
    echo "  FAIL — test bug: build() called twice on $d" >&2
    FAILED=1
    return 1
  fi
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
  # -F and -- deliberately: a needle beginning with a dash (`--force-append`)
  # is otherwise read as a grep OPTION, and the case fails with a usage error
  # that looks like a product defect.
  if printf '%s' "$1" | grep -qF -- "$2"; then echo 1; else echo 0; fi
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

# ── Shallow history: refuse only the fragments it actually fabricates ───────
# A fragment older than the shallow boundary is attributed to the BOUNDARY
# commit — an ordinary-looking date that is simply wrong. But a fragment added
# after the boundary has a genuine add-commit and reads correctly, so a blanket
# refusal of every shallow clone is over-broad. It also made the tool unusable
# in the environment it runs in: this repository's own checkout is shallow, and
# the only escape offered was the flag that disables dating altogether.
echo "T4: a shallow clone whose fragments predate the boundary is refused"
build "$ROOT/t4src"
git -C "$ROOT/t4src" branch -M main
git clone -q --depth 1 "file://$ROOT/t4src" "$ROOT/t4" 2>/dev/null
check "clone really is shallow" "$(git -C "$ROOT/t4" rev-parse --is-shallow-repository)" "true"
msg="$(bash "$ROOT/t4/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "refused"              "$?"                                        "1"
check "names the fragment"   "$(says "$msg" 'dates to the shallow boundary')" "1"
check "nothing consumed"     "$(pending "$ROOT/t4")"                     "2"
bash "$ROOT/t4/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "override still works in a shallow clone" "$?" "0"

echo "T4b: a shallow clone whose fragments POST-date the boundary proceeds"
# `build()` puts its fragments immediately after the base commit, so ANY shallow
# clone of it has a fragment commit at the boundary. This case needs older
# history underneath instead, so the boundary lands on a commit that is not a
# fragment's — which is the ordinary situation in a real CI checkout.
S="$ROOT/t4bsrc"
mkdir -p "$S/docs/ReleaseNotes/unreleased"
cp "$SRC" "$S/docs/ReleaseNotes/assemble.sh"
printf '# unreleased\n' > "$S/docs/ReleaseNotes/unreleased/README.md"
printf '## template\n'  > "$S/docs/ReleaseNotes/unreleased/_TEMPLATE.md"
git -C "$S" init -q
git -C "$S" config user.email test@example.com
git -C "$S" config user.name test
git -C "$S" add -A
GIT_AUTHOR_DATE='2026-08-10T00:00:00Z' GIT_COMMITTER_DATE='2026-08-10T00:00:00Z' \
  git -C "$S" commit -q -m base
printf 'filler\n' > "$S/filler.txt"; git -C "$S" add -A
GIT_AUTHOR_DATE='2026-08-12T00:00:00Z' GIT_COMMITTER_DATE='2026-08-12T00:00:00Z' \
  git -C "$S" commit -q -m filler
_frag "$S" 0001-a '2026-08-16T23:00:00Z'
_frag "$S" 0002-b '2026-08-17T10:00:00Z'
git -C "$S" branch -M main
# depth 3 keeps [0002-b, 0001-a, filler]; the boundary is `filler`, so neither
# fragment's add-commit is fabricated.
git clone -q --depth 3 "file://$S" "$ROOT/t4b" 2>/dev/null
check "clone really is shallow" "$(git -C "$ROOT/t4b" rev-parse --is-shallow-repository)" "true"
msg="$(bash "$ROOT/t4b/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "succeeds rather than refusing" "$?"                                                              "0"
check "and dates the fragment truly"  "$(sections "$ROOT/t4b/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "1"
check "holding the other day back"    "$(pending "$ROOT/t4b")"                                          "1"
check "named with its own true day"   "$(says "$msg" '2026-08-16 UTC')"                                 "1"

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

# ── A rename is not an addition ──────────────────────────────────────────────
# Path-limited history starts at the NEW name, so without `--follow` a fragment
# renamed on a later day dates to the rename rather than to when it was written.
# This is a live case: fragments get renamed to match their PR number once the
# number is known, which is routinely the day after.
echo "T7: a renamed fragment keeps its original day"
W="$ROOT/t7"; build "$W"
git -C "$W" mv docs/ReleaseNotes/unreleased/0001-a.md \
              docs/ReleaseNotes/unreleased/0001-a-renamed.md
GIT_AUTHOR_DATE='2026-08-17T12:00:00Z' GIT_COMMITTER_DATE='2026-08-17T12:00:00Z' \
  git -C "$W" commit -q -m rename
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "the 08-16 run still claims it"  "$?"                                                            "0"
check "it is folded into 08-16"        "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-16.md")" "1"
check "the renamed file is not held back" "$(says "$msg" '0001-a-renamed.md')"                         "0"
check "the genuine 08-17 one still is"    "$(says "$msg" '0002-b.md')"                                 "1"
check "no 08-17 file written by this run" "$([ -f "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md" ] && echo yes || echo no)" "no"

# ── A rename staged but not yet committed ────────────────────────────────────
# `--follow` cannot help here: no commit connects the new name to the old one,
# so the history query returns empty and the fragment reads as newly written —
# taken for whatever day was asked, then deleted. The index knows, and
# `git status -M` reports it, so the pre-rename path is what gets dated.
echo "T8: a staged (uncommitted) rename keeps the original day"
W="$ROOT/t8"; build "$W"
git -C "$W" mv docs/ReleaseNotes/unreleased/0001-a.md \
              docs/ReleaseNotes/unreleased/0001-a-staged.md   # staged, NOT committed
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "the 08-17 run succeeds"        "$?"                                    "0"
check "the staged rename is held back" "$(says "$msg" '0001-a-staged.md')"    "1"
check "dated to where it was written"  "$(says "$msg" '2026-08-16 UTC')"      "1"
check "so only 08-17's own is folded"  "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "1"
check "and it survives on disk"        "$([ -f "$W/docs/ReleaseNotes/unreleased/0001-a-staged.md" ] && echo yes || echo no)" "yes"

# ── An unreadable history must abort, not read as "uncommitted" ──────────────
# `git log` exits 0 with empty output for a path it has no history for, which
# is how an uncommitted fragment is recognised. A NON-zero exit means something
# else, and swallowing it would select the fragment for any date and then delete
# it.
#
# Modelled as a git that fails ONLY on `log` — the real shape of the case, an
# otherwise-valid repository missing an object `log` needs. A git that failed at
# everything would instead trip the is-this-a-work-tree check and take the
# no-git branch, which is a different (and honest) path: it says it cannot date.
echo "T8b: an unreadable git history aborts"
W="$ROOT/t8b"; build "$W"
mkdir -p "$ROOT/fakebin"
REAL_GIT="$(command -v git)"
cat > "$ROOT/fakebin/git" <<EOF
#!/bin/sh
for a in "\$@"; do [ "\$a" = "log" ] && exit 128; done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$ROOT/fakebin/git"
msg="$(PATH="$ROOT/fakebin:$PATH" bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "aborts"           "$?"                                    "1"
check "says why"         "$(says "$msg" 'cannot read git history')" "1"
check "nothing consumed" "$(pending "$W")"                       "2"

# ── A reused fragment name must not inherit the old file's day ───────────────
# History is keyed by PATH, not content. `<TASK-ID>-<slug>.md` names recur, and
# an assembled fragment's name keeps its add-commit forever, so a brand-new
# fragment reusing one would be dated to whenever the PREVIOUS file was written.
echo "T9: a reused fragment name is dated as new, not inherited"
W="$ROOT/t9"; build "$W"
_frag "$W" 0009-reused '2026-08-15T09:00:00Z'          # used...
git -C "$W" rm -q docs/ReleaseNotes/unreleased/0009-reused.md
GIT_AUTHOR_DATE='2026-08-15T12:00:00Z' GIT_COMMITTER_DATE='2026-08-15T12:00:00Z' \
  git -C "$W" commit -q -m "assemble 0009"             # ...assembled and gone
printf '## new\n' > "$W/docs/ReleaseNotes/unreleased/0009-reused.md"  # name reused
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "the 08-17 run succeeds"          "$?"                              "0"
check "the reused name is not held"     "$(says "$msg" '0009-reused.md')" "0"
check "not dated to the old file's day" "$(says "$msg" '2026-08-15 UTC')" "0"
check "folded with 08-17's own"         "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "2"

# ── A rename below git's similarity threshold cannot be paired ───────────────
# `-M` is DETECTION by similarity, not a record of intent: `git mv` plus a
# substantial rewrite before staging reports a plain add and a plain delete with
# nothing linking them. Unrecoverable — but the run says what it saw rather than
# misfiling in silence.
echo "T10: an unpairable staged rename is announced, not silently misfiled"
W="$ROOT/t10"; build "$W"
git -C "$W" mv docs/ReleaseNotes/unreleased/0001-a.md \
              docs/ReleaseNotes/unreleased/0001-a-rewritten.md
# Replace the content wholesale so similarity detection cannot pair the two.
printf 'totally different content, sharing no line with the original\n' \
  > "$W/docs/ReleaseNotes/unreleased/0001-a-rewritten.md"
git -C "$W" add -A
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "the run still succeeds"        "$?"                                    "0"
check "it announces the ambiguity"    "$(says "$msg" 'staged deletion')"      "1"
check "naming the added fragment"     "$(says "$msg" '0001-a-rewritten.md')"  "1"
check "and the deleted one"           "$(says "$msg" '0001-a.md')"            "1"

# ── Reached through a symlink, the guard must still work ────────────────────
# Every path comparison is against `git rev-parse --show-toplevel`, which is
# PHYSICAL. A logical `pwd` through a symlinked checkout yields the symlink
# path, the repo-root prefix fails to strip, every `HEAD:<rel>` lookup misses,
# and each fragment reads as newly written — disabling the whole selection pass
# silently, for every fragment, on a run that otherwise looks ordinary.
echo "T10b: a symlinked checkout does not disable the guard"
build "$ROOT/t10b-real"
ln -s "$ROOT/t10b-real" "$ROOT/t10b-link"
msg="$(bash "$ROOT/t10b-link/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "the 08-17 run succeeds"        "$?"                                                       "0"
check "the 08-16 fragment is held"    "$(says "$msg" '0001-a.md')"                               "1"
check "named with its own day"        "$(says "$msg" '2026-08-16 UTC')"                          "1"
check "only 08-17's own is folded"    "$(sections "$ROOT/t10b-real/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "1"
check "and it survives on disk"       "$([ -f "$ROOT/t10b-real/docs/ReleaseNotes/unreleased/0001-a.md" ] && echo yes || echo no)" "yes"

# ── A glob metacharacter in a name must not make the fragment vanish ────────
# Collecting then sorting through an unquoted command substitution both
# word-splits and pathname-expands, and `nullglob` is on — so such a name
# expands to nothing and drops out of the list silently. The fragment is then
# neither assembled nor removed, while the run reports success and a count that
# excludes it.
echo "T10c: a glob metacharacter in a fragment name is not dropped"
W="$ROOT/t10c"; build "$W"
printf '## bracketed\n' > "$W/docs/ReleaseNotes/unreleased/0004-a[1]-b.md"   # untracked, so this day
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "the run succeeds"           "$?"                                                            "0"
check "it is folded in, not lost"  "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "2"
check "the count includes it"      "$(says "$msg" 'Assembled 2 fragment')"                         "1"
check "and it is consumed on disk" "$([ -f "$W/docs/ReleaseNotes/unreleased/0004-a[1]-b.md" ] && echo yes || echo no)" "no"

# ── A signed-commit config must not poison the date query ───────────────────
# `log.showSignature=true` prepends GPG verification lines to STDOUT even with a
# custom --format, so the captured value would carry signature text plus the
# date and never match. This repo signs its squash merges, so it is a plausible
# config for an operator to have set.
echo "T10d: log.showSignature does not break dating"
W="$ROOT/t10d"; build "$W"
git -C "$W" config log.showSignature true
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "the run succeeds"            "$?"                                                            "0"
check "its own day is folded"       "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-16.md")" "1"
check "the other day is held back"  "$(says "$msg" '2026-08-17 UTC')"                               "1"

# ── A damaged checkout must not read as a clean export ──────────────────────
# Both fail `rev-parse --is-inside-work-tree`, but only an export can honestly
# assemble everything undated; doing that on a broken repository would consume
# every pending fragment under a date nothing verified.
echo "T10e: damaged .git metadata is refused, not treated as an export"
W="$ROOT/t10e"; build "$W"
mv "$W/.git/HEAD" "$W/.git/HEAD.bak"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "refused"          "$?"                                        "1"
check "says why"         "$(says "$msg" 'git cannot read this work tree')" "1"
check "nothing consumed" "$(pending "$W")"                           "2"
mv "$W/.git/HEAD.bak" "$W/.git/HEAD"

# ── An unreadable index must not read as "no renames staged" ────────────────
echo "T10f: an unreadable index aborts"
W="$ROOT/t10f"; build "$W"
mkdir -p "$ROOT/fakebin2"
REAL_GIT2="$(command -v git)"
cat > "$ROOT/fakebin2/git" <<EOF2
#!/bin/sh
for a in "\$@"; do [ "\$a" = "status" ] && exit 128; done
exec "$REAL_GIT2" "\$@"
EOF2
chmod +x "$ROOT/fakebin2/git"
msg="$(PATH="$ROOT/fakebin2:$PATH" bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "aborts"           "$?"                                          "1"
check "says why"         "$(says "$msg" 'could not read the git index')" "1"
check "nothing consumed" "$(pending "$W")"                             "2"

# ── An unreadable HEAD must not read as "fragment not committed" ────────────
echo "T10g: an unreadable HEAD lookup aborts"
W="$ROOT/t10g"; build "$W"
mkdir -p "$ROOT/fakebin3"
cat > "$ROOT/fakebin3/git" <<EOF3
#!/bin/sh
for a in "\$@"; do [ "\$a" = "ls-tree" ] && exit 128; done
exec "$REAL_GIT2" "\$@"
EOF3
chmod +x "$ROOT/fakebin3/git"
msg="$(PATH="$ROOT/fakebin3:$PATH" bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "aborts"           "$?"                              "1"
check "says why"         "$(says "$msg" 'cannot read HEAD')" "1"
check "nothing consumed" "$(pending "$W")"                  "2"

# ── Round 9 (Codex) — three more "a failed probe read as a benign answer" ────
echo "T10h: a FAILING shallow probe aborts instead of reading as non-shallow"
W="$ROOT/t10h"; build "$W"
mkdir -p "$ROOT/fakebin4"
cat > "$ROOT/fakebin4/git" <<EOF4
#!/bin/sh
# Fail ONLY the shallow probe. Everything else must still work, or the run would
# abort on a different check and this case would pass for the wrong reason.
prev=""
for a in "\$@"; do
  [ "\$a" = "--is-shallow-repository" ] && exit 128
  prev="\$a"
done
exec "$REAL_GIT2" "\$@"
EOF4
chmod +x "$ROOT/fakebin4/git"
msg="$(PATH="$ROOT/fakebin4:$PATH" bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "aborts"            "$?"                                        "1"
check "names the probe"   "$(says "$msg" 'whether this repository is shallow')" "1"
check "nothing consumed"  "$(pending "$W")"                           "2"

echo "T10i: a DANGLING .git symlink is damage, not an export"
W="$ROOT/t10i"; build "$W"
rm -rf "$W/.git"
ln -s "$W/.git-gone-missing" "$W/.git"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "aborts"            "$?"                                    "1"
check "says damaged"      "$(says "$msg" 'cannot read this work tree')" "1"
check "did NOT call it an export" "$(says "$msg" 'not a git work tree')" "0"
check "nothing consumed"  "$(pending "$W")"                       "2"

echo "T10j: Bash 3 is refused up front, by name"
W="$ROOT/t10j"; build "$W"
# Can't run under a real Bash 3 here, so assert the GUARD exists and fires on the
# version test itself rather than faking an old shell.
check "guard present" \
  "$(grep -c 'BASH_VERSINFO\[0\] < 4' "$W/docs/ReleaseNotes/assemble.sh")" "1"
check "guard is before the first mapfile" \
  "$(awk '/BASH_VERSINFO\[0\] < 4/{g=NR} /^[^#]*mapfile/{if(!m)m=NR} END{print (g && m && g < m) ? 1 : 0}' \
     "$W/docs/ReleaseNotes/assemble.sh")" "1"
check "guard names bash 4" \
  "$(grep -c 'requires Bash 4 or newer' "$W/docs/ReleaseNotes/assemble.sh")" "1"

# ── Argument handling ────────────────────────────────────────────────────────
# ── Crash safety: the two windows between writing and clearing (#1788) ───────
# Assembly is two steps that cannot be made one — replace the dated file, then
# remove the fragments it consumed. Both windows are simulated here by putting
# the tree into the exact state an interruption leaves and running the script
# again, which is the operator's actual recovery. Neither state used to be
# survivable: the second one silently duplicated published prose.
echo "T12: an interruption AFTER the write does not duplicate content"
W="$ROOT/t12"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
# Exactly the interrupted state: the file was written, the fragment was not
# removed. Restoring it is what a crash between the rename and the `rm` leaves.
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/0001-a.md
check "the interrupted state has it pending again" "$(pending "$W")" "2"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "re-run succeeds"                "$?"                                          "0"
check "content is NOT duplicated"      "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the fragment is cleared"        "$(pending "$W")"                             "1"
check "and it says what it recognised" "$(says "$msg" 'Already assembled')"          "1"
check "naming the fragment"            "$(says "$msg" '0001-a.md')"                  "1"

echo "T12b: a re-run with nothing but already-assembled fragments still clears"
W="$ROOT/t12b"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/0001-a.md
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "succeeds with nothing to append" "$?"                                          "0"
check "still not duplicated"            "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the stale fragment is cleared"   "$(pending "$W")"                             "0"
check "and says there is nothing left"  "$(says "$msg" 'Nothing left to assemble')"   "1"

echo "T13: the dated file is replaced whole, never left half-written"
W="$ROOT/t13"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
check "no temp file survives a good run" \
  "$(find "$out" -maxdepth 1 -name '.assemble-*' | wc -l | tr -d ' ')" "0"
# A marker exists for what was folded, and is invisible in rendered markdown —
# it must be an HTML comment, not a visible line, since this file is published.
check "a marker records the fragment and its hash" \
  "$(grep -cE '^<!-- assembled-fragment: 0001-a\.md sha256=[0-9a-f]{64} -->$' \
      "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the marker is an HTML comment" \
  "$(grep -c '^<!--.*-->$' "$out/ReleaseNotes-2026-08-16.md")" "1"

echo "T13b: a marker-shaped line inside PROSE is not treated as a marker"
W="$ROOT/t13b"; build "$W"
out="$W/docs/ReleaseNotes"
# The quoted marker must carry the REAL hash of the fragment it names —
# otherwise it matches nothing and the case is vacuous whichever parser runs.
# That is what makes it dangerous: a fragment documenting this mechanism would
# quote a real marker, and an unanchored parser then reads the quotation as a
# record and deletes the named fragment unread (Codex #1863 r2).
MK='<!-- assembled-fragment: '
HH="$(sha256sum < "$W/docs/ReleaseNotes/unreleased/0002-b.md" | cut -d' ' -f1)"
{
  echo '## a'
  echo 'The marker for the sibling note looks like this:'
  echo ''
  echo "> ${MK}0002-b.md sha256=${HH} -->"
  echo ''
  echo 'and indented:'
  echo ''
  echo "    ${MK}0002-b.md sha256=${HH} -->"
} > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
git -C "$W" add -A
GIT_AUTHOR_DATE='2026-08-16T23:00:00Z' GIT_COMMITTER_DATE='2026-08-16T23:00:00Z' \
  git -C "$W" commit -q -m mention
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
bash "$out/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "the quoted fragment still assembles" \
  "$(sections "$out/ReleaseNotes-2026-08-17.md")" "1"
check "its text is present, not just deleted" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-17.md")" '0002-b')" "1"
check "nothing left pending"                    "$(pending "$W")" "0"

# ── Marker identity must be the CONTENT, not the name (Codex #1863 r1) ───────
# A name is neither stable nor unique to its text, and the recovery path uses
# it to authorise deleting a fragment. Both directions are tested: same name /
# different text must NOT be treated as already assembled, and different name /
# same text must be.
echo "T14: a fragment EDITED after an interrupted run is not silently deleted"
W="$ROOT/t14"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
# The interrupted state, then the operator edits the still-pending fragment.
printf '## 0001-a\nRewritten after the interruption.\n' \
  > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
git -C "$W" add -A
GIT_AUTHOR_DATE='2026-08-16T23:00:00Z' GIT_COMMITTER_DATE='2026-08-16T23:00:00Z' \
  git -C "$W" commit -q -m edited
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the edit is appended, not discarded" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-16.md")" 'Rewritten after the interruption')" "1"
check "the fragment is consumed"  "$(pending "$W")" "1"
check "and the repeated heading is flagged" \
  "$(says "$msg" 'already contains these headings')" "1"

echo "T14b: a REUSED basename with different content is treated as new"
W="$ROOT/t14b"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
printf '## a second note\nDifferent text under a reused filename.\n' \
  > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
git -C "$W" add -A
GIT_AUTHOR_DATE='2026-08-16T22:00:00Z' GIT_COMMITTER_DATE='2026-08-16T22:00:00Z' \
  git -C "$W" commit -q -m reused
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
check "the reused name's content is kept" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-16.md")" 'Different text under a reused')" "1"
check "both sections present"    "$(sections "$out/ReleaseNotes-2026-08-16.md")" "2"

echo "T15: a fragment RENAMED between runs stops the run rather than being guessed at"
W="$ROOT/t15"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/0001-a.md
mv "$W/docs/ReleaseNotes/unreleased/0001-a.md" \
   "$W/docs/ReleaseNotes/unreleased/0001-a-retitled.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
# Deliberately NOT auto-consumed (Codex #1863 r2). Same bytes under a different
# name is a rename OR an unrelated fragment carrying the same text, and the two
# want opposite handling — delete, or append. Stopping is the only response
# that cannot be wrong; what matters is that it never duplicates and never
# deletes on a guess.
check "the run stops"                   "$?"                              "1"
check "not duplicated"                  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the fragment is NOT deleted"     "$(pending "$W")"                 "2"
check "it names what it matched"        "$(says "$msg" 'same bytes as')"  "1"
check "and offers the rename reading"   "$(says "$msg" 'delete the fragment(s) by hand')" "1"

echo "T16: a marker in ANOTHER dated file still counts (the midnight case)"
W="$ROOT/t16"; build "$W"
out="$W/docs/ReleaseNotes"
# The fragment must be genuinely UNTRACKED — never committed. Only then is it
# accepted for any date, which is what makes the midnight case reachable at
# all. A committed fragment that is deleted and recreated is still tracked, so
# the UTC-day guard holds it back and the marker lookup never runs: the first
# version of this case passed for that reason rather than for the one it
# claimed, which is no test at all.
printf '## untracked note\n' > "$W/docs/ReleaseNotes/unreleased/0003-c.md"
cp "$W/docs/ReleaseNotes/unreleased/0003-c.md" "$ROOT/t16-copy.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "it was folded into the 08-16 file" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-16.md")" 'untracked note')" "1"
# Interrupted after the write: still pending, and the clock has passed midnight
# so the default run now targets a DIFFERENT dated file.
cp "$ROOT/t16-copy.md" "$W/docs/ReleaseNotes/unreleased/0003-c.md"
rm -f "$W/docs/ReleaseNotes/unreleased/0001-a.md" \
      "$W/docs/ReleaseNotes/unreleased/0002-b.md"
bash "$out/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "the next day's file is not created for it" \
  "$(sections "$out/ReleaseNotes-2026-08-17.md")" "0"
check "and the fragment is cleared"  "$(pending "$W")" "0"

echo "T17: a directory at the output path is refused before anything is consumed"
W="$ROOT/t17"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir "$out/ReleaseNotes-2026-08-16.md"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
check "run fails"                  "$?"              "1"
check "no fragment was consumed"   "$(pending "$W")" "2"

echo "T18: a MARKERLESS file that may already hold the content stops and asks"
W="$ROOT/t18"; build "$W"
out="$W/docs/ReleaseNotes"
# What an interrupted run of the OLD script leaves: content in place, no
# marker, fragment still pending. Absence of a marker cannot distinguish this
# from a genuinely new fragment, so the script must not choose silently.
printf '# Release Notes — 2026-08-16\n\n## 0001-a\n' \
  > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "run fails"                    "$?"                             "1"
check "no fragment was consumed"     "$(pending "$W")"                "2"
check "it names the override"        "$(says "$msg" '--force-append')" "1"
msg="$(bash "$out/assemble.sh" 2026-08-16 --force-append 2>&1)"
check "the override appends"         "$?"                             "0"
check "and consumes the fragment"    "$(pending "$W")"                "1"

echo "T19: a filename containing a backslash still hashes correctly"
W="$ROOT/t19"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# `sha256sum FILE` escapes such a name and prefixes the line with a backslash,
# so a path-based hash yields `\<hash>` and the marker is written unparseable —
# the fragment is then never recognised on recovery. Hashing stdin avoids it.
BS_FRAG="$W/docs/ReleaseNotes/unreleased/0004-we\\ird.md"
printf '## backslash note\n' > "$BS_FRAG"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "a well-formed marker is written" \
  "$(grep -cE '^<!-- assembled-fragment: .+ sha256=[0-9a-f]{64} -->$' \
      "$out/ReleaseNotes-2026-08-16.md")" "1"
# And the recovery it exists for actually works for this file.
printf '## backslash note\n' > "$BS_FRAG"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "it is recognised, not duplicated" \
  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "and cleared"  "$(pending "$W")" "0"

echo "T20: identical bytes under a different name are not assumed to be a rename"
W="$ROOT/t20"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
printf '## Fixed a typo.\n' > "$W/docs/ReleaseNotes/unreleased/0005-first.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
# A DIFFERENT, later fragment that happens to carry the same short text. A
# content hash identifies bytes, not an occurrence, so treating this as the
# earlier one renamed would delete it and produce no note for its day.
printf '## Fixed a typo.\n' > "$W/docs/ReleaseNotes/unreleased/0006-second.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run stops"               "$?"                              "1"
check "the fragment is NOT deleted" "$(pending "$W")"                 "1"
check "it explains both readings"   "$(says "$msg" 'same bytes as')"  "1"
check "and names the override"      "$(says "$msg" '--force-append')" "1"
bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates --force-append >/dev/null 2>&1
check "the override appends it"     "$(sections "$out/ReleaseNotes-2026-08-17.md")" "1"
check "and consumes it"             "$(pending "$W")"                 "0"

echo "T21: the assembled file stays readable, not owner-only"
W="$ROOT/t21"; build "$W"
out="$W/docs/ReleaseNotes"
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
# mktemp creates 0600 and mv carries the mode across, so a new dated file would
# be owner-only and an existing one would be silently narrowed.
check "a new file is group/world readable" \
  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "644"
chmod 640 "$out/ReleaseNotes-2026-08-16.md"
printf '## later note\n' > "$W/docs/ReleaseNotes/unreleased/0007-later.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "an existing file keeps its own mode" \
  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "640"

echo "T11: argument handling"
W="$ROOT/t11"; build "$W"
S="$W/docs/ReleaseNotes/assemble.sh"
bash "$S" --nope              >/dev/null 2>&1; check "unknown option refused" "$?" "1"
bash "$S" 2026-08-16 2026-08-17 >/dev/null 2>&1; check "two dates refused"   "$?" "1"
bash "$S" 20260816            >/dev/null 2>&1; check "bad date format refused" "$?" "1"
bash -n "$SRC"                >/dev/null 2>&1; check "assemble.sh parses"    "$?" "0"

echo ""
if (( FAILED )); then echo "assemble.test.sh: FAILURES above ^^^" >&2; exit 1; fi
echo "assemble.test.sh: all cases pass"
