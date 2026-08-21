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
  # `-type f`: T33 puts a DIRECTORY named like a fragment in there on
  # purpose, and without this it would be counted as one more pending
  # fragment — an assertion about fragments quietly measuring something
  # else.
  # NUL-delimited, not `| wc -l`. A filename containing a NEWLINE prints as
  # two lines and would be counted twice — the same newline-delimited
  # miscount T44 is about, in the helper that checks it. Counting the
  # delimiters is exact whatever the names contain.
  find "$1/docs/ReleaseNotes/unreleased" -type f -name '*.md' \
    ! -name README.md ! -name _TEMPLATE.md -print0 \
    | tr -d -c '\0' | wc -c | tr -d ' '
}
sections() {  # sections <file> -> count of `## ` headings, 0 if absent
  if [ -f "$1" ]; then grep -c '^## ' "$1" || true; else echo 0; fi
}
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

count_in() {  # count_in <ere> <file> -> number of matching lines, 0 if absent
  # `grep -c` prints 0 AND exits 1 when nothing matches, so the obvious
  # `grep -c … || echo 0` emits "0\n0" and every comparison against it fails.
  if [ -f "$2" ]; then grep -cE "$1" "$2" || true; else echo 0; fi
}

fixture_hash() {  # fixture_hash <file> -> sha256 of its bytes
  # The same portable selection assemble.sh makes, for the same reason: stock
  # macOS ships `shasum`, not `sha256sum`. Hashed from STDIN so the filename
  # never appears in the output (see the script's own note).
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | cut -d' ' -f1
  else
    shasum -a 256 < "$1" | cut -d' ' -f1
  fi
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
HH="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0002-b.md")"
# Assert the fixture itself. A hash that came back empty — which is what a
# bare `sha256sum` does on stock macOS, where the script deliberately falls
# back to `shasum` — quotes a MALFORMED marker, which matches nothing under
# either parser and makes this case pass vacuously (Codex #1863 r3). That is
# the exact failure this case exists to prevent, in the case itself.
check "the fixture hash is well-formed" \
  "$(printf '%s' "$HH" | grep -cE '^[0-9a-f]{64}$')" "1"
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

echo "T16: a marker in ANOTHER dated file stops the run (the midnight case)"
W="$ROOT/t16"; build "$W"
out="$W/docs/ReleaseNotes"
# The fragment must be genuinely UNTRACKED — never committed. Only then is it
# accepted for any date, which is what makes the midnight case reachable at
# all. A committed fragment that is deleted and recreated is still tracked, so
# the UTC-day guard holds it back and the marker lookup never runs: the first
# version of this case passed for that reason rather than the one it claimed,
# which is no test at all.
printf '## untracked note\n' > "$W/docs/ReleaseNotes/unreleased/0003-c.md"
cp "$W/docs/ReleaseNotes/unreleased/0003-c.md" "$ROOT/t16-copy.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "it was folded into the 08-16 file" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-16.md")" 'untracked note')" "1"
# Interrupted after the write: still pending, and the clock has passed midnight
# so the default run now targets a DIFFERENT dated file. Its marker is in the
# 08-16 file, which is NOT the file being assembled — indistinguishable from a
# note reused on a later day, so the run stops rather than guessing (Codex
# #1863 r3). What matters is that it never writes the payload into two dated
# files, which it used to.
cp "$ROOT/t16-copy.md" "$W/docs/ReleaseNotes/unreleased/0003-c.md"
rm -f "$W/docs/ReleaseNotes/unreleased/0001-a.md" \
      "$W/docs/ReleaseNotes/unreleased/0002-b.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 2>&1)"
check "the run stops"                "$?"                               "1"
check "the next day's file is not created for it" \
  "$(sections "$out/ReleaseNotes-2026-08-17.md")" "0"
check "the fragment is NOT deleted"  "$(pending "$W")"                  "1"
check "it names the other file"      "$(says "$msg" 'ReleaseNotes-2026-08-16.md')" "1"

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
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
# mktemp creates 0600 and mv carries the mode across, so a new dated file would
# be owner-only and an existing one would be silently narrowed.
# Derived, not hardcoded: under a legitimate restrictive umask (0027, 0077)
# the assembler correctly creates 0640 or 0600, and a fixed 644 would report a
# regression caused only by the caller's own policy (Codex #1863 r3).
want_new="$(printf '%o' "$(( 0666 & ~0$(umask) ))")"
check "a new file matches what a plain redirect would create" \
  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "$want_new"
chmod 640 "$out/ReleaseNotes-2026-08-16.md"
printf '## later note\n' > "$W/docs/ReleaseNotes/unreleased/0007-later.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "an existing file keeps its own mode" \
  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "640"

echo "T22: a name AND its bytes reused on a later day is not assumed to be the same note"
W="$ROOT/t22"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
printf '## Fixed a typo.\n' > "$W/docs/ReleaseNotes/unreleased/reused.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
# Same name, same bytes, LATER day. A digest plus a name still identifies text
# rather than an occurrence, so consuming this would delete a genuinely new
# note and produce no file for its day (Codex #1863 r3). What distinguishes it
# from an interrupted re-run is WHERE the marker is: there, in the file being
# assembled; here, in another day's.
printf '## Fixed a typo.\n' > "$W/docs/ReleaseNotes/unreleased/reused.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run stops"                "$?"                                "1"
check "the fragment is NOT deleted"  "$(pending "$W")"                   "1"
check "it names the other file"      "$(says "$msg" 'ReleaseNotes-2026-08-16.md')" "1"
bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates --force-append >/dev/null 2>&1
check "the override writes the day's file" \
  "$(sections "$out/ReleaseNotes-2026-08-17.md")" "1"

echo "T23: a marker prefix appearing only in prose does not make a file authoritative"
W="$ROOT/t23"; build "$W"
out="$W/docs/ReleaseNotes"
# The legacy-file stop keys off "does this file carry markers at all". Matching
# the bare PREFIX let prose — or a malformed example — declare a markerless
# legacy file authoritative and skip the stop entirely (Codex #1863 r3).
{
  echo '# Release Notes — 2026-08-16'
  echo ''
  echo 'We write a line like <!-- assembled-fragment: something.md --> after each.'
  echo ''
  echo '## 0001-a'
} > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the legacy stop still fires" "$?"                              "1"
check "no fragment was consumed"    "$(pending "$W")"                 "2"
check "it names the override"       "$(says "$msg" '--force-append')" "1"

echo "T24: an unreadable dated file aborts instead of scanning as markerless"
W="$ROOT/t24"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
# An incomplete recovery index is worse than none: a fragment whose marker
# lives in the unreadable file reads as never assembled and is appended again.
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/0001-a.md
chmod 000 "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
rc=$?
chmod 644 "$out/ReleaseNotes-2026-08-16.md"
if [ "$(id -u)" = "0" ]; then
  # root reads through mode 000, so the case cannot be staged this way.
  ok "skipped — running as root, chmod 000 does not deny reads (CI runs it)"
else
  check "the run stops"               "$rc"                        "1"
  # Asserted against what `run_checked` actually prints. The earlier
  # wording ("incomplete") belonged to the bespoke message this scan had
  # before it moved onto the shared helper — and because this case SKIPS
  # under root, the stale assertion could not fail in the container it
  # was edited in. CI, which runs unprivileged, is the only place the
  # chmod-000 cases are exercised at all.
  check "it names the scan that failed" \
    "$(says "$msg" 'for assembly markers failed')" "1"
  check "no fragment was consumed"    "$(pending "$W")"            "2"
fi

echo "T25: a FIFO at a dated path is refused instead of hanging the run"
W="$ROOT/t25"; build "$W"
out="$W/docs/ReleaseNotes"
# Pick a timeout implementation FIRST. On stock macOS neither exists unless GNU
# coreutils is installed, and `timeout` then returns 127 without ever launching
# the assembler — which a "not 124 means it returned" test reads as a pass
# while exercising nothing (Codex #1863 r4). Skip loudly instead.
TMO=""
if command -v timeout >/dev/null 2>&1; then TMO=timeout
elif command -v gtimeout >/dev/null 2>&1; then TMO=gtimeout
fi
mkfifo "$out/ReleaseNotes-2026-01-01.md"
if [ -z "$TMO" ]; then
  ok "skipped — no timeout(1) or gtimeout(1); cannot bound a hang safely"
else
  "$TMO" 20 bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
  rc=$?
  # 124 is timeout's own "it hung" status; 127 would be "never launched".
  check "the run did not hang"     "$([ "$rc" -eq 124 ] && echo hung || echo returned)" "returned"
  check "the assembler was reached" "$([ "$rc" -eq 127 ] && echo missing || echo ran)"  "ran"
  check "and it refused"            "$rc"                                               "1"
  check "no fragment was consumed"  "$(pending "$W")"                                   "2"
fi
rm -f "$out/ReleaseNotes-2026-01-01.md"

echo "T26: a symlink at the output path is refused, not replaced"
W="$ROOT/t26"; build "$W"
out="$W/docs/ReleaseNotes"
# `-f` FOLLOWS a symlink, so a link to a regular file passes that guard; `mv`
# then replaces the LINK and leaves its target untouched, while every fragment
# is consumed on a successful-looking run (Codex #1863 r4).
printf '# real target\n' > "$W/real-notes.md"
ln -s "$W/real-notes.md" "$out/ReleaseNotes-2026-08-16.md"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
check "the run fails"              "$?"                                          "1"
check "no fragment was consumed"   "$(pending "$W")"                             "2"
check "the path is still a symlink" \
  "$([ -L "$out/ReleaseNotes-2026-08-16.md" ] && echo link || echo replaced)"    "link"
check "its target is untouched"    "$(cat "$W/real-notes.md")"                   "# real target"

echo "T27: two overlapping assemblies cannot lose a fragment"
W="$ROOT/t27"; build "$W"
out="$W/docs/ReleaseNotes"
unrel="$W/docs/ReleaseNotes/unreleased"
# The lock makes read-pool/build/rename/delete one transaction. It covers the
# PENDING POOL, not one dated file: two runs on different dates still share
# unreleased/, and with --allow-mixed-dates or an untracked fragment both can
# select the same one, both rename, and one deletes it after the other has
# already written it into a second dated file (Codex #1863 r5).
mkdir "$unrel/.assemble.lock"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "a held lock refuses the run" "$?"                            "1"
check "no fragment was consumed"    "$(pending "$W")"               "2"
check "it names the lock"           "$(says "$msg" '.assemble.lock')" "1"
check "and says how to clear it"    "$(says "$msg" 'rmdir')"        "1"
# A DIFFERENT date must also be refused while it is held — that is the whole
# correction, since the earlier per-date lock let this through.
bash "$out/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "another date is refused too" "$?"                            "1"
check "still nothing consumed"      "$(pending "$W")"               "2"
rmdir "$unrel/.assemble.lock"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
check "it proceeds once released"   "$(pending "$W")"               "1"
check "and leaves no lock behind" \
  "$([ -e "$unrel/.assemble.lock" ] && echo held || echo clear)"    "clear"
# The lock must not be mistaken for a fragment by the pool scan.
check "the lock is not folded in" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-16.md")" 'assemble.lock')" "0"

echo "T28: two fragments with IDENTICAL bytes in one assembly both stay recorded"
W="$ROOT/t28"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
printf '## Same wording.\n' > "$W/docs/ReleaseNotes/unreleased/0008-x.md"
printf '## Same wording.\n' > "$W/docs/ReleaseNotes/unreleased/0009-y.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "both were folded in"  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "2"
check "both markers written" \
  "$(grep -cE '^<!-- assembled-fragment: .+ sha256=[0-9a-f]{64} -->$' \
      "$out/ReleaseNotes-2026-08-16.md")" "2"
# The interrupted state, with BOTH still pending. A hash-keyed index keeps only
# the last of them, so the other fails its exact-match test and is reported
# ambiguous even though its own marker is right there.
printf '## Same wording.\n' > "$W/docs/ReleaseNotes/unreleased/0008-x.md"
printf '## Same wording.\n' > "$W/docs/ReleaseNotes/unreleased/0009-y.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the re-run succeeds"        "$?"                                          "0"
check "nothing is duplicated"      "$(sections "$out/ReleaseNotes-2026-08-16.md")" "2"
check "both are cleared"           "$(pending "$W")"                             "0"

echo "T29: a symlinked output is refused BEFORE marker recovery deletes anything"
W="$ROOT/t29"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Assemble a real file for one day, then point ANOTHER day's output at it and
# re-create the same fragment. The symlink is followed by `-f`, so with the
# guard placed next to the `mv` the marker scan indexes the link as today's
# $OUT, deletes the fragment as "already assembled", and exits successfully at
# "Nothing left" — never reaching the guard at all (Codex #1863 r5). A check
# that protects a destructive step has to run before it.
printf '## reused note\n' > "$W/docs/ReleaseNotes/unreleased/same.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
ln -s "$out/ReleaseNotes-2026-08-16.md" "$out/ReleaseNotes-2026-08-17.md"
printf '## reused note\n' > "$W/docs/ReleaseNotes/unreleased/same.md"
bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the run fails"               "$?"              "1"
check "the fragment is NOT deleted" "$(pending "$W")" "1"
check "the link is untouched" \
  "$([ -L "$out/ReleaseNotes-2026-08-17.md" ] && echo link || echo replaced)" "link"
rm -f "$out/ReleaseNotes-2026-08-17.md"

echo "T30: a failing hash aborts instead of writing an empty marker"
W="$ROOT/t30"; build "$W"
out="$W/docs/ReleaseNotes"
# Stage a checksum tool that fails. Inlined as $(frag_hash …) the failure is
# swallowed by the command substitution — printf still succeeds, so the run
# writes `sha256=` with nothing after it, replaces the output and deletes the
# fragment. That marker can never be indexed, so the recovery it exists for is
# gone (Codex #1863 r6).
mkdir -p "$W/fakebin"
for tool in sha256sum shasum; do
  printf '#!/bin/sh\nexit 3\n' > "$W/fakebin/$tool"
  chmod +x "$W/fakebin/$tool"
done
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run fails"              "$?"                          "1"
check "the fragment is NOT deleted" "$(pending "$W")"            "2"
# The first hash of a fragment is now the one taken either side of the working
# copy, so a broken checksum is reported as "reading" rather than "hashing".
# Same guard, same refusal, earlier point.
check "it reports the command failure" "$(says "$msg" 'reading 0001-a.md failed')" "1"
check "no empty-hash marker was written" \
  "$(count_in 'sha256= -->' "$out/ReleaseNotes-2026-08-16.md")" "0"

# The variant that produces the EXACT failure described: a checksum tool that
# SUCCEEDS while printing something that is not a hash. `set -e` cannot see
# that one, so before the fix `printf` wrote `sha256=…` with junk in it,
# replaced the output and deleted the fragment — a marker that can never be
# indexed, so the recovery it exists for is silently gone.
W="$ROOT/t30b"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/fakebin"
for tool in sha256sum shasum; do
  printf '#!/bin/sh\necho "not-a-hash"\nexit 0\n' > "$W/fakebin/$tool"
  chmod +x "$W/fakebin/$tool"
done
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "a zero-exit bad hash also fails" "$?"                              "1"
check "the fragment is NOT deleted"     "$(pending "$W")"                 "2"
check "it reports the bad value"        "$(says "$msg" 'not-a-hash')"     "1"
check "no malformed marker was written" \
  "$(count_in 'sha256=not-a-hash' "$out/ReleaseNotes-2026-08-16.md")" "0"

# The third shape: a tool that prints something that LOOKS like a valid hash
# and exits NON-ZERO. Validating the output alone accepts it, so the run
# writes a false marker — and a working checksum later will not match it, so
# the fragment is appended again (Codex #1863 r7).
W="$ROOT/t30c"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/fakebin"
for tool in sha256sum shasum; do
  printf '#!/bin/sh\necho "%s  -"\nexit 3\n' \
    "0000000000000000000000000000000000000000000000000000000000000000" \
    > "$W/fakebin/$tool"
  chmod +x "$W/fakebin/$tool"
done
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "a plausible-but-failed hash is refused" "$?"                       "1"
check "the fragment is NOT deleted"            "$(pending "$W")"          "2"
check "it reports the command failure"  "$(says "$msg" 'reading 0001-a.md failed')" "1"
check "no false marker was written" \
  "$(count_in 'sha256=0000' "$out/ReleaseNotes-2026-08-16.md")" "0"

echo "T31: a failing tail aborts rather than corrupting the marker"
W="$ROOT/t31"; build "$W"
out="$W/docs/ReleaseNotes"
# The separator between a fragment and its marker is decided by `tail -c1`. If
# that fails, the substitution is empty, the -z test passes, no newline is
# written, and the marker is glued onto the fragment's last line — unreadable,
# so recovery cannot see it and appends the fragment again (Codex #1863 r8).
#
# The fragment must end WITHOUT a newline — that is the only case where the
# separator matters. A fragment that ends with one terminates its own line, so
# the marker lands correctly whatever `tail` did, and a test using such a
# fragment would assert nothing about the glue.
printf '## no trailing newline' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
git -C "$W" add -A
GIT_AUTHOR_DATE='2026-08-16T23:00:00Z' GIT_COMMITTER_DATE='2026-08-16T23:00:00Z' \
  git -C "$W" commit -q -m nonewline
mkdir -p "$W/fakebin"
printf '#!/bin/sh\nexit 4\n' > "$W/fakebin/tail"
chmod +x "$W/fakebin/tail"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run fails"               "$?"                                    "1"
check "the fragment is NOT deleted" "$(pending "$W")"                       "2"
check "it says what it could not read" "$(says "$msg" 'last byte')"         "1"
check "no glued marker was written" \
  "$(count_in '.+<!-- assembled-fragment: ' "$out/ReleaseNotes-2026-08-16.md")" "0"

echo "T32: a failing heading scan aborts rather than skipping the duplicate check"
W="$ROOT/t32"; build "$W"
out="$W/docs/ReleaseNotes"
# The failure must be injected AT THE HEADING SCAN. The first version made the
# fragment unreadable with chmod 000, which on a non-root runner aborts at the
# earlier `frag_hash` instead — so the case never reached the branch it was
# written for, and asserted the wrong message (Codex #1863 r9). A shim that
# fails only for `-m1` isolates it: `-m1` is used by the heading scan and by
# nothing else in the script.
printf '# Release Notes — 2026-08-16\n\n## 0001-a\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/grep" <<'SHIM'
#!/bin/sh
for a in "$@"; do
  [ "$a" = "-m1" ] && exit 2
done
exec /usr/bin/grep "$@"
SHIM
chmod +x "$W/fakebin/grep"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run stops"               "$?"                            "1"
check "no fragment was consumed"    "$(pending "$W")"               "2"
check "it names the heading scan"   "$(says "$msg" 'reading 0001-a.md failed')" "1"

echo "T32b: a failing heading scan of the OUTPUT is not read as no-match"
W="$ROOT/t32b"; build "$W"
out="$W/docs/ReleaseNotes"
# As an `if` condition, a grep ERROR is indistinguishable from an ordinary
# no-match, so the duplicate check would quietly clear and the section be
# appended twice. `-qxF`/`-xF` is used only for that comparison.
printf '# Release Notes — 2026-08-16\n\n## 0001-a\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/grep" <<'SHIM'
#!/bin/sh
for a in "$@"; do
  [ "$a" = "-xF" ] && exit 2
done
exec /usr/bin/grep "$@"
SHIM
chmod +x "$W/fakebin/grep"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run stops"              "$?"                                  "1"
check "no fragment was consumed"   "$(pending "$W")"                     "2"
check "it names the output check"  "$(says "$msg" 'repeated heading')"   "1"

echo "T32c: a fragment containing a NUL byte is still scanned as text"
W="$ROOT/t32c"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Without `-a`, GNU grep reports "binary file matches" INSTEAD of the marker
# line, so the index loses that fragment's record and recovery appends it
# again (Codex #1863 r9).
printf '## nul note\n\000\n## nul note two\n' > "$W/docs/ReleaseNotes/unreleased/0010-nul.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "it was folded in"        "$(count_in '^## nul note$' "$out/ReleaseNotes-2026-08-16.md")" "1"
# Interrupted after the write: restored, still pending.
printf '## nul note\n\000\n## nul note two\n' > "$W/docs/ReleaseNotes/unreleased/0010-nul.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the marker is still recognised" \
  "$(count_in '^## nul note$' "$out/ReleaseNotes-2026-08-16.md")" "1"
check "and it is cleared"       "$(pending "$W")" "0"

echo "T32d: an unreadable existing mode aborts instead of widening the file"
W="$ROOT/t32d"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
chmod 600 "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
# Format-aware: the owner query must still succeed, or the run aborts at the
# ownership check ahead of this one and the case stops testing the mode branch
# it is named for.
cat > "$W/fakebin/stat" <<SHIM
#!/bin/sh
for a in "\$@"; do
  case "\$a" in
    '%u') echo $(id -u); exit 0 ;;
    '%g') echo $(id -g); exit 0 ;;
  esac
done
exit 1
SHIM
chmod +x "$W/fakebin/stat"
printf '## later note\n' > "$W/docs/ReleaseNotes/unreleased/0011-later.md"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"            "$?"                                   "1"
check "the file keeps its mode"  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "600"
check "it says why"              "$(says "$msg" 'current mode')"        "1"

echo "T33: run_checked's fatal path actually fires (no root needed)"
W="$ROOT/t33"; build "$W"
out="$W/docs/ReleaseNotes"
# T24 and T32 stage their read errors with chmod 000, which root reads through
# — so in a root container the shared guard's fatal path is never exercised at
# all, and a regression in it would go unnoticed by every case that depends on
# it. A DIRECTORY named like a fragment produces a genuine non-zero from the
# first command that reads it, whoever is running.
mkdir "$W/docs/ReleaseNotes/unreleased/0003-dir.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"              "$?"                             "1"
check "no fragment was consumed"   "$(pending "$W")"                "2"
check "it names what it was doing" "$(says "$msg" '0003-dir.md')"   "1"
check "and says it refuses to continue" \
  "$(says "$msg" 'must not continue on the strength of')"           "1"
rmdir "$W/docs/ReleaseNotes/unreleased/0003-dir.md"

echo "T34: a fragment ENDING in NUL still gets a findable marker"
W="$ROOT/t34"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Bash drops NUL from a command substitution, so capturing the final byte gave
# an empty string — read as "already ends with a newline" — and the marker was
# written straight after the NUL rather than at the start of a line, where the
# anchored scan can never find it (Codex #1863 r12). A second, ordinary
# fragment is present so the output HAS a valid marker: that is what makes the
# index look authoritative and lets the damaged one be appended twice.
printf '## nul tail' > "$W/docs/ReleaseNotes/unreleased/0012-nultail.md"
printf '\000' >> "$W/docs/ReleaseNotes/unreleased/0012-nultail.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "both were folded in"  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "2"
check "both markers are at line start" \
  "$(count_in '^<!-- assembled-fragment: .+ sha256=[0-9a-f]{64} -->$' \
      "$out/ReleaseNotes-2026-08-16.md")" "2"
# Interrupted after the write: restore both, re-run.
printf '## nul tail' > "$W/docs/ReleaseNotes/unreleased/0012-nultail.md"
printf '\000' >> "$W/docs/ReleaseNotes/unreleased/0012-nultail.md"
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/0001-a.md
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "nothing is duplicated"  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "2"
check "and both are cleared"   "$(pending "$W")" "0"

echo "T35: a stat that prints a plausible mode but FAILS is not believed"
W="$ROOT/t35"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
chmod 600 "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
# Prints a believable mode AND exits non-zero. Shape alone cannot tell that
# from a real answer, so accepting it widened an existing 0600 to 0644 before
# consuming the fragments (Codex #1863 r12).
# GNU form prints a believable mode and FAILS; BSD fallback fails silently.
# A shim that printed for both was already rejected by the old chain — because
# the captured output became "644\n644" and failed the shape check — so it
# reproduced nothing. The finding needs exactly one plausible-looking answer.
cat > "$W/fakebin/stat" <<SHIM
#!/bin/sh
for a in "\$@"; do
  case "\$a" in
    '%u') echo $(id -u); exit 0 ;;
    '%g') echo $(id -g); exit 0 ;;
    '%a') echo 644; exit 3 ;;
  esac
done
exit 1
SHIM
chmod +x "$W/fakebin/stat"
printf '## later note\n' > "$W/docs/ReleaseNotes/unreleased/0013-later.md"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                           "1"
check "the file keeps 600"      "$(mode_of "$out/ReleaseNotes-2026-08-16.md")"  "600"
check "the fragment survives"   "$(pending "$W")"                              "2"

echo "T36: a fragment name that would close the marker comment is refused"
W="$ROOT/t36"; build "$W"
out="$W/docs/ReleaseNotes"
# `note-->visible.md` ends the HTML comment at the name, so the hash renders as
# visible text in the published notes — breaking the one promise the marker
# makes (Codex #1863 r12).
printf '## sneaky\n' > "$W/docs/ReleaseNotes/unreleased/note-->visible.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                    "1"
check "no fragment consumed"   "$(pending "$W")"                       "3"
check "it says why"            "$(says "$msg" 'HTML comment delimiter')" "1"
rm -f "$W/docs/ReleaseNotes/unreleased/note-->visible.md"

echo "T37: a fragment cannot supply its own marker record"
W="$ROOT/t37"; build "$W"
out="$W/docs/ReleaseNotes"
# Anchoring stopped a marker quoted MID-LINE from counting, but a fragment can
# put a complete valid one at the START of a line — and once assembled it is
# indistinguishable from a record the script wrote. Naming a LATER fragment
# would have that one deleted unread (Codex #1863 r13).
HH="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0002-b.md")"
{
  echo '## poisoner'
  echo "<!-- assembled-fragment: 0002-b.md sha256=${HH} -->"
} > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                    "1"
check "no fragment consumed"   "$(pending "$W")"                       "2"
check "it says why"            "$(says "$msg" 'itself an assembly')"   "1"
# Indented or quoted is still fine — that is what the anchor is for.
{
  echo '## documenter'
  echo "    <!-- assembled-fragment: 0002-b.md sha256=${HH} -->"
} > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "an indented example is allowed" "$(pending "$W")"                "0"
check "and the other fragment survived assembly" \
  "$(says "$(cat "$out/ReleaseNotes-2026-08-16.md")" '0002-b')"        "1"

echo "T38: a fragment edited mid-run is kept, not deleted"
W="$ROOT/t38"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# `sed` is what reads the fragment into the output. A shim that rewrites the
# file as a side effect reproduces "edited between the hash and the read"
# deterministically (Codex #1863 r13).
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
# Writes the ORIGINAL fragment, not whatever path sed was handed. Since the
# run now assembles from a working COPY taken up front, a shim keyed on
# sed's argument never touches a fragment at all and the case silently
# stops testing anything (found when the copy landed). What is under test
# is a fragment changing after the run has read it and before it is
# removed, so the shim edits the fragment where it actually lives.
printf '## edited underneath\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run still succeeds"       "$?"                              "0"
check "the changed fragment is KEPT" "$(pending "$W")"                 "1"
check "and it says so"               "$(says "$msg" 'Kept (changed')"  "1"

echo "T39: the output mode is applied to the finished file, not the temp file"
W="$ROOT/t39"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
# Group-writable, owner NOT. Copied onto a temp file the runner owns, the owner
# bits are what apply — so the build is locked out of its own file (Codex
# #1863 r13). Root ignores the bits entirely, so this only means something
# unprivileged; say so rather than reporting a pass it did not earn.
chmod 460 "$out/ReleaseNotes-2026-08-16.md"
printf '## later note\n' > "$W/docs/ReleaseNotes/unreleased/0014-later.md"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
rc=$?
if [ "$(id -u)" = "0" ]; then
  ok "skipped — running as root, mode bits do not deny writes (CI runs it)"
else
  check "the run succeeds"        "$rc"                                          "0"
  check "the mode is preserved"   "$(mode_of "$out/ReleaseNotes-2026-08-16.md")"  "460"
fi
chmod 644 "$out/ReleaseNotes-2026-08-16.md"

echo "T40: an output owned by someone else is refused, not silently taken over"
W="$ROOT/t40"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
printf '## later note\n' > "$W/docs/ReleaseNotes/unreleased/0015-later.md"
# Replacing a file by renaming another over it installs a NEW inode owned by
# the runner, so a shared dated file changes hands silently (Codex #1863 r14).
# Only root can stage this by chowning to another uid.
if [ "$(id -u)" != "0" ]; then
  ok "skipped — cannot chown to another user unprivileged (CI runs as non-root; staged here)"
else
  chown 65534 "$out/ReleaseNotes-2026-08-16.md"
  msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"           "$?"                              "1"
  # Two: 0002-b belongs to the other day and was held back by the first run,
  # plus the one just added. Neither may be consumed by a refused run.
  check "no fragment is consumed" "$(pending "$W")"                 "2"
  check "it names the owner"      "$(says "$msg" 'owned by uid 65534')" "1"
  check "the file still belongs to them" \
    "$(stat -c '%u' "$out/ReleaseNotes-2026-08-16.md" 2>/dev/null \
       || stat -f '%u' "$out/ReleaseNotes-2026-08-16.md")" "65534"
  chown 0 "$out/ReleaseNotes-2026-08-16.md"
fi

echo "T41: the fragment deleted is the one that was checked"
W="$ROOT/t41"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Hash-the-path then remove-the-path leaves a window: bytes written between the
# two are deleted having never reached $OUT. Quarantining first makes the
# checked object and the deleted object the same inode (Codex #1863 r14). The
# shim writes the fragment during the read, so the re-hash differs.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
# Writes the ORIGINAL fragment — see the note in T38. Keyed on sed's
# argument this stopped firing once assembly began reading a working copy.
printf '## rewritten mid-run\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run succeeds"        "$?"                                 "0"
check "the new bytes survive somewhere" \
  "$(grep -rl 'rewritten mid-run' "$W/docs/ReleaseNotes/unreleased" | wc -l | tr -d ' ')" "1"
check "it says it set one aside" "$(says "$msg" 'set aside as')"      "1"

echo "T42: a failure DURING clearing says the file is already written"
W="$ROOT/t42"; build "$W"
out="$W/docs/ReleaseNotes"
# Failing here is unlike failing anywhere else: $OUT is already replaced, so
# the run is half done and the operator needs to know. A leftover set-aside
# file trips it deterministically — and it is a real state, left behind by an
# earlier crashed run. The name carries no PID precisely so this is
# reproducible rather than dependent on PID reuse.
printf 'left over from a crash\n' > "$W/docs/ReleaseNotes/unreleased/.assembled.0001-a.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run fails"               "$?"                                        "1"
check "it says the file is written" "$(says "$msg" 'HAS ALREADY BEEN WRITTEN')"  "1"
check "it names the leftover"       "$(says "$msg" 'already exists')"            "1"
# The half-done state is real, and the message has to be true about it.
check "the dated file WAS written"  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the leftover is untouched" \
  "$(cat "$W/docs/ReleaseNotes/unreleased/.assembled.0001-a.md")" "left over from a crash"
rm -f "$W/docs/ReleaseNotes/unreleased/.assembled.0001-a.md"

echo "T43: a set-aside fragment is reported, not silently invisible"
W="$ROOT/t43"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Interrupted between the rename and the removal, a fragment exists ONLY as
# `.assembled.<name>` — and the pool glob does not match dotfiles, so the next
# run would report "No pending fragments" with one sitting right there (Codex
# #1863 r15).
printf '## set aside earlier\n' > "$W/docs/ReleaseNotes/unreleased/.assembled.0016-x.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it is named"              "$(says "$msg" '.assembled.0016-x.md')"   "1"
check "and explained"            "$(says "$msg" 'Set aside by an earlier run')" "1"
check "it is not deleted" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/.assembled.0016-x.md" ] && echo kept || echo gone)" "kept"
# And it is still reported when there is genuinely nothing else to do.
check "reported even with an empty pool" \
  "$(says "$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)" 'Set aside by an earlier run')" "1"
rm -f "$W/docs/ReleaseNotes/unreleased/.assembled.0016-x.md"

echo "T44: a fragment filename containing a newline is refused clearly"
W="$ROOT/t44"; build "$W"
out="$W/docs/ReleaseNotes"
# The ordering step is newline-delimited, so such a name becomes two entries
# and the run later fails on truncated paths that do not exist — a checksum
# error naming a file nobody wrote, with the pool stuck until someone works out
# the name is the problem (Codex #1863 r16).
printf '## newline name\n' > "$W/docs/ReleaseNotes/unreleased/$(printf 'two\nlines').md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                  "1"
check "no fragment consumed"   "$(pending "$W")"                     "3"
check "it says what is wrong"  "$(says "$msg" 'contains a newline')"  "1"
rm -f "$W/docs/ReleaseNotes/unreleased/$(printf 'two\nlines').md"

echo "T45: an edit to the dated file mid-run is not overwritten"
W="$ROOT/t45"; build "$W"
out="$W/docs/ReleaseNotes"
# The run snapshots $OUT with `cat`, appends to the snapshot, then renames it
# over $OUT — so anything written to $OUT in between is discarded while the
# fragments are consumed and the run reports success (Codex #1863 r17). The
# pool lock excludes other assembler runs, not an editor.
#
# `sed` is the injection point because the script calls it exactly once, in
# the fragment loop, which is after the `cat` and before the `mv`. A shim
# firing anywhere earlier would land INSIDE the snapshot and prove nothing.
printf '# Release Notes — 2026-08-16\n\n## pre-existing\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '\n## edited by someone else\n' >> "$out/ReleaseNotes-2026-08-16.md"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"            "$?"                                       "1"
check "no fragment consumed"     "$(pending "$W")"                          "2"
check "it says what happened"    "$(says "$msg" 'changed while this run')"   "1"
check "the other edit survives" \
  "$(count_in '^## edited by someone else$' "$out/ReleaseNotes-2026-08-16.md")" "1"
check "nothing was appended" \
  "$(count_in '^## 0001-a$' "$out/ReleaseNotes-2026-08-16.md")"              "0"

echo "T45b: a dated file CREATED mid-run is not clobbered"
W="$ROOT/t45b"; build "$W"
out="$W/docs/ReleaseNotes"
# The absent case takes the other branch — the snapshot is a fresh header
# rather than a copy — and an empty recorded hash must not read as "matches".
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-16\n\n## created by someone else\n' \
    > "$out/ReleaseNotes-2026-08-16.md"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                     "1"
check "no fragment consumed"    "$(pending "$W")"                        "2"
# A dated file appearing mid-run is now caught by the set check across every
# file the index read, which names it specifically, ahead of the generic
# "created" branch.
check "it names that branch"    "$(says "$msg" 'appeared while this run')"  "1"
check "the other file survives" \
  "$(count_in '^## created by someone else$' "$out/ReleaseNotes-2026-08-16.md")" "1"

echo "T46: a dated file that BECOMES a symlink mid-run is refused"
W="$ROOT/t46"; build "$W"
out="$W/docs/ReleaseNotes"
# The startup shape guards describe $OUT as it was then. `-f` follows links,
# so a path that became one since would hash as a regular file and the rename
# would replace the LINK, leaving the target untouched with every fragment
# consumed. The link points at BYTE-IDENTICAL content on purpose: the hash
# re-check cannot fire, so only the shape re-check can, which is what makes
# this case about the shape re-check.
printf '# Release Notes — 2026-08-16\n\n## pre-existing\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/real-target.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  rm -f "$out/ReleaseNotes-2026-08-16.md"
  ln -s "$W/real-target.md" "$out/ReleaseNotes-2026-08-16.md"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                        "1"
check "no fragment consumed"   "$(pending "$W")"                           "2"
check "it names the shape"     "$(says "$msg" 'no longer a regular file')"  "1"
check "still a link"           "$([ -L "$out/ReleaseNotes-2026-08-16.md" ] && echo yes || echo no)" "yes"
check "the target is untouched" \
  "$(count_in '^## 0001-a$' "$W/real-target.md")"                          "0"

echo "T47: a temp file left by a hard kill is reported, not staged silently"
W="$ROOT/t47"; build "$W"
out="$W/docs/ReleaseNotes"
# SIGKILL cannot run the EXIT trap, so the `.assemble-<date>.XXXXXX` snapshot
# survives in docs/ReleaseNotes/ where nothing else looks — and the
# `git add -A docs/ReleaseNotes/` this script prints would stage it (Codex
# #1863 r17).
printf '# Release Notes — 2026-08-16\n\n## half written\n' > "$out/.assemble-2026-08-16.Ab3xYz"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it is named"      "$(says "$msg" '.assemble-2026-08-16.Ab3xYz')"         "1"
check "and explained"    "$(says "$msg" 'Left behind by an interrupted run')"   "1"
check "it is not deleted" \
  "$([ -f "$out/.assemble-2026-08-16.Ab3xYz" ] && echo kept || echo gone)"      "kept"
# Reported even when there is genuinely nothing else to do — the same rule the
# set-aside scan follows, and for the same reason.
check "reported with an empty pool" \
  "$(says "$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)" 'Left behind by an interrupted run')" "1"
rm -f "$out/.assemble-2026-08-16.Ab3xYz"

echo "T48: an edit during the disk flush is still caught"
W="$ROOT/t48"; build "$W"
out="$W/docs/ReleaseNotes"
# The flush must sit BEFORE the last look, not between it and the rename
# (Codex #1863 r18). Placed after the check it is a long step — the
# whole-system fallback can take seconds — inside the very window the check
# exists to close, so an edit arriving during it was validated as absent and
# overwritten anyway. Shimming `sync` puts the edit exactly there.
printf '# Release Notes — 2026-08-16\n\n## pre-existing\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sync" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '\n## edited during the flush\n' >> "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/fakebin/sync"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                     "1"
check "no fragment consumed"   "$(pending "$W")"                        "2"
check "it says what happened"  "$(says "$msg" 'changed while this run')"  "1"
check "the other edit survives" \
  "$(count_in '^## edited during the flush$' "$out/ReleaseNotes-2026-08-16.md")" "1"

echo "T49: a permission change mid-run is not silently undone"
W="$ROOT/t49"; build "$W"
out="$W/docs/ReleaseNotes"
# FINAL_MODE is resolved before the build and applied to the temp file, so a
# `chmod 600` landing meanwhile is reverted by the rename — the replacement
# arrives wearing the older, WIDER mode while the content check sees nothing
# wrong, because nothing about the content changed (Codex #1863 r18).
printf '# Release Notes — 2026-08-16\n\n## pre-existing\n' > "$out/ReleaseNotes-2026-08-16.md"
chmod 644 "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  chmod 600 "$out/ReleaseNotes-2026-08-16.md"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                        "1"
check "no fragment consumed"    "$(pending "$W")"                           "2"
check "it names the change"     "$(says "$msg" 'permissions or ownership')"  "1"
check "the restriction stands"  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "600"

echo "T50: an ownership change mid-run is not silently undone"
W="$ROOT/t50"; build "$W"
out="$W/docs/ReleaseNotes"
printf '# Release Notes — 2026-08-16\n\n## pre-existing\n' > "$out/ReleaseNotes-2026-08-16.md"
if [ "$(id -u)" != "0" ]; then
  check "skipped — chown needs root (CI runs it)" "1" "1"
else
  # The rename installs a NEW inode owned by whoever ran the script, so a
  # concurrent `chown` is undone by it — content unchanged, so no content
  # check can see it (Codex #1863 r19). The startup ownership refusal reads
  # the file long before this point.
  mkdir -p "$W/fakebin"
  cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  chown 65534:65534 "$out/ReleaseNotes-2026-08-16.md"
fi
exec /usr/bin/sed "\$@"
SHIM
  chmod +x "$W/fakebin/sed"
  msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"          "$?"                                        "1"
  check "no fragment consumed"   "$(pending "$W")"                           "2"
  check "it names the change"    "$(says "$msg" 'permissions or ownership')"  "1"
  check "the new owner stands" \
    "$(stat -c '%u' "$out/ReleaseNotes-2026-08-16.md")"                      "65534"
fi

echo "T51: a marker injected into a fragment mid-run never reaches the index"
W="$ROOT/t51"; build "$W"
out="$W/docs/ReleaseNotes"
# The gate that refuses a fragment carrying its own marker record ran on one
# read; the hash and the assembly used another. Gaining a marker line between
# the two put an injected record into the dated file, indistinguishable from
# one this script wrote — and a record can have a DIFFERENT fragment deleted
# unread (Codex #1863 r19). Assembly now reads a working copy taken up front,
# so validation, hashing and assembly cannot disagree about the bytes.
#
# Keyed on the marker pattern so it fires on the fragment-validation scan
# specifically, and appends AFTER the real grep has returned clean.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/grep" <<SHIM
#!/bin/sh
_marker=0
for a in "\$@"; do
  case "\$a" in *sha256=*) _marker=1 ;; esac
done
/usr/bin/grep "\$@"; _rc=\$?
if [ "\$_marker" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '<!-- assembled-fragment: 0002-b.md sha256=%s -->\n' \\
    ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \\
    >> "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/grep"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the injected record never lands" \
  "$(count_in 'sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' \
     "$out/ReleaseNotes-2026-08-16.md")"                                     "0"
# And the edited fragment is not destroyed: what was folded in is the version
# read at the start, so the newer bytes are set aside rather than deleted.
# Checked by CONTENT, not by the original filename — a kept fragment is
# renamed to `.assembled.<name>`, so testing for the old name reports "gone"
# for a fragment sitting safely right there. (That assertion was written the
# wrong way first and passed the wrong verdict.)
check "the newer bytes survive somewhere" \
  "$(grep -rl 'sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' \
     "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')"       "1"

echo "T52: recovery deletion rechecks the output it is trusting"
W="$ROOT/t52"; build "$W"
out="$W/docs/ReleaseNotes"
# The records authorising these deletions are read from the dated file early;
# the deletions happen later. If it changed in between, the evidence may
# describe text it no longer holds — and when EVERY fragment takes the
# recovery path the run exits before the check ahead of the rename, so this is
# the only place that can catch it (Codex #1863 r19).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/   # the interrupted state
mkdir -p "$W/fakebin"
cat > "$W/fakebin/grep" <<SHIM
#!/bin/sh
# Keyed on the dated-file WORKING COPY. The scan reads a copy now, so a
# shim keyed on the dated file's own path never fires; and keying on the
# marker pattern fires during FRAGMENT validation instead, which happens
# before the dated file is copied — the edit then lands inside the copy and
# the case tests the opposite of what it says. Both were tried.
_dated=0
for a in "\$@"; do
  case "\$a" in */dated.*) _dated=1 ;; esac
done
/usr/bin/grep "\$@"; _rc=\$?
if [ "\$_dated" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-16\n\n## replaced entirely\n' \\
    > "$out/ReleaseNotes-2026-08-16.md"
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/grep"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                  "1"
check "no fragment consumed"   "$(pending "$W")"                     "2"
check "it says what changed"   "$(says "$msg" 'changed while this run')" "1"

echo "T53: recovery deletion keeps a fragment that changed since it was read"
W="$ROOT/t53"; build "$W"
out="$W/docs/ReleaseNotes"
# The recovery loop deleted outright, so a fragment edited since the run read
# it was thrown away while the dated file held only the older text — the fault
# the consumption loop already refuses to commit, sitting unguarded a few
# lines away. Found by auditing this path rather than by a review round.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/grep" <<SHIM
#!/bin/sh
# Keyed on the dated-file WORKING COPY. The scan reads a copy now, so a
# shim keyed on the dated file's own path never fires; and keying on the
# marker pattern fires during FRAGMENT validation instead, which happens
# before the dated file is copied — the edit then lands inside the copy and
# the case tests the opposite of what it says. Both were tried.
_dated=0
for a in "\$@"; do
  case "\$a" in */dated.*) _dated=1 ;; esac
done
/usr/bin/grep "\$@"; _rc=\$?
if [ "\$_dated" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## 0001-a\n\nnewly added line\n' \\
    > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/grep"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the edited one is kept" \
  "$(count_in 'newly added line' "$W/docs/ReleaseNotes/unreleased/0001-a.md")" "1"
check "and it says so"         "$(says "$msg" 'Kept (changed')"      "1"
check "the untouched one goes" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/0002-b.md" ] && echo kept || echo gone)" "gone"

echo "T54: the published file is rechecked before fragments are removed"
W="$ROOT/t54"; build "$W"
out="$W/docs/ReleaseNotes"
# Every check before the rename asks "is $OUT still what this run started
# from"; after it, that question is retired on purpose. Without a NEW baseline
# the fragments — the only other copy — were deleted on the strength of bytes
# nothing had looked at since, so a dated file removed during the flush took
# them both (Codex #1863 r20). The sync shim fires on the post-rename flush.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sync" <<SHIM
#!/bin/sh
if [ -f "$out/ReleaseNotes-2026-08-16.md" ]; then
  rm -f "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/fakebin/sync"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run fails"            "$?"                                   "1"
check "it says it is gone"       "$(says "$msg" 'gone or altered')"      "1"
check "the fragments survive"    "$(pending "$W")"                       "2"

echo "T55: each recovery deletion rechecks for itself, not once for the batch"
W="$ROOT/t55"; build "$W"
out="$W/docs/ReleaseNotes"
# Checked once before the loop, the SECOND deletion still ran on evidence
# gathered before the first — so an edit landing between them removed a
# fragment whose section was no longer anywhere (Codex #1863 r20). Both
# fragments take the recovery path here, and the output is replaced after the
# first removal.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/rm" <<SHIM
#!/bin/sh
/bin/rm "\$@"; _rc=\$?
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */unreleased/*)
      : > "$W/fired"
      printf '# Release Notes — 2026-08-16\n\n## replaced after the first\n' \\
        > "$out/ReleaseNotes-2026-08-16.md"
      ;;
  esac
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/rm"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                     "1"
check "the second one survives" "$(pending "$W")"                        "1"
check "it says what changed"    "$(says "$msg" 'changed while this run')"  "1"

echo "T56: a fragment rewritten DURING the copy is refused, not published torn"
W="$ROOT/t56"; build "$W"
out="$W/docs/ReleaseNotes"
# `cp` is not atomic. Rewritten while it reads, the copy can hold an old
# prefix and a new suffix — a version that never existed — and everything
# downstream trusts it consistently, so the invented text is published and
# only the coherent source is quarantined afterwards (Codex #1863 r20).
# Shimming `cp` reproduces the race deterministically: rewrite the source
# between the two reads that bracket the copy.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/cp" <<SHIM
#!/bin/sh
/bin/cp "\$@"; _rc=\$?
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## rewritten during the copy\n' \\
    > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/cp"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                        "1"
check "no fragment consumed"   "$(pending "$W")"                           "2"
check "it says what happened"  "$(says "$msg" 'changed while it was being read')" "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"

echo "T57: a marker appearing in ANOTHER dated file mid-run stops the run"
W="$ROOT/t57"; build "$W"
out="$W/docs/ReleaseNotes"
# Only $OUT was revalidated, so a record added to a different day after the
# scan left this run still believing the fragment was unfiled — appending the
# same section to a second day and deleting the source (Codex #1863 r20).
printf '# Release Notes — 2026-08-15\n\n## older day\n' > "$out/ReleaseNotes-2026-08-15.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '\n## 0001-a\n' >> "$out/ReleaseNotes-2026-08-15.md"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                    "1"
check "no fragment consumed"   "$(pending "$W")"                       "2"
check "it names the other day" "$(says "$msg" 'ReleaseNotes-2026-08-15.md changed')" "1"

echo "T58: a NEW dated file appearing mid-run stops the run"
W="$ROOT/t58"; build "$W"
out="$W/docs/ReleaseNotes"
# A file created since the scan was never recorded, so comparing recorded
# entries alone cannot see it — and a new file is exactly where a competing
# writer would put a record.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-14\n' > "$out/ReleaseNotes-2026-08-14.md"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                     "1"
check "no fragment consumed"   "$(pending "$W")"                        "2"
check "it names the newcomer"  "$(says "$msg" '2026-08-14.md appeared')"  "1"

echo "T59: another day's fragment does not abort this day's run"
W="$ROOT/t59"; build "$W"
out="$W/docs/ReleaseNotes"
# Copying and content-validating every PENDING fragment rather than every
# SELECTED one let a fragment belonging to another day abort this one — the
# exact failure the select-don't-refuse rule exists to prevent, arriving by a
# different route (Codex #1863 r21). 0002-b belongs to 08-17 and carries a
# forbidden marker record; the 08-16 run must hold it back, not die on it.
printf '## bad day fragment\n<!-- assembled-fragment: x.md sha256=%s -->\n' \
  ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  > "$W/docs/ReleaseNotes/unreleased/0002-b.md"
git -C "$W" add -A
GIT_AUTHOR_DATE='2026-08-17T10:00:00Z' GIT_COMMITTER_DATE='2026-08-17T10:00:00Z' \
  git -C "$W" commit -q -m 'bad 0002-b'
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run succeeds"        "$?"                                          "0"
check "this day was produced" \
  "$(count_in '^## 0001-a$' "$out/ReleaseNotes-2026-08-16.md")"               "1"
check "the other day is held"   "$(pending "$W")"                             "1"

echo "T60: the post-write handler exists before anything can call it"
W="$ROOT/t60"; build "$W"
out="$W/docs/ReleaseNotes"
# A shell function does not exist until its definition has EXECUTED. The
# readback after the rename called the handler while it was still defined
# further down, so the first post-publication failure died with exit 127 and
# "command not found", telling the operator nothing about the dated file
# already being written (Codex #1863 r21).
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sha256sum" <<SHIM
#!/bin/sh
if [ -f "$out/ReleaseNotes-2026-08-16.md" ]; then exit 3; fi
exec /usr/bin/sha256sum "\$@"
SHIM
chmod +x "$W/fakebin/sha256sum"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
rc=$?
check "it is not 127"            "$([ "$rc" = "127" ] && echo bad || echo ok)"  "ok"
check "no command-not-found"     "$(says "$msg" 'command not found')"           "0"
check "it states the contract"   "$(says "$msg" 'HAS ALREADY BEEN WRITTEN')"    "1"

echo "T61: a near-NAME_MAX fragment name can still be set aside"
W="$ROOT/t61"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Prefixing a legal 250-byte basename with ".assembled." makes an illegal
# destination, and `mv` then fails AFTER the dated file is published — so every
# first assembly entered the half-done recovery path instead of finishing
# (Codex #1863 r21).
# 5 + 240 + 3 = 248 bytes: legal on its own, illegal once ".assembled." is
# prepended. Built as prefix + padding + suffix, not by repeating the whole
# stem, which produced a name too long to even create.
long="0003-$(printf 'x%.0s' $(seq 1 240)).md"
[ "${#long}" -eq 248 ] || { echo "  FAIL — test bug: fixture name is ${#long} bytes"; FAILED=1; }
printf '## long name\n' > "$W/docs/ReleaseNotes/unreleased/$long"
mkdir -p "$W/fakebin"
# Force the set-aside path: the fragment changes after it is read.
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## changed after reading\n' > "$W/docs/ReleaseNotes/unreleased/$long"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run completes"       "$?"                                      "0"
check "no name-too-long"        "$(says "$msg" 'too long')"                "0"
check "the newer bytes survive" \
  "$(grep -rl 'changed after reading' "$W/docs/ReleaseNotes/unreleased" | wc -l | tr -d ' ')" "1"

echo "T62: a marker record containing a NUL is refused, not silently reshaped"
W="$ROOT/t62"; build "$W"
out="$W/docs/ReleaseNotes"
# Bash cannot hold a NUL and drops it from a command substitution, so a
# malformed record `name.md<NUL> sha256=...` — which the anchored pattern
# rejects — arrives as a VALID record for `name.md` and authorises deleting it
# (Codex #1863 r21).
_h="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0001-a.md")"
{ printf '# Release Notes — 2026-08-16\n\n'
  printf '<!-- assembled-fragment: 0001-a.md'
  printf '\000'
  printf ' sha256=%s -->\n' "$_h"
} > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                  "1"
check "no fragment consumed"   "$(pending "$W")"                     "2"
check "it names the cause"     "$(says "$msg" 'null byte')"           "1"

echo "T63: a marker present only during the scan cannot authorise a deletion"
W="$ROOT/t63"; build "$W"
out="$W/docs/ReleaseNotes"
# Recording a digest and then grepping the LIVE file is two reads. A marker
# injected only for the duration of the grep, then removed, left the digest
# matching while the index held evidence that never persisted — and that
# evidence deleted a fragment whose section was then in no file at all
# (Codex #1863 r21). Parsing from the copy the digest describes closes it.
_h="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0001-a.md")"
printf '# Release Notes — 2026-08-16\n\n## something\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/pristine.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/cp" <<SHIM
#!/bin/sh
# Inject the record, let the copy be taken, then restore — so the live file
# ends identical to how it started and only the copy could ever have seen it.
case "\$*" in
  */ReleaseNotes-2026-08-16.md*)
    printf '<!-- assembled-fragment: 0001-a.md sha256=%s -->\n' "$_h" \\
      >> "$out/ReleaseNotes-2026-08-16.md"
    /bin/cp "\$@"; _rc=\$?
    /bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
    exit \$_rc
    ;;
esac
exec /bin/cp "\$@"
SHIM
chmod +x "$W/fakebin/cp"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "0001-a is not destroyed" \
  "$(grep -rl '0001-a' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T64: a multibyte name near NAME_MAX is measured in bytes, not characters"
W="$ROOT/t64"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# ${#var} counts CHARACTERS in the current locale; filesystem limits are BYTES.
# 81 three-byte characters plus ".md" is 84 characters but 246 bytes, so a
# character-based bound waves it through and the prefixed destination lands
# over NAME_MAX — failing AFTER publication (Codex #1863 r22).
long="$(printf '界%.0s' $(seq 1 81)).md"
[ "$(LC_ALL=C; echo ${#long})" -eq 246 ] || {
  echo "  FAIL — test bug: fixture is $(LC_ALL=C; echo ${#long}) bytes, want 246"; FAILED=1; }
printf '## wide name\n' > "$W/docs/ReleaseNotes/unreleased/$long"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sed" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## changed after reading\n' > "$W/docs/ReleaseNotes/unreleased/$long"
fi
exec /usr/bin/sed "\$@"
SHIM
chmod +x "$W/fakebin/sed"
# The locale has to actually EXIST or bash warns, falls back to C, and
# ${#var} counts bytes again — which makes this case pass against the very
# code it is meant to catch. It did exactly that when written against
# en_US.UTF-8, which is not installed here. Pick one that is, and say so
# rather than pass silently if none is.
utf8=""
for cand in C.utf8 C.UTF-8 en_US.utf8 en_US.UTF-8; do
  if locale -a 2>/dev/null | grep -qxF "$cand"; then utf8="$cand"; break; fi
done
if [ -z "$utf8" ]; then
  check "skipped — no UTF-8 locale installed, byte/char cannot differ" "1" "1"
else
  # Confirm the chosen locale really does make ${#} count characters, so a
  # locale that exists but behaves like C cannot make this vacuous either.
  check "the locale distinguishes the two" \
    "$(LC_ALL=$utf8 bash -c 'x="界界界"; echo ${#x}' 2>/dev/null)"          "3"
  msg="$(PATH="$W/fakebin:$PATH" LC_ALL=$utf8 bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run completes"       "$?"                                      "0"
  check "no name-too-long"        "$(says "$msg" 'too long')"                "0"
  check "the newer bytes survive" \
    "$(grep -rl 'changed after reading' "$W/docs/ReleaseNotes/unreleased" | wc -l | tr -d ' ')" "1"
fi

echo "T65: cleanup running twice does not release a lock it no longer holds"
W="$ROOT/t65"; build "$W"
out="$W/docs/ReleaseNotes"
# The INT/TERM traps call _cleanup and then exit, which fires the EXIT trap and
# calls it AGAIN. With the held-flag still set, the second rmdir ran too — and
# if another assembly had taken the lock in between, that call removed SOMEBODY
# ELSE'S lock (Codex #1863 r22). Driven directly, since reproducing the
# interleaving through a signal is inherently racy: source the script's cleanup
# in isolation and check the second call is inert.
cat > "$W/drive.sh" <<'DRIVE'
set -u
LOCK="$1/lock"; LOCK_HELD=0; WORK=""; SNAP=""
_cleanup() {
  local _w="$WORK" _s="$SNAP"
  WORK=""; SNAP=""
  [ -n "$_w" ] && rm -f "$_w"
  [ -n "$_s" ] && rm -rf "$_s"
  if (( LOCK_HELD )); then
    LOCK_HELD=0
    rmdir "$LOCK" 2>/dev/null
  fi
  return 0
}
mkdir "$LOCK"; LOCK_HELD=1
_cleanup                      # first call: releases
mkdir "$LOCK"                 # somebody else takes it
_cleanup                      # second call must NOT remove theirs
[ -d "$LOCK" ] && echo intact || echo stolen
DRIVE
check "the other lock survives" "$(bash "$W/drive.sh" "$W")" "intact"
# And the definition in the real script matches the one driven above, so this
# case cannot pass while the script diverges from it.
check "the script clears the flag" \
  "$(awk '/^_cleanup\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'LOCK_HELD=0')" "1"

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
