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
# The entry point is a shim; the assembler itself is `assemble.py` (#1877).
# A fixture that installs only the shim runs a command with no
# implementation behind it, which fails every case for one reason and
# tells you nothing about any of them.
IMPL="$DIR/assemble.py"

# ── Cases that need a privilege, and cases that need the lack of one ─────────
# Some cases stage a fault by TAKING A PERMISSION AWAY — an unreadable file, an
# unwritable directory. Root walks through all of it, so under root they cannot
# be staged. Others stage one by handing a file to ANOTHER OWNER or setting the
# set-group-ID bit, which needs root. No single run covers both sets.
#
# That was fine as a fact and disastrous as a habit. Whichever set could not run
# printed "ok — skipped", a full run reported every case passing, and the
# permission-staged half ran only in CI — where two of them had been RED for at
# least three commits while I read a green local run and believed it. A case
# nobody reads the result of is not a case.
#
# So a root run now does BOTH: its own pass, then a second pass as an ordinary
# account for the cases it cannot stage. `_second_pass` at the bottom runs it,
# after the first pass has reported, and its result is part of the verdict.
# Where no such account can be reached the old behaviour stands, said out loud
# at the end rather than as a column of cheerful "ok" lines.
#
# CI runs unprivileged, so it gets the permission-staged set and skips the
# root-staged one — unchanged, and now visible in its own output.
DROP_UID=""
DROP_GID=""
if [ "$(id -u)" = "0" ] && [ "${ASSEMBLE_TEST_NESTED:-}" != "1" ] \
   && command -v setpriv >/dev/null 2>&1; then
  for _u in nobody nfsnobody daemon games; do
    if _ent="$(getent passwd "$_u" 2>/dev/null)"; then
      _uid="$(printf '%s' "$_ent" | cut -d: -f3)"
      _gid="$(printf '%s' "$_ent" | cut -d: -f4)"
      # Checked BEFORE committing to it: the account has to be able to read this
      # suite and the script under test. A second pass that cannot open its own
      # argument fails in a way that reads like the tests failing.
      #
      # Somewhere to WRITE is not checked, it is provided. `$TMPDIR` was the
      # obvious candidate and it is not reliably usable — /tmp is 0755 on this
      # container, so the pre-check declined and the second pass silently never
      # ran, which is the same blindness in a new place. The pass gets a
      # directory made for it instead, inside the one this suite already
      # cleans up.
      if setpriv --reuid="$_uid" --regid="$_gid" --clear-groups \
           test -r "$0" -a -r "$SRC" 2>/dev/null; then
        DROP_UID="$_uid"; DROP_GID="$_gid"
        break
      fi
    fi
  done
fi

_second_pass() {
  [ -n "$DROP_UID" ] || return 0
  echo ""
  echo "── second pass as uid $DROP_UID — the cases root cannot stage ──"
  local _tmp="$ROOT/unprivileged"
  # Traversable, not writable: the second pass writes only inside the directory
  # made for it, which is sticky like /tmp. Both go with $ROOT on exit.
  #
  # Each step SAYS SO when it fails, rather than returning a bare nonzero that
  # the caller renders as "FAILURES in one or both passes" with nothing above
  # it to read. Setting the pass up is not the pass failing, and a suite whose
  # whole subject is not-reporting-success-for-work-not-done should not have a
  # silent one of its own.
  if ! mkdir -p "$_tmp" \
     || ! chmod o+rx "$ROOT" \
     || ! chmod 1777 "$_tmp"; then
    echo "  Could not prepare a working directory for the second pass." >&2
    echo "  The permission-staged cases are UNMEASURED, not passing." >&2
    return 1
  fi
  setpriv --reuid="$DROP_UID" --regid="$DROP_GID" --clear-groups \
    env ASSEMBLE_TEST_NESTED=1 HOME="$_tmp" TMPDIR="$_tmp" bash "$0" "$@"
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

FAILED=0
SKIPPED=0
ok()   { echo "  ok   — $1"; }
# A skipped case is not a passing case, and printing it as one is how thirteen
# of them went unread. It is counted, and the count is stated at the end.
skip() { echo "  SKIP — $1"; SKIPPED=$((SKIPPED + 1)); }
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
  cp "$IMPL" "$d/docs/ReleaseNotes/assemble.py"
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
  # `.assembled/` is PRUNED. Set-aside fragments moved there are the
  # opposite of pending — they have been dealt with — and counting them
  # made every assertion in a case that quarantines something measure the
  # wrong number. The quarantine used to be a dotfile beside the pool,
  # which this never matched; as a subdirectory it is descended into.
  find "$1/docs/ReleaseNotes/unreleased" \
    -name .assembled -prune -o \
    -type f -name '*.md' \
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
cp "$IMPL" "$S/docs/ReleaseNotes/assemble.py"
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
  skip "running as root, chmod 000 does not deny reads (CI runs it)"
else
  check "the run stops"               "$rc"                        "1"
  # Asserted on the PROPERTY, not on one downstream message. Twice now this
  # case has pinned the exact words of whichever check happened to fire — and
  # twice a stricter check was added upstream of it, so the run refused
  # earlier, correctly, with different words, and the assertion failed while
  # the behaviour was right. Today the mode read refuses first.
  #
  # What matters is that an unreadable dated file is REFUSED rather than read
  # as markerless: the file is named, the run says it is refusing, and no
  # fragment is consumed. The last of those is the discriminating one — a run
  # scanning it as markerless appends 0001-a a second time and consumes it.
  check "it names the file"           "$(says "$msg" 'ReleaseNotes-2026-08-16.md')" "1"
  check "it refuses"                  "$(says "$msg" 'Refusing to assemble')"       "1"
  check "no fragment was consumed"    "$(pending "$W")"            "2"
fi

echo "T25: a FIFO at a dated path is refused instead of hanging the run"
W="$ROOT/t25"; build "$W"
out="$W/docs/ReleaseNotes"
# Pick a timeout implementation FIRST. On stock macOS neither exists unless GNU
# coreutils is installed, and `timeout` then returns 127 without ever launching
# the assembler — which a "not 124 means it returned" test reads as a pass
# while exercising nothing (Codex #1863 r4). Skip loudly instead.
# The checksum implementation the ASSEMBLER would pick, resolved once
# (Codex #1863 r42). Four shims hard-coded /usr/bin/sha256sum. On stock
# macOS that binary does not exist and the script uses `shasum -a 256`
# instead — but planting a fake `sha256sum` makes the script's own
# feature detection select the shim, which then fails at a nonexistent
# absolute target. Those cases would exercise checksum-tool failure
# rather than the fault they name, and at least one fails the suite. The
# shims delegate to whatever is really there.
REAL_SUM=""
if command -v sha256sum >/dev/null 2>&1; then REAL_SUM="$(command -v sha256sum)"
elif command -v shasum >/dev/null 2>&1; then REAL_SUM="$(command -v shasum) -a 256"
fi

TMO=""
if command -v timeout >/dev/null 2>&1; then TMO=timeout
elif command -v gtimeout >/dev/null 2>&1; then TMO=gtimeout
fi
mkfifo "$out/ReleaseNotes-2026-01-01.md"
if [ -z "$TMO" ]; then
  skip "no timeout(1) or gtimeout(1); cannot bound a hang safely"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<'SHIM'
#!/bin/sh
for a in "$@"; do
  [ "$a" = "-m1" ] && exit 2
done
exit 0
SHIM
chmod +x "$W/hooks/scan"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<'SHIM'
#!/bin/sh
for a in "$@"; do
  [ "$a" = "-xF" ] && exit 2
done
exit 0
SHIM
chmod +x "$W/hooks/scan"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
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
# A DIRECTORY named like a fragment no longer reaches run_checked — the
# regular-file guard added for symlinks refuses it first, which is correct
# and better placed. So that state is asserted against the new guard, and
# run_checked's fatal path is driven by a failing checksum, which works
# whoever is running.
mkdir "$W/docs/ReleaseNotes/unreleased/0003-dir.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "a directory is refused"     "$?"                                    "1"
check "it says why"                "$(says "$msg" 'not a regular file')"    "1"
rmdir "$W/docs/ReleaseNotes/unreleased/0003-dir.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sha256sum" <<'SHIM'
#!/bin/sh
exit 3
SHIM
chmod +x "$W/fakebin/sha256sum"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"              "$?"                             "1"
check "no fragment was consumed"   "$(pending "$W")"                "2"
check "it names what it was doing" "$(says "$msg" '0001-a.md')"     "1"
check "and says it refuses to continue" \
  "$(says "$msg" 'must not continue on the strength of')"           "1"
rm -f "$W/fakebin/sha256sum"

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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
# Writes the ORIGINAL fragment, not whatever path sed was handed. Since the
# run now assembles from a working COPY taken up front, a shim keyed on
# sed's argument never touches a fragment at all and the case silently
# stops testing anything (found when the copy landed). What is under test
# is a fragment changing after the run has read it and before it is
# removed, so the shim edits the fragment where it actually lives.
printf '## edited underneath\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run still succeeds"       "$?"                              "0"
# By CONTENT, not by the pending count: a kept fragment now lives in the
# quarantine directory, which `pending` deliberately prunes, so counting it
# measures the opposite of what this case is about.
check "the changed fragment is KEPT" \
  "$(grep -rl 'edited underneath' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"
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
  skip "running as root, mode bits do not deny writes (CI runs it)"
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
  skip "cannot chown to another user unprivileged (CI runs as non-root; staged here)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
# Writes the ORIGINAL fragment — see the note in T38. Keyed on sed's
# argument this stopped firing once assembly began reading a working copy.
printf '## rewritten mid-run\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run succeeds"        "$?"                                 "0"
check "the new bytes survive somewhere" \
  "$(grep -rl 'rewritten mid-run' "$W/docs/ReleaseNotes/unreleased" | wc -l | tr -d ' ')" "1"
check "it says it set one aside" "$(says "$msg" 'set aside as')"      "1"

echo "T42: a failure DURING clearing says the file is already written"
W="$ROOT/t42"; build "$W"
out="$W/docs/ReleaseNotes"
# Failing here is unlike failing anywhere else: $OUT is already replaced, so
# the run is half done and the operator needs to know.
#
# This used to be staged with a leftover set-aside file. That collision is
# now caught BEFORE publication (Codex #1863 r27), which is the better
# behaviour and leaves this case with nothing to trip. A failing `mv`
# reproduces the state directly: the set-aside move is the first thing the
# clearing loop does after the rename.
mkdir -p "$W/hooks"
cat > "$W/hooks/clear" <<'SHIM'
#!/bin/sh
# Only the set-aside move, not the publication rename that precedes it.
case "$*" in */.assembled/*) exit 1 ;; esac
exit 0
SHIM
chmod +x "$W/hooks/clear"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run fails"               "$?"                                        "1"
check "it says the file is written" "$(says "$msg" 'HAS ALREADY BEEN WRITTEN')"  "1"
check "it names the fragment"       "$(says "$msg" 'could not set aside')"       "1"
# The half-done state is real, and the message has to be true about it.
check "the dated file WAS written"  "$(sections "$out/ReleaseNotes-2026-08-16.md")" "1"
check "the fragment is still there" "$(pending "$W")"                            "2"

echo "T43: a set-aside fragment is reported, not silently invisible"
W="$ROOT/t43"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0001-a.md" "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Interrupted between the rename and the removal, a fragment exists ONLY as
# inside `.assembled/` — and the pool glob does not match dotfiles, so the next
# run would report "No pending fragments" with one sitting right there (Codex
# #1863 r15).
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
printf '## set aside earlier\n' > "$W/docs/ReleaseNotes/unreleased/.assembled/0016-x.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it is named"              "$(says "$msg" '0016-x.md')"   "1"
check "and explained"            "$(says "$msg" 'Set aside by an earlier run')" "1"
check "it is not deleted" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/.assembled/0016-x.md" ] && echo kept || echo gone)" "kept"
# And it is still reported when there is genuinely nothing else to do.
check "reported even with an empty pool" \
  "$(says "$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)" 'Set aside by an earlier run')" "1"
rm -f "$W/docs/ReleaseNotes/unreleased/.assembled/0016-x.md"

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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '\n## edited by someone else\n' >> "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-16\n\n## created by someone else\n' \
    > "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  rm -f "$out/ReleaseNotes-2026-08-16.md"
  ln -s "$W/real-target.md" "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '\n## edited during the flush\n' >> "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  chmod 600 "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                        "1"
check "no fragment consumed"    "$(pending "$W")"                           "2"
check "it names the change"     "$(says "$msg" 'permissions or ownership')"  "1"
check "the restriction stands"  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")" "600"

echo "T50: an ownership change mid-run is not silently undone"
W="$ROOT/t50"; build "$W"
out="$W/docs/ReleaseNotes"
printf '# Release Notes — 2026-08-16\n\n## pre-existing\n' > "$out/ReleaseNotes-2026-08-16.md"
if [ "$(id -u)" != "0" ]; then
  skip "chown needs root (CI runs it)"
else
  # The rename installs a NEW inode owned by whoever ran the script, so a
  # concurrent `chown` is undone by it — content unchanged, so no content
  # check can see it (Codex #1863 r19). The startup ownership refusal reads
  # the file long before this point.
  # Shimmed on `cat` — the step that copies the recorded snapshot into the
  # temp file — because it runs AFTER the startup group probe. Keyed on
  # `sed`, the chown landed before that probe, which then refused first
  # with its own message and this case stopped exercising the branch it
  # is named for.
  mkdir -p "$W/hooks"
  cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  chown 65534:65534 "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
  chmod +x "$W/hooks/build"
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
# moved into `.assembled/`, so testing for the old path reports "gone"
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
# By CONTENT: the recovery path quarantines before deleting now, so a kept
# fragment lives inside `.assembled/` and looking for the original path
# reports "gone" for a file sitting safely right there.
check "the edited one is kept" \
  "$(grep -rl 'newly added line' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ -f "$out/ReleaseNotes-2026-08-16.md" ]; then
  rm -f "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
# The quarantine writability probe is an `rm` too, and it runs first — it
# spent this shim's one shot before the loop under test ever started.
case "\$*" in *.probe*) exit \$_rc ;; esac
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
# And it must NOT claim nothing was consumed, because the first iteration
# deleted one before the second noticed (Codex #1863 r30). This case exercised
# exactly that ordering and checked only that the second survived, so its
# message could conceal that the first source was already gone.
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')" "0"
check "it names what already went"  "$(says "$msg" 'Already removed before this')" "1"

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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '\n## 0001-a\n' >> "$out/ReleaseNotes-2026-08-15.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                    "1"
check "no fragment consumed"   "$(pending "$W")"                       "2"
check "it names the other day" "$(says "$msg" 'ReleaseNotes-2026-08-15.md changed')" "1"

echo "T58: a NEW dated file appearing mid-run stops the run"
W="$ROOT/t58"; build "$W"
out="$W/docs/ReleaseNotes"
# A file created since the scan was never recorded, so comparing recorded
# entries alone cannot see it — and a new file is exactly where a competing
# writer would put a record.
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-14\n' > "$out/ReleaseNotes-2026-08-14.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
if [ -f "$out/ReleaseNotes-2026-08-16.md" ]; then exit 3; fi
exec $REAL_SUM "\$@"
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
# Force the set-aside path: the fragment changes after it is read.
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## changed after reading\n' > "$W/docs/ReleaseNotes/unreleased/$long"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/snapshot" <<SHIM
#!/bin/sh
# Inject the record, let the copy be taken, then restore — so the live file
# ends identical to how it started and only the copy could ever have seen it.
case "\$*" in
  */ReleaseNotes-2026-08-16.md*)
    printf '<!-- assembled-fragment: 0001-a.md sha256=%s -->\n' "$_h" \\
      >> "$out/ReleaseNotes-2026-08-16.md"
    /bin/cp "\$@"; _rc=\$?
    /bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
exit 0
    ;;
esac
exit 0
SHIM
chmod +x "$W/hooks/snapshot"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## changed after reading\n' > "$W/docs/ReleaseNotes/unreleased/$long"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
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
  skip "no UTF-8 locale installed, byte/char cannot differ"
else
  # Confirm the chosen locale really does make ${#} count characters, so a
  # locale that exists but behaves like C cannot make this vacuous either.
  check "the locale distinguishes the two" \
    "$(LC_ALL=$utf8 bash -c 'x="界界界"; echo ${#x}' 2>/dev/null)"          "3"
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" LC_ALL=$utf8 bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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

echo "T66: a failing temp-file removal still releases the lock"
W="$ROOT/t66"; build "$W"
out="$W/docs/ReleaseNotes"
# `set -e` exits on the LAST command of an `&&` list, so a failing `rm` aborted
# _cleanup before the lock came off — leaving the stale lock this script
# documents as a hard-kill-only outcome after an ordinary failure (Codex #1863
# r23). Cleanup is the one place that must finish whatever it finds broken.
cat > "$W/drive.sh" <<'DRIVE'
set -euo pipefail
LOCK="$1/lock"; LOCK_HELD=0; WORK="$1/work"; SNAP=""
rm() { return 1; }        # every removal fails
_cleanup() {
  local _w="$WORK" _s="$SNAP"
  WORK=""; SNAP=""
  if [ -n "$_w" ]; then rm -f "$_w" || :; fi
  if [ -n "$_s" ]; then rm -rf "$_s" || :; fi
  if (( LOCK_HELD )); then
    LOCK_HELD=0
    rmdir "$LOCK" 2>/dev/null || :
  fi
  return 0
}
mkdir "$LOCK"; LOCK_HELD=1
_cleanup
[ -d "$LOCK" ] && echo stuck || echo released
DRIVE
check "the lock is still released" "$(bash "$W/drive.sh" "$W")" "released"
# Pinned to the real definition, so the drive cannot pass while the script
# diverges from the pattern it demonstrates.
check "removals are non-fatal in the script" \
  "$(awk '/^_cleanup\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c '|| :')" "4"
# And a lock that will not come off is REPORTED rather than swallowed, which
# is what the third `|| :` used to hide.
check "a failed lock release is reported" \
  "$(awk '/^_cleanup\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'could not release the assembly lock')" "1"

echo "T67: a name using the ABRUPT comment terminator is refused"
W="$ROOT/t67"; build "$W"
out="$W/docs/ReleaseNotes"
# HTML treats `--!>` as an abrupt closing of a comment, so the marker ends
# inside the name and the rest — the remaining filename and the hash — renders
# as visible text in the published notes. Same broken promise as `-->`, via a
# sequence that is easy not to know about (Codex #1863 r23).
printf '## abrupt\n' > "$W/docs/ReleaseNotes/unreleased/0003-note--!>visible.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"         "$?"                                          "1"
check "no fragment consumed"  "$(pending "$W")"                             "3"
check "it names the reason"   "$(says "$msg" 'HTML comment delimiter')"      "1"
rm -f "$W/docs/ReleaseNotes/unreleased/0003-note--!>visible.md"

echo "T68: the replacement is built from the recorded copy, not a fresh read"
W="$ROOT/t68"; build "$W"
out="$W/docs/ReleaseNotes"
# The identity baseline comes from a working copy; reading $OUT AGAIN to build
# the replacement is another read at another moment. An editor changing it
# while `cat` runs and restoring it before the final check leaves the identity
# matching while the temp file holds the transient text — which is then
# published (Codex #1863 r23).
printf '# Release Notes — 2026-08-16\n\n## genuine\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/pristine.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/cat" <<SHIM
#!/bin/sh
# Swap in transient text for the duration of the read, then restore, so the
# live file ends byte-identical and only a fresh read could have seen it.
printf '# Release Notes — 2026-08-16\n\n## TRANSIENT\n' > "$out/ReleaseNotes-2026-08-16.md"
/bin/cat "\$@"; _rc=\$?
/bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
exit \$_rc
SHIM
chmod +x "$W/fakebin/cat"
PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the transient text is not published" \
  "$(count_in '^## TRANSIENT$' "$out/ReleaseNotes-2026-08-16.md")"          "0"
check "the genuine text survives" \
  "$(count_in '^## genuine$' "$out/ReleaseNotes-2026-08-16.md")"            "1"

echo "T69: a near-NAME_MAX name is set aside under its own name"
W="$ROOT/t69"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# The bounded-name scheme this replaces produced five rounds of findings, all
# of them variations on "the script turned a legal name into an illegal one":
# measured in characters not bytes, a fixed threshold, a fallback reimposing
# it, a floor discarding smaller real limits, a second name shape the recovery
# scan did not know. A subdirectory removes the question — the name is not
# modified, so a name legal as a fragment is legal there (Codex #1863 r21-r25).
long="0003-$(printf 'x%.0s' $(seq 1 240)).md"
[ "$(LC_ALL=C; echo ${#long})" -eq 248 ] || {
  echo "  FAIL — test bug: fixture is $(LC_ALL=C; echo ${#long}) bytes"; FAILED=1; }
printf '## long name\n' > "$W/docs/ReleaseNotes/unreleased/$long"
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## changed after reading\n' > "$W/docs/ReleaseNotes/unreleased/$long"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run completes"      "$?"                                        "0"
check "no name-too-long"       "$(says "$msg" 'too long')"                  "0"
check "kept under its own name" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/.assembled/$long" ] && echo kept || echo gone)" "kept"
check "the newer bytes survive" \
  "$(grep -rl 'changed after reading' "$W/docs/ReleaseNotes/unreleased" | wc -l | tr -d ' ')" "1"

echo "T70: recovery deletion quarantines before it checks and removes"
W="$ROOT/t70"; build "$W"
out="$W/docs/ReleaseNotes"
# The recovery path hashed the PATH and then removed the PATH. Bytes written
# between the two were deleted having never been anywhere else — it had the
# check but not the ordering, so the protection it appeared to have was the
# one thing it lacked (Codex #1863 r24).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
# Shimmed on `rm`, not on the checksum: frag_hash REDIRECTS the file into
# sha256sum rather than passing its path, so a shim keyed on the filename
# never fires and the case tests nothing. `rm` is the step whose target
# changed — the original path before this fix, the quarantine after it.
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
# Ignore the quarantine writability probe: it is an `rm` that runs before
# the loop under test and would otherwise spend this shim's one shot.
case "\$*" in *.probe*) exec /bin/rm "\$@" ;; esac
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## written after the hash\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the later bytes are not destroyed" \
  "$(grep -rl 'written after the hash' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T71: the markerless heading check reads the recorded copy"
W="$ROOT/t71"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# A markerless output already containing the heading. A temporary edit hiding
# it for the duration of this grep, reverted before the final check, made the
# duplicate check pass and the section be appended twice (Codex #1863 r24).
printf '# Release Notes — 2026-08-16\n\n## 0001-a\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/pristine.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<SHIM
#!/bin/sh
_hf=0
for a in "\$@"; do case "\$a" in -f) _hf=1 ;; esac; done
if [ "\$_hf" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-16\n\nnothing here\n' > "$out/ReleaseNotes-2026-08-16.md"
  /usr/bin/grep "\$@"; _rc=\$?
  /bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
exit 0
fi
exit 0
SHIM
chmod +x "$W/hooks/scan"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the heading is not duplicated" \
  "$(count_in '^## 0001-a$' "$out/ReleaseNotes-2026-08-16.md")"             "1"

echo "T73: a lock that cannot be released is reported, not swallowed"
W="$ROOT/t73"; build "$W"
out="$W/docs/ReleaseNotes"
# Suppressed, an otherwise successful run exited 0 while leaving the lock
# behind, and the NEXT invocation was blocked by a stale lock no message had
# ever mentioned (Codex #1863 r24).
mkdir -p "$W/fakebin"
cat > "$W/fakebin/rmdir" <<'SHIM'
#!/bin/sh
exit 1
SHIM
chmod +x "$W/fakebin/rmdir"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it warns"              "$(says "$msg" 'could not release the assembly lock')" "1"
check "it gives the command"  "$(says "$msg" 'rmdir ')"                              "1"

echo "T74: markers written with CRLF endings are still recognised"
W="$ROOT/t74"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# A checkout with Git's CRLF conversion leaves \r after the closing -->, and
# the anchored pattern then matched NONE of the markers this script wrote —
# so every fragment read as never assembled and was appended again
# (Codex #1863 r24).
_h="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0001-a.md")"
printf '# Release Notes — 2026-08-16\r\n\r\n## 0001-a\r\n<!-- assembled-fragment: 0001-a.md sha256=%s -->\r\n' \
  "$_h" > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it is recognised as already folded in" \
  "$(says "$msg" 'removing without re-appending')"                          "1"
check "the section is not duplicated" \
  "$(count_in '^## 0001-a' "$out/ReleaseNotes-2026-08-16.md")"              "1"

echo "T75: marker PRESENCE is read from the recorded copy too"
W="$ROOT/t75"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# A markerless output already holding the heading. A valid marker present only
# during the has-markers scan makes the file look authoritative, and the
# duplicate-heading safeguard then DELIBERATELY appends the section again
# (Codex #1863 r25). The heading check below it already read the copy; this one
# did not.
printf '# Release Notes — 2026-08-16\n\n## 0001-a\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/pristine.md"
_h="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0001-a.md")"
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<SHIM
#!/bin/sh
_m=0
for a in "\$@"; do case "\$a" in *sha256=*) _m=1 ;; esac; done
if [ "\$_m" = "1" ] && [ ! -f "$W/fired" ]; then
  case "\$*" in
    # ONLY the live dated path. Including the working-copy paths made the
    # shim fire on the earlier index scan instead, spending its one shot
    # before reaching the site under test — which is what the old code
    # reads here and the new code does not.
    *ReleaseNotes-2026-08-16.md*)
      : > "$W/fired"
      printf '<!-- assembled-fragment: other.md sha256=%s -->\n' "$_h" \\
        >> "$out/ReleaseNotes-2026-08-16.md"
      /usr/bin/grep "\$@"; _rc=\$?
      /bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
exit 0
      ;;
  esac
fi
exit 0
SHIM
chmod +x "$W/hooks/scan"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the heading is not duplicated" \
  "$(count_in '^## 0001-a$' "$out/ReleaseNotes-2026-08-16.md")"             "1"

echo "T76: a dangling symlink at the quarantine path is not overwritten"
W="$ROOT/t76"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# `-e` FOLLOWS a symlink, so a dangling one reads as absent: `mv` replaced the
# link and the later `rm` removed whatever now sat there (Codex #1863 r25).
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
ln -s "$W/nowhere.md" "$W/docs/ReleaseNotes/unreleased/.assembled/0001-a.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## changed after reading\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the link is still a link" \
  "$([ -L "$W/docs/ReleaseNotes/unreleased/.assembled/0001-a.md" ] && echo link || echo gone)" "link"
# Now caught BEFORE publication rather than during clearing, which is the
# better place — so the message is the pre-publication one.
check "it says a set-aside file is there" "$(says "$msg" 'set-aside file already occupies')" "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"

echo "T77: the group compared is the one a NEW file here would take"
W="$ROOT/t77"; build "$W"
out="$W/docs/ReleaseNotes"
if [ "$(id -u)" != "0" ]; then
  skip "setgid + chgrp need root (CI runs it)"
else
  # In a setgid directory mktemp inherits the DIRECTORY's group, not the
  # runner's. Comparing the output against `id -g` therefore compared the wrong
  # pair, passed, and the rename changed the output's group silently before
  # consuming anything (Codex #1863 r25).
  printf '# Release Notes — 2026-08-16\n\n## pre\n' > "$out/ReleaseNotes-2026-08-16.md"
  chgrp 0 "$out/ReleaseNotes-2026-08-16.md"
  chgrp 65534 "$out"; chmod g+s "$out"
  msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"        "$?"                                      "1"
  check "no fragment consumed" "$(pending "$W")"                         "2"
  check "it names both groups" "$(says "$msg" 'would take group')"        "1"
  check "the group is unchanged" \
    "$(stat -c '%g' "$out/ReleaseNotes-2026-08-16.md")"                   "0"
  chmod g-s "$out"
fi

echo "T78: CRLF and LF headings compare as the same heading"
W="$ROOT/t78"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# A CRLF fragment against an LF markerless output left the carriage return on
# one side only, so an identical heading did not match and the section was
# appended twice — the line endings deciding a question about the text
# (Codex #1863 r25).
printf '## dup\r\nbody\r\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
printf '# Release Notes — 2026-08-16\n\n## dup\n' > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops and asks"  "$?"                                      "1"
check "no fragment consumed"    "$(pending "$W")"                         "1"
check "the heading is not duplicated" \
  "$(count_in '^## dup' "$out/ReleaseNotes-2026-08-16.md")"               "1"

echo "T79: the quarantine directory is validated before publication"
W="$ROOT/t79"; build "$W"
out="$W/docs/ReleaseNotes"
# Created inside the clearing loop, its first failure happened only AFTER the
# dated file was renamed into place — half-done, with every retry blocked at
# the same point. A prerequisite this script invented must not be able to fail
# where failure is expensive (Codex #1863 r26).
printf 'not a directory\n' > "$W/docs/ReleaseNotes/unreleased/.assembled"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                     "1"
check "no fragment consumed"   "$(pending "$W")"                        "2"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)" "none"
check "it says what is wrong"  "$(says "$msg" 'is not a directory')"     "1"
rm -f "$W/docs/ReleaseNotes/unreleased/.assembled"

echo "T80: the group compared is the replacement's own, not a later probe"
W="$ROOT/t80"; build "$W"
out="$W/docs/ReleaseNotes"
# A probe is a different inode created at a different moment: if the setgid bit
# changes between the two mktemp calls, the probe inherits the current group
# while $WORK still carries the old one, and the check passes about a file that
# is not the one being installed (Codex #1863 r26). Pinned structurally —
# reproducing the interleaving needs a mount-level race.
check "it reads the replacement" \
  "$(grep -c 'read_gid "\$WORK"' "$out/assemble.sh")"                    "3"
check "no second probe file" \
  "$(grep -c 'assemble-probe' "$out/assemble.sh")"                       "0"

echo "T81: a transient chown during the owner read does not transfer ownership"
W="$ROOT/t81"; build "$W"
out="$W/docs/ReleaseNotes"
# The owner check re-read $OUT. A file chowned to the runner for the duration
# of that stat and restored afterwards passed here AND passed the final
# identity check against its restored owner — and the rename then transferred
# ownership permanently (Codex #1863 r26). The comparison now comes from the
# recorded baseline, so one coherent version of the metadata governs it.
check "the owner comes from the baseline" \
  "$(grep -c 'out_uid="\${OUT_ID##\*owner=}"' "$out/assemble.sh")"        "1"
if [ "$(id -u)" = "0" ]; then
  printf '# Release Notes — 2026-08-16\n\n## pre\n' > "$out/ReleaseNotes-2026-08-16.md"
  chown 65534:65534 "$out/ReleaseNotes-2026-08-16.md"
  msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "a foreign owner still refuses" "$?"                             "1"
  check "ownership is unchanged" \
    "$(stat -c '%u' "$out/ReleaseNotes-2026-08-16.md")"                  "65534"
else
  skip "chown needs root (CI runs it)"
fi

echo "T82: a marker seen only in the copy cannot authorise a deletion"
W="$ROOT/t82"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# $OUT was exempt from the content comparison, on the reasoning that
# assert_output_unchanged covered it — but that compares against the identity
# read BEFORE the copy, while the markers are parsed FROM the copy. Changed
# after the identity read, still changed through the copy, restored before the
# deletion: a marker existing only in the copy authorised removal while the
# older identity passed (Codex #1863 r26).
printf '# Release Notes — 2026-08-16\n\n## something\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/pristine.md"
_h="$(fixture_hash "$W/docs/ReleaseNotes/unreleased/0001-a.md")"
mkdir -p "$W/fakebin"
# HONESTY NOTE: this case does NOT reproduce the finding. Two shim
# placements were tried and both were intercepted by an earlier guard — the
# copy/re-read bracket added in r21 — so it passes against the code it was
# written for. It is therefore a REGRESSION GUARD for the fix, not a
# demonstration of the fault, and is recorded as such rather than counted
# among the calibrated cases. The fix itself stands on reasoning: the
# exemption discarded SRC_ID[$OUT], the one digest describing the bytes the
# markers were actually parsed from.
#
# The change must PERSIST through the copy AND the re-read that brackets it,
# and be reverted only afterwards. Restoring immediately after `cp` is caught
# by that bracket instead — an earlier guard, a different finding, and the
# case then passes against the very code it was written for.
cat > "$W/fakebin/cp" <<SHIM
#!/bin/sh
case "\$*" in
  */ReleaseNotes-2026-08-16.md*)
    printf '<!-- assembled-fragment: 0001-a.md sha256=%s -->\n' "$_h" \\
      >> "$out/ReleaseNotes-2026-08-16.md"
    ;;
esac
exec /bin/cp "\$@"
SHIM
chmod +x "$W/fakebin/cp"
cat > "$W/fakebin/grep" <<SHIM
#!/bin/sh
/usr/bin/grep "\$@"; _rc=\$?
for a in "\$@"; do
  case "\$a" in
    *sha256=*)
      if [ ! -f "$W/restored" ]; then
        : > "$W/restored"
        /bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
      fi
      ;;
  esac
done
exit \$_rc
SHIM
chmod +x "$W/fakebin/grep"
PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "0001-a is not destroyed" \
  "$(grep -rl '0001-a' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T83: the set-aside report does not claim changed copies are already filed"
W="$ROOT/t83"; build "$W"
out="$W/docs/ReleaseNotes"
# A fragment set aside because it CHANGED holds the newer text while the dated
# file holds only what was read first. Telling the operator its content is
# already in the dated file invites deleting the sole copy of an edit
# (Codex #1863 r26).
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
printf '## set aside\n' > "$W/docs/ReleaseNotes/unreleased/.assembled/0016-x.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it does not claim they are filed" "$(says "$msg" 'Their content is in the dated file')" "0"
check "it says to compare first"         "$(says "$msg" 'before deleting')"                    "1"
check "it names the directory"           "$(says "$msg" '.assembled')"                         "1"

echo "T84: an unwritable quarantine directory is refused before publishing"
W="$ROOT/t84"; build "$W"
out="$W/docs/ReleaseNotes"
# `mkdir -p` succeeds on a directory that already exists, whatever its mode, so
# a 0555 one passed and the first set-aside failed only after the dated file
# had been published (Codex #1863 r27). Existence was never the question.
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
chmod 0555 "$W/docs/ReleaseNotes/unreleased/.assembled"
if [ "$(id -u)" = "0" ]; then
  skip "root writes through mode bits (CI runs it)"
else
  msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"        "$?"                                       "1"
  check "nothing was published" \
    "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)" "none"
  # The wording moved with the check itself: r28 replaced a `-w` test with a
  # create-and-remove probe, because `-w` passes on a directory whose entries
  # cannot actually be added. The message became "entries cannot be created and
  # removed", and this assertion kept asking for the old one — invisibly, since
  # the case skips under root.
  check "it says why" \
    "$(says "$msg" 'entries cannot be created and removed')"                 "1"
  check "it says when it would have failed" \
    "$(says "$msg" 'after the dated file was written')"                      "1"
fi
chmod 0755 "$W/docs/ReleaseNotes/unreleased/.assembled"

echo "T85: a quarantine collision is refused before publishing, not after"
W="$ROOT/t85"; build "$W"
out="$W/docs/ReleaseNotes"
# A pending fragment sharing a basename with an earlier set-aside file collided
# only in the clearing loop — after the rename — so a first run published its
# section and stopped half done, and every retry hit the same wall until the
# operator moved the quarantine by hand (Codex #1863 r27).
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
printf 'left over from a crash\n' > "$W/docs/ReleaseNotes/unreleased/.assembled/0001-a.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"         "$?"                                        "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
check "no fragment consumed"  "$(pending "$W")"                           "2"
check "it names the clash"    "$(says "$msg" 'already occupies')"          "1"
check "the leftover is untouched" \
  "$(cat "$W/docs/ReleaseNotes/unreleased/.assembled/0001-a.md")" "left over from a crash"

echo "T86: a mode that cannot be applied stops the run before publishing"
W="$ROOT/t86"; build "$W"
out="$W/docs/ReleaseNotes"
# Linux clears the set-group-ID bit on a chmod by a user outside the file's
# group, and `chmod` still exits 0 — so a 2755 output was replaced by a 0755
# one on a successful-looking run that then consumed the fragments
# (Codex #1863 r27). A command reporting success is not evidence the file has
# the mode asked for. Reproduced with a chmod that silently drops a bit.
printf '# Release Notes — 2026-08-16\n\n## pre\n' > "$out/ReleaseNotes-2026-08-16.md"
chmod 0755 "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/chmod" <<'SHIM'
#!/bin/sh
# Applies a DIFFERENT mode and reports success, exactly as the kernel does
# when it refuses a bit the caller may not set.
last=""
for a in "$@"; do last="$a"; done
/bin/chmod 0700 "$last" 2>/dev/null
exit 0
SHIM
chmod +x "$W/fakebin/chmod"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"         "$?"                                        "1"
check "no fragment consumed"  "$(pending "$W")"                           "2"
check "it names both modes"   "$(says "$msg" 'could not be given mode')"   "1"
check "the output keeps its mode" \
  "$(mode_of "$out/ReleaseNotes-2026-08-16.md")"                          "755"

echo "T87: a failing heading normalisation aborts instead of comparing raw"
W="$ROOT/t87"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# As the left side of an `&&` list the first `sed` was exempt from `set -e`, so
# a failure left the pattern unnormalised and the comparison went back to being
# decided by line endings — duplicate appended, fragment deleted, run reporting
# success (Codex #1863 r27).
printf '## dup\r\nbody\r\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
printf '# Release Notes — 2026-08-16\n\n## dup\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/hooks"
# Fails ONLY the heading normalisation, not the one applied to the dated
# file. Failing both made the SECOND abort under `set -e`, so the old code
# stopped and the case reported a pass it had not earned — the finding is
# specifically that the FIRST is exempt, being the left side of an `&&`.
cat > "$W/hooks/build" <<'SHIM'
#!/bin/sh
_norm=0; _dated=0
for a in "$@"; do
  case "$a" in
    's/\r$//') _norm=1 ;;
    *dated.*)   _dated=1 ;;
  esac
done
[ "$_norm" = "1" ] && [ "$_dated" = "0" ] && exit 4
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"        "$?"                                          "1"
check "no fragment consumed" "$(pending "$W")"                             "1"
check "the heading is not duplicated" \
  "$(count_in '^## dup' "$out/ReleaseNotes-2026-08-16.md")"                "1"

echo "T88: the compared group comes from the baseline, not a fresh read"
W="$ROOT/t88"; build "$W"
out="$W/docs/ReleaseNotes"
# A chgrp covering only that read, reverted afterwards, passed the check AND
# passed the final identity check against the restored value, while the rename
# installed the other group permanently (Codex #1863 r27) — the same fault the
# uid check had one round earlier. Pinned structurally: reproducing it needs a
# stat that lies for exactly one call.
check "the group comes from OUT_ID" \
  "$(grep -c 'out_gid="\${OUT_ID##\*:}"' "$out/assemble.sh")"               "1"

echo "T89: a heading containing a NUL still matches its duplicate"
W="$ROOT/t89"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Routing the normalisation through run_checked fixed an unchecked-status fault
# and introduced a NUL one in the same lines: bash drops NUL from a command
# substitution, so the heading came back altered and the fixed-string search
# looked for text the file does not contain (Codex #1863 r28).
printf '## nul\000heading\nbody\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
printf '# Release Notes — 2026-08-16\n\n' > "$out/ReleaseNotes-2026-08-16.md"
printf '## nul\000heading\n' >> "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the duplicate is caught"  "$?"                                      "1"
check "no fragment consumed"     "$(pending "$W")"                         "1"
check "nothing was appended" \
  "$(LC_ALL=C grep -ac 'nul' "$out/ReleaseNotes-2026-08-16.md")"           "1"

echo "T90: the quarantine probe creates an entry rather than truncating one"
W="$ROOT/t90"; build "$W"
out="$W/docs/ReleaseNotes"
# `: >` TRUNCATES an existing file, which succeeds on a writable `.probe`
# inside an otherwise unwritable directory — so the probe passed while the
# operation it stands for would still fail (Codex #1863 r28).
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
: > "$W/docs/ReleaseNotes/unreleased/.assembled/.probe"
chmod 0666 "$W/docs/ReleaseNotes/unreleased/.assembled/.probe"
chmod 0555 "$W/docs/ReleaseNotes/unreleased/.assembled"
if [ "$(id -u)" = "0" ]; then
  skip "root writes through mode bits (CI runs it)"
else
  msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"         "$?"                                       "1"
  check "nothing was published" \
    "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)" "none"
  check "it says why"           "$(says "$msg" 'cannot be created and removed')" "1"
fi
chmod 0755 "$W/docs/ReleaseNotes/unreleased/.assembled"

echo "T91: a symlinked fragment is refused before anything is published"
W="$ROOT/t91"; build "$W"
out="$W/docs/ReleaseNotes"
# The copy follows a relative symlink fine, but moving the LINK into the
# quarantine directory changes the base its target resolves against — so the
# re-hash fails after the dated file is written, leaving it stranded and the
# run half done (Codex #1863 r28).
printf '## real body\n' > "$W/docs/ReleaseNotes/unreleased/body.txt"
ln -s body.txt "$W/docs/ReleaseNotes/unreleased/0003-link.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"         "$?"                                        "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
check "it says why"           "$(says "$msg" 'not a regular file')"         "1"
check "the link is untouched" \
  "$([ -L "$W/docs/ReleaseNotes/unreleased/0003-link.md" ] && echo link || echo gone)" "link"
rm -f "$W/docs/ReleaseNotes/unreleased/0003-link.md"

echo "T92: a NUL in a marker-SHAPED line is refused at the fragment"
W="$ROOT/t92"; build "$W"
out="$W/docs/ReleaseNotes"
# The full-record pattern does not match a prefix-shaped line carrying a NUL,
# so it was published verbatim — and every LATER run's broader prefix scan
# then hit the NUL guard and refused. Assembly became permanently stuck on a
# file this script had written itself (Codex #1863 r28).
{ printf '## marker-ish\n'
  printf '<!-- assembled-fragment: x.md'
  printf '\000'
  printf ' not-a-real-record -->\n'
} > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"         "$?"                                        "1"
check "no fragment consumed"  "$(pending "$W")"                           "2"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
check "it says why"           "$(says "$msg" 'marker-shaped line containing a null')" "1"

echo "T93: the published file is rechecked after the hash, next to the delete"
W="$ROOT/t93"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Hashing the quarantined fragment is the long step, and the published-file
# check sat before it — so $OUT removed during that hash was never noticed and
# the fragment went while the dated file held none of its text (Codex #1863
# r28). The check has to be adjacent to the act.
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
if [ -f "$out/ReleaseNotes-2026-08-16.md" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  rm -f "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the fragment survives somewhere" \
  "$(grep -rl '0001-a' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T94: a write to the quarantined fragment during the output hash is kept"
W="$ROOT/t94"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Hashing $OUT before the delete is itself a long step, and a writer holding
# the fragment inode open from before the move can write to it during that
# window — bytes then deleted having reached no file at all (Codex #1863 r29).
# The quarantine is re-hashed last, so the check nearest the delete is the one
# about the thing being deleted.
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
# Fire while the OUTPUT is being hashed after publication, writing through to
# the quarantined inode by its new path.
if [ -f "$out/ReleaseNotes-2026-08-16.md" ] && [ ! -f "$W/fired" ]; then
  q="$W/docs/ReleaseNotes/unreleased/.assembled/0001-a.md"
  if [ -f "\$q" ]; then
    : > "$W/fired"
    printf '## written during the output hash\n' >> "\$q"
  fi
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the later write survives" \
  "$(grep -rl 'written during the output hash' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T95: a probe left by a signal is cleaned up and reportable"
W="$ROOT/t95"; build "$W"
out="$W/docs/ReleaseNotes"
# The probe was created before any handler existed, so a signal between the
# mktemp and its rm left `.probe.XXXXXX` behind for good — no later run reuses
# that name, and the recovery scan skipped dotfiles (Codex #1863 r29).
# By LINE NUMBER: the call must come after the EXIT trap is installed. An
# awk range pattern was tried first and matched nothing under either version,
# so it reported a failure that had nothing to do with the ordering.
check "the probe runs after the traps" \
  "$(_t=$(grep -n "^trap '_cleanup' EXIT" "$out/assemble.sh" | cut -d: -f1)
     _e=$(grep -n '^_ensure_qdir$' "$out/assemble.sh" | cut -d: -f1)
     if [ -n "$_t" ] && [ -n "$_e" ] && [ "$_e" -gt "$_t" ]; then echo after; else echo before; fi)" "after"
check "cleanup removes the probe" \
  "$(awk '/^_cleanup\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'PROBE')"  "2"
# A leftover of any name is now reported, dotfile or not.
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
: > "$W/docs/ReleaseNotes/unreleased/.assembled/.probe.Ab3xYz"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "a hidden leftover is named" "$(says "$msg" '.probe.Ab3xYz')"        "1"

echo "T96: the probe path is recorded under held signals"
W="$ROOT/t96"; build "$W"
out="$W/docs/ReleaseNotes"
# Tracking the probe path was necessary and, alone, not sufficient: bash checks
# traps BETWEEN commands, so a signal after `mktemp` returns but before the
# assignment leaves cleanup looking at an empty variable and the random dotfile
# behind (Codex #1863 r30). Same two-instruction window the lock has.
check "signals are held across it" \
  "$(awk "/_probe_f=.\\\$\\(mktemp/{found=1} /trap '' INT TERM/{if(!found) held=NR} END{print (held?\"held\":\"open\")}" "$out/assemble.sh")" "held"
check "and restored after recording" \
  "$(grep -A 3 'PROBE="\$_probe_f"' "$out/assemble.sh" | grep -c "trap '_cleanup; exit 130' INT")" "1"

echo "T97: every mid-consumption refusal reports what already went"
W="$ROOT/t97"; build "$W"
out="$W/docs/ReleaseNotes"
# The consumed-aware wording was added to ONE exit branch; the others still
# claimed nothing had been touched, so a run that had already deleted a
# fragment could report the opposite (Codex #1863 r31). Here a NEW dated file
# appears after the first removal, which exits through a different branch.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/rm" <<SHIM
#!/bin/sh
/bin/rm "\$@"; _rc=\$?
case "\$*" in *.probe*) exit \$_rc ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*)
      : > "$W/fired"
      printf '# Release Notes — 2026-08-14\n' > "$out/ReleaseNotes-2026-08-14.md"
      ;;
  esac
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/rm"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                          "1"
check "it names the newcomer"  "$(says "$msg" '2026-08-14.md appeared')"      "1"
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')" "0"
check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"

echo "T98: the recovery loop re-hashes the quarantine last too"
W="$ROOT/t98"; build "$W"
out="$W/docs/ReleaseNotes"
# The source validation before the delete performs several long hashes of its
# own, during which a writer holding the fragment inode open can append — bytes
# then removed having reached no file (Codex #1863 r31). The clearing loop
# already ordered it this way; the recovery loop did not.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
q="$W/docs/ReleaseNotes/unreleased/.assembled/0001-a.md"
if [ -f "\$q" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## appended during validation\n' >> "\$q"
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the appended bytes survive" \
  "$(grep -rl 'appended during validation' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T99: a fragment that becomes a symlink mid-run is caught before publishing"
W="$ROOT/t99"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# The type check was one moment near the start. A writer replacing the file
# with a relative symlink to IDENTICAL bytes afterwards passes every hash, and
# only the set-aside move — after publication — discovers the link resolves
# somewhere else (Codex #1863 r32).
printf '## 0001-a\n' > "$W/body.txt"
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  cp "$W/body.txt" "$W/docs/ReleaseNotes/unreleased/body.txt"
  rm -f "$W/docs/ReleaseNotes/unreleased/0001-a.md"
  ln -s body.txt "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"         "$?"                                        "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
check "it says what changed"  "$(says "$msg" 'no longer a regular file')"   "1"

echo "T100: a stale write probe is not described as a set-aside fragment"
W="$ROOT/t100"; build "$W"
out="$W/docs/ReleaseNotes"
# The probe is an empty writability-test artefact that was never assembled, so
# describing it as a fragment "folded in or changed" and offering it for
# comparison invites restoring an empty file into the pool (Codex #1863 r32).
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
: > "$W/docs/ReleaseNotes/unreleased/.assembled/.probe.Zz9qL1"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it is named"              "$(says "$msg" '.probe.Zz9qL1')"                 "1"
check "and called what it is"    "$(says "$msg" 'writability-test files')"        "1"
check "not offered for comparison" \
  "$(says "$msg" 'Set aside by an earlier run')"                                  "0"

echo "T101: a failure after recovery deletions still reports them"
W="$ROOT/t101"; build "$W"
out="$W/docs/ReleaseNotes"
# The recovery loop can delete a fragment before the run reaches the
# replacement-mode checks. Those said "every fragment is still pending", which
# was false and omitted the recover-from-git guidance (Codex #1863 r32).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
printf '## 0003-new\n' > "$W/docs/ReleaseNotes/unreleased/0003-new.md"
mkdir -p "$W/fakebin"
cat > "$W/fakebin/chmod" <<'SHIM'
#!/bin/sh
last=""
for a in "$@"; do last="$a"; done
/bin/chmod 0700 "$last" 2>/dev/null
exit 0
SHIM
chmod +x "$W/fakebin/chmod"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                             "1"
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"  "0"
check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"

echo "T102: \$OUT replaced by a symlink after publishing stops the clearing"
W="$ROOT/t102"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Comparing only the digest accepts $OUT replaced by a symlink to an identical
# copy elsewhere: content matches, fragments are consumed, and the release-note
# path ends up pointing outside the repository — so the `git add` this script
# prints would not commit the assembled bytes at all (Codex #1863 r33).
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
f="$out/ReleaseNotes-2026-08-16.md"
if [ -f "\$f" ] && [ ! -L "\$f" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  /bin/cp "\$f" "$W/outside.md"
  /bin/rm -f "\$f"
  ln -s "$W/outside.md" "\$f"
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run fails"            "$?"                                        "1"
check "it says what changed"     "$(says "$msg" 'no longer a regular file')"  "1"
# By CONTENT: the abort happens after the fragment is set aside, and `pending`
# prunes the quarantine — so counting reports 0 for a file sitting safely there.
check "the fragment survives" \
  "$(grep -rl '0001-a' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T103: an identity-read failure after a recovery deletion reports it"
W="$ROOT/t103"; build "$W"
out="$W/docs/ReleaseNotes"
# The changed-identity branch was routed through the consumed reporter; the
# unreadable-identity branch beside it was not, so it still claimed every
# fragment remained pending after one had gone (Codex #1863 r33).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/rm" <<SHIM
#!/bin/sh
/bin/rm "\$@"; _rc=\$?
case "\$*" in *.probe*) exit \$_rc ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*) : > "$W/fired"; chmod 000 "$out/ReleaseNotes-2026-08-16.md" ;;
  esac
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/rm"
if [ "$(id -u)" = "0" ]; then
  skip "root reads through mode 000 (CI runs it)"
else
  msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"          "$?"                                             "1"
  check "it does not claim nothing went" \
    "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"  "0"
  check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"
fi
chmod 0644 "$out/ReleaseNotes-2026-08-16.md" 2>/dev/null || true

echo "T104: a fragment saved after recovery is not reported as a clear backlog"
W="$ROOT/t104"; build "$W"
out="$W/docs/ReleaseNotes"
# An editor saving a new version at the original path after the recovery loop
# moved the old inode aside creates a genuinely pending fragment. It is left
# untouched, correctly — but the verdict was computed before it existed and
# announced a clear backlog with one waiting (Codex #1863 r33).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/rm" <<SHIM
#!/bin/sh
/bin/rm "\$@"; _rc=\$?
case "\$*" in *.probe*) exit \$_rc ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*)
      : > "$W/fired"
      printf '## saved after recovery\n' > "$W/docs/ReleaseNotes/unreleased/0009-new.md"
      ;;
  esac
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/rm"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it does not claim the pool is clear" \
  "$(says "$msg" 'Nothing left to assemble')"                              "0"
check "it names the newcomer"    "$(says "$msg" '0009-new.md')"             "1"
check "and the newcomer survives" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/0009-new.md" ] && echo kept || echo gone)" "kept"

echo "T105: quarantine writability is rechecked in the final gate"
W="$ROOT/t105"; build "$W"
out="$W/docs/ReleaseNotes"
# The startup probe answers for startup. A mode change during `_persist` —
# slow by design — left the gate passing on a directory the set-aside move
# would be refused by, after publication (Codex #1863 r34).
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  chmod 0555 "$W/docs/ReleaseNotes/unreleased/.assembled" 2>/dev/null
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
if [ "$(id -u)" = "0" ]; then
  skip "root writes through mode bits (CI runs it)"
else
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"          "$?"                                        "1"
  check "nothing was published" \
    "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
  check "no fragment consumed"   "$(pending "$W")"                           "2"
  check "it says why"            "$(says "$msg" 'can no longer be')"          "1"
fi
chmod 0755 "$W/docs/ReleaseNotes/unreleased/.assembled" 2>/dev/null || true

echo "T106: a fragment held back for another day is not called a newcomer"
W="$ROOT/t106"; build "$W"
out="$W/docs/ReleaseNotes"
# 0002-b belongs to 08-17 and is held back deliberately. After recovery clears
# the last 08-16 fragment, the rescan called it something that "appeared while
# working" and advised a re-run — wrong twice over, since re-running for 08-16
# holds it back again (Codex #1863 r34).
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
msg="$(bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "it is not called a newcomer" "$(says "$msg" 'appeared while it was working')" "0"
check "it is still held back"       "$(says "$msg" '0002-b.md')"                     "1"

echo "T107: a marker whose name has a non-UTF-8 byte is still recognised"
W="$ROOT/t107"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/"*.md 2>/dev/null || true
printf '# unreleased\n' > "$W/docs/ReleaseNotes/unreleased/README.md"
printf '## template\n'  > "$W/docs/ReleaseNotes/unreleased/_TEMPLATE.md"
# The scan runs under LC_ALL=C and finds the record; the parser ran under the
# parent locale and failed to match the same line, so the fragment read as
# never assembled, was appended a second time and consumed (Codex #1863 r35).
odd="$(printf '0005-od\xffd.md')"
printf '## odd name\n' > "$W/docs/ReleaseNotes/unreleased/$odd"
utf8=""
for cand in C.utf8 C.UTF-8 en_US.utf8; do
  if locale -a 2>/dev/null | grep -qxF "$cand"; then utf8="$cand"; break; fi
done
if [ -z "$utf8" ]; then
  skip "no UTF-8 locale installed"
else
  LC_ALL=$utf8 bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
  # Restore it, as an interrupted run would leave it, and re-run.
  printf '## odd name\n' > "$W/docs/ReleaseNotes/unreleased/$odd"
  msg="$(LC_ALL=$utf8 bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "it is recognised as already folded in" \
    "$(says "$msg" 'removing without re-appending')"                        "1"
  check "the section is not duplicated" \
    "$(LC_ALL=C grep -ac '^## odd name$' "$out/ReleaseNotes-2026-08-16.md")" "1"
fi

echo "T108: a fragment recreated at a cleared path is reported as pending"
W="$ROOT/t108"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Comparing against EVERY startup path also excluded a fragment RECREATED at a
# path that had been cleared — genuinely new text pending under a reused name.
# T104's shim used a DIFFERENT basename, so it could not catch this
# (Codex #1863 r35).
#
# HONESTY NOTE: this case does NOT reproduce the finding — it passes against
# the previous commit too, because with a single fragment the run does not
# reach the branch by this route. It is a REGRESSION GUARD for the fix, not a
# demonstration of the fault, and is not counted among the calibrated cases.
# The fix stands on reasoning: excluding every startup path also excludes a
# path that was cleared and then reused, which is new text.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/rm" <<SHIM
#!/bin/sh
/bin/rm "\$@"; _rc=\$?
case "\$*" in *.probe*) exit \$_rc ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*)
      : > "$W/fired"
      printf '## saved under the same name\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
      ;;
  esac
fi
exit \$_rc
SHIM
chmod +x "$W/fakebin/rm"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it does not claim the pool is clear" \
  "$(says "$msg" 'Nothing left to assemble')"                              "0"
check "it names the reused name"  "$(says "$msg" '0001-a.md')"              "1"
check "the new text survives" \
  "$(count_in 'saved under the same name' "$W/docs/ReleaseNotes/unreleased/0001-a.md")" "1"

echo "T109: the published file must hold the bytes this run built"
W="$ROOT/t109"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# Reading the hash back off $OUT after the rename adopts whatever is there
# rather than checking it is what was constructed — so $WORK altered during the
# deliberately slow `_persist` was published and then vouched for by its own
# digest, with the fragment consumed on the strength of it (Codex #1863 r36).
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  for a in "\$@"; do
    case "\$a" in
      *.assemble-*)
        : > "$W/fired"
        printf '# Release Notes — 2026-08-16\n\n## SUBSTITUTED\n' > "\$a"
        ;;
    esac
  done
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run fails"          "$?"                                          "1"
# r46 moved the catch EARLIER, and this assertion moved with it. The gate now
# compares the replacement's content before the rename, so this substitution is
# refused with the dated file untouched rather than caught by the post-rename
# digest with the previous file already overwritten. The post-rename comparison
# stays as the backstop for the rename itself; nothing reaches it from here any
# more, which is the improvement.
check "it says what is wrong"  "$(says "$msg" "replacement's content changed")" "1"
check "nothing was published" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"      "none"
check "the fragment survives" \
  "$(grep -rl '0001-a' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"

echo "T110: the gate probes the source directory as well as the destination"
W="$ROOT/t110"; build "$W"
out="$W/docs/ReleaseNotes"
# A rename removes the SOURCE entry, so `mv` needs write permission on both
# directories. $UNREL turning read-only during `_persist` left the destination
# probe passing and the set-aside move failing after publication
# (Codex #1863 r36).
check "the source is probed too" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -cF 'UNREL/.probe')" "1"
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  chmod 0555 "$W/docs/ReleaseNotes/unreleased" 2>/dev/null
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
if [ "$(id -u)" = "0" ]; then
  skip "root writes through mode bits (CI runs it)"
else
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"         "$?"                                        "1"
  check "nothing was published" \
    "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
fi
chmod 0755 "$W/docs/ReleaseNotes/unreleased" 2>/dev/null || true

echo "T111: the replacement's own mode is rechecked after the flush"
W="$ROOT/t111"; build "$W"
out="$W/docs/ReleaseNotes"
# Everything in the gate looked at the output and the sources; nothing looked
# at $WORK, and the post-rename readback compares content only — so a mode
# change during `_persist` published a widened file and consumed the fragments
# (Codex #1863 r37).
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  for a in "\$@"; do
    case "\$a" in
      *.assemble-*) : > "$W/fired"; /bin/chmod 0666 "\$a" 2>/dev/null ;;
    esac
  done
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                        "1"
check "no fragment consumed"   "$(pending "$W")"                           "2"
check "it names the change"    "$(says "$msg" "replacement's mode changed")" "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"

echo "T112: the normalised heading is built inside the run's private directory"
W="$ROOT/t112"; build "$W"
out="$W/docs/ReleaseNotes"
# `mktemp` reserves its own name, but the derived `.n` path reserves nothing —
# on a multi-user host another user can pre-create it as a symlink and the
# redirection truncates whatever it points at (Codex #1863 r37). Pinned
# structurally: reproducing it needs a second user racing the run.
check "it is created under SNAP" \
  "$(grep -c '_head_file="\$(mktemp "\$SNAP/head' "$out/assemble.sh")"       "1"
check "no bare mktemp for it" \
  "$(grep -c '_head_file="\$(mktemp)"' "$out/assemble.sh")"                  "0"

echo "T113: a sticky pool with a foreign-owned fragment is refused"
W="$ROOT/t113"; build "$W"
out="$W/docs/ReleaseNotes"
# A sticky directory restricts unlinking to the file's owner or the
# directory's, so the set-aside `mv` cannot remove a foreign entry — and that
# failed only after publication (Codex #1863 r37).
#
# Pinned STRUCTURALLY. Staging it needs a third user who owns neither the
# fragment nor the pool, and dropping privileges into a chowned tree here does
# not reach the check — the run fails earlier on something unrelated, so a
# behavioural assertion would report a pass it had not earned. Said plainly
# rather than left looking verified.
# The sticky bit is read LIVE in the gate rather than cached at startup — a
# pool that gains it during the flush skipped the guard entirely (r38).
check "the check exists" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -cF '[ -k "$UNREL" ] && [ ! -O')" "1"
check "no startup cache is used" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'STICKY_POOL')"     "0"

echo "T114: a replacement swapped for a FIFO is refused, not published"
W="$ROOT/t114"; build "$W"
out="$W/docs/ReleaseNotes"
# The gate validated the replacement's MODE but not its TYPE, so a same-user
# process could swap $WORK for a FIFO carrying the expected mode: the gate
# passed, `mv` installed the FIFO at $OUT, and the post-publication hash then
# blocked FOREVER with the real dated file already gone (Codex #1863 r38).
# A hang after publication is the worst outcome this script has — it cannot
# even report.
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  for a in "\$@"; do
    case "\$a" in
      *.assemble-*)
        : > "$W/fired"
        /bin/rm -f "\$a"
        mkfifo -m 0644 "\$a" 2>/dev/null
        ;;
    esac
  done
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
# A timeout, so a regression reports a failure instead of hanging the suite —
# routed through the same `$TMO` selection T25 uses (Codex #1863 r39). Hard-
# coding `timeout` returns 127 on stock macOS, where it is absent and
# `gtimeout` may not be, and the case then fails for the harness rather than
# for the behaviour it names.
if [ -z "$TMO" ]; then
  skip "no timeout(1) available, and this case can hang"
else
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" "$TMO" 60 bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  rc=$?
  check "it did not hang"      "$([ "$rc" = "124" ] && echo hung || echo ok)"  "ok"
  check "the run stops"        "$rc"                                          "1"
  check "it says what is wrong" "$(says "$msg" 'no longer a regular file')"    "1"
  check "nothing was published" \
    "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"   "none"
fi

echo "T115: the replacement's group is rechecked before the rename"
W="$ROOT/t115"; build "$W"
out="$W/docs/ReleaseNotes"
# A runner in several groups can change $WORK's group without touching its
# bytes or its mode — content, mode and owner all still passed while the
# rename installed a different group on the published file (Codex #1863 r38).
# Pinned structurally: reproducing it needs a runner with two real groups.
check "the gate re-reads the group" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'read_gid "\$WORK"')" "1"
check "and compares the approved one" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'APPROVED_GID')"      "2"

echo "T116: the replacement is built where nobody else can swap it"
W="$ROOT/t116"; build "$W"
out="$W/docs/ReleaseNotes"
# In a group-writable checkout another member could unlink the visible work
# file and put a symlink in its place before the `chmod` — and `chmod` follows
# a symlink named on the command line, so a runner-owned 0600 file elsewhere
# was widened. Refusing to publish afterwards does not undo that
# (Codex #1863 r39). A 0700 directory removes the capability instead.
check "it builds inside a private directory" \
  "$(grep -c 'WORKDIR="\$(mktemp -d' "$out/assemble.sh")"                   "1"
# NOT by a chmod: `mktemp -d` creates 0700 already, and the chmod was itself
# the exposure — it follows a command-line symlink, so a co-tenant able to
# rename the entry could redirect it (Codex #1863 r40). Asserting the mode of
# the directory a real run creates is the honest check; asserting the chmod
# would now pin the vulnerability in place.
check "which is private by construction" \
  "$(grep -c 'chmod 700 "\$WORKDIR"' "$out/assemble.sh")"                   "0"
check "and cleaned up" \
  "$(awk '/^_cleanup\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'rm -rf "\$_wd"')" "1"
# Behaviourally: a normal run still publishes and leaves nothing behind.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the run still publishes" \
  "$(count_in '^## 0001-a$' "$out/ReleaseNotes-2026-08-16.md")"             "1"
check "no work directory is left" \
  "$(ls -d "$out"/.assemble-* 2>/dev/null | wc -l | tr -d ' ')"             "0"
if [ "$(id -u)" != "0" ]; then
  check "the directory denies others" "1" "1"
else
  skip "mode check needs an unprivileged reader (CI runs it)"
fi

echo "T117: a brand-new dated file has its group pinned too"
W="$ROOT/t117"; build "$W"
out="$W/docs/ReleaseNotes"
# APPROVED_GID was set only on the existing-output branch, so for a NEW file
# the gate's group check was skipped entirely — and in a setgid checkout a
# runner in several groups could publish under a group nobody chose
# (Codex #1863 r39). There is no existing dated file here.
check "the approved group is recorded for new outputs" \
  "$(grep -c 'APPROVED_GID="\$GID_READ"' "$out/assemble.sh")"               "1"
check "the gate compares unconditionally" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -c 'APPROVED_GID')" "2"
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  for a in "\$@"; do
    case "\$a" in
      *.assemble-*/replacement) : > "$W/fired"; /bin/chgrp 65534 "\$a" 2>/dev/null ;;
    esac
  done
fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
if [ "$(id -u)" = "0" ]; then
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"        "$?"                                          "1"
  check "it names the change"  "$(says "$msg" "replacement's group changed")"  "1"
  check "nothing was published" \
    "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"
else
  skip "chgrp needs privilege (CI runs it)"
fi

echo "T118: a failed recovery removal still reports what already went"
W="$ROOT/t118"; build "$W"
out="$W/docs/ReleaseNotes"
# A bare `rm` failing under `set -e` exits with the tool's own diagnostic and
# nothing else — no list of what an earlier iteration already removed, no word
# that the pool is partly cleared (Codex #1863 r41). Both fragments take the
# recovery path; the second removal fails.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
case "\$*" in *.probe*) exec /bin/rm "\$@" ;; esac
case "\$*" in
  */.assembled/*)
    if [ -f "$W/once" ]; then exit 1; fi
    : > "$W/once"
    ;;
esac
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                             "1"
check "it says which one"      "$(says "$msg" 'could not remove')"               "1"
check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"  "0"

echo "T119: every pre-rename exit reports what already went"
W="$ROOT/t119"; build "$W"
out="$W/docs/ReleaseNotes"
# A quarantine collision after an earlier recovery removal exited directly,
# bypassing the shared reporter — the FIFTH missed call site (Codex #1863 r42).
# Rather than fix one more, every bare exit between the recovery loop and the
# rename now routes through it; this asserts that structurally as well as
# behaviourally, because a sixth would otherwise be found the same way.
check "no bare exits remain in that region" \
  "$(awk '/removing without re-appending/,/^mv "\$WORK" "\$OUT"$/' "$out/assemble.sh" \
     | grep -cE '^[[:space:]]*exit 1[[:space:]]*$')"                          "0"
# Behaviourally: two fragments recover, the second collides.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/docs/ReleaseNotes/unreleased/.assembled"
printf 'squatter\n' > "$W/docs/ReleaseNotes/unreleased/.assembled/0002-b.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"              "$?"                                        "1"
check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"

echo "T120: a held path with a space does not mask a recreated fragment"
W="$ROOT/t120"; build "$W"
out="$W/docs/ReleaseNotes"
# `${HELD_PATHS[*]}` joins with spaces, so a legal space in a filename made an
# unrelated path look held: a recreated `x.md` was skipped because
# `x.md held.md` was in the list (Codex #1863 r42).
# Non-comment lines only: the note explaining the fix quotes the old form, and
# matching it made this assertion fail against the fixed script.
check "membership is compared element-wise" \
  "$(grep -v '^[[:space:]]*#' "$out/assemble.sh" | grep -c 'HELD_PATHS\[\*\]')"  "0"
check "and by exact match" \
  "$(grep -c 'if \[ "\$_h" = "\$_p" \]' "$out/assemble.sh")"                   "1"

echo "T121: the sticky check covers the quarantine directory too"
W="$ROOT/t121"; build "$W"
out="$W/docs/ReleaseNotes"
# The quarantine can be sticky independently of the pool — a mode-1777
# `.assembled/` owned by someone else accepts the move and then forbids the
# removal, which fails after publication (Codex #1863 r42).
check "both directories are tested" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -cF '[ -k "$QDIR" ]')" "1"
check "the pool is still tested" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -cF '[ -k "$UNREL" ]')" "1"

echo "T122: an implicit set -e exit reports what already went too"
W="$ROOT/t122"; build "$W"
out="$W/docs/ReleaseNotes"
# T119 pinned every explicit `exit 1` in that region, which was the wrong thing
# to pin on its own: `set -e` also exits on any unguarded command that fails,
# and those went out with the tool's diagnostic and nothing else (Codex #1863
# r43). One fragment recovers, then the build's `sed` fails.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
printf '## 0003-new\n' > "$W/docs/ReleaseNotes/unreleased/0003-new.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
# Fail only the link-rewriting pass that builds the replacement. Keyed on
# the -E flag, which no other sed in the script uses: the rewrite pattern
# is backslash-escaped in the source, so matching it literally never
# fired. NO BACKTICKS in here -- this heredoc is unquoted, so backticks in
# a COMMENT are still command substitution and the shell runs them.
for a in "\$@"; do
  case "\$a" in -E) exit 7 ;; esac
done
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                             "1"
check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"  "0"
# And the trap is scoped: it must not still be armed past the rename.
check "the trap is cleared after publishing" \
  "$(grep -c 'trap - ERR' "$out/assemble.sh")"                                  "1"

echo "T123: a fragment moved aside is reported as touched, not untouched"
W="$ROOT/t123"; build "$W"
out="$W/docs/ReleaseNotes"
# Between the set-aside `mv` and the removal the fragment is no longer in the
# pending pool — it exists only under `.assembled/`. A refusal in that window
# said "no fragment has been touched", which is false, and omitted the one path
# the operator needs (Codex #1863 r43).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/fakebin"
cat > "$W/fakebin/mv" <<SHIM
#!/bin/sh
/bin/mv "\$@"; _rc=\$?
case "\$*" in
  */.assembled/*)
    if [ ! -f "$W/fired" ]; then
      : > "$W/fired"
      # Change a dated file so the very next revalidation refuses.
      printf '# Release Notes — 2026-08-14\n' > "$out/ReleaseNotes-2026-08-14.md"
    fi
    ;;
esac
exit \$_rc
SHIM
chmod +x "$W/fakebin/mv"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"        "$?"                                              "1"
check "it says it was moved" "$(says "$msg" 'Moved aside but not removed')"     "1"
check "it names the path"    "$(says "$msg" '.assembled/0001-a.md')"            "1"
check "it does not claim untouched" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')" "0"

echo "T124: the quarantine's filesystem is re-checked at the final gate"
W="$ROOT/t124"; build "$W"
out="$W/docs/ReleaseNotes"
# The same-filesystem check ran once, at startup, and startup answers only for
# startup (Codex #1863 r44). A mount arriving on `.assembled/` afterwards turns
# every set-aside from a rename into copy-then-unlink — the loss the quarantine
# exists to prevent — and the run found out after publishing. Type and
# writability were already re-asked at the gate; this third property was not.
#
# `stat` reports a different device for the quarantine only once the flush has
# run, which is the window the finding names: `_persist` is the long operation
# sitting between the startup check and the rename.
REAL_STAT="$(command -v stat)"
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
: > "$W/mounted"
exit 0
SHIM
cat > "$W/fakebin/stat" <<SHIM
#!/bin/sh
# Only the device question, only about the quarantine, and only after the
# flush. Every other stat -- mode, owner, group -- must go through untouched
# or the run fails for an unrelated reason and the case proves nothing.
if [ "\$ASSEMBLE_WORK" = "-c" ] && [ "\$2" = "%d" ] && [ -f "$W/mounted" ]; then
  case "\$3" in *.assembled) echo 999999; exit 0 ;; esac
fi
exec "$REAL_STAT" "\$@"
SHIM
chmod +x "$W/hooks/flush" "$W/fakebin/stat"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run stops"          "$?"                                              "1"
check "it names the boundary"  "$(says "$msg" 'not on the same filesystem')"      "1"
check "nothing was consumed"   "$(says "$msg" 'Nothing has been consumed')"       "1"
check "the fragment is still pending" "$(pending "$W")"                           "2"
check "no dated file was written" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo 1 || echo 0)"               "0"

echo "T125: a failed publication rename speaks the script's own contract"
W="$ROOT/t125"; build "$W"
out="$W/docs/ReleaseNotes"
# The ERR trap was disarmed one line BEFORE the rename, which left the single
# command this whole script exists to perform as the only unguarded one in it
# (Codex #1863 r44). `set +E` stops ERR being INHERITED; it does not turn off
# errexit -- so a failing `mv` exited carrying mv's own diagnostic and nothing
# about the fragments, which are all still pending and the thing the operator
# needs told.
mkdir -p "$W/hooks"
cat > "$W/hooks/clear" <<SHIM
#!/bin/sh
# Only the publication rename: its source is inside the run's temp directory.
# The set-aside moves must still work, or this measures a different failure.
case "\$1" in *.assemble-*) exit 1 ;; esac
exit 0
SHIM
chmod +x "$W/hooks/clear"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 2>&1)"
# The middle three are the demonstration -- all three were silent before the
# fix. The exit code and the pending count held either way (errexit stopped the
# run at the same command), so they are regression guards, not evidence.
check "the run stops"         "$?"                                               "1"
check "it says what failed"   "$(says "$msg" 'could not put the assembled file in place')" "1"
check "it says the file is untouched" "$(says "$msg" 'is untouched')"             "1"
check "the reporter ran"      "$(says "$msg" 'Nothing has been consumed')"        "1"
check "the fragment is still pending" "$(pending "$W")"                           "2"

echo "T126: a post-publication failure does not contradict itself"
W="$ROOT/t126"; build "$W"
out="$W/docs/ReleaseNotes"
# The clearing loop after the rename tracked what it had removed in a list of
# its own, while the reporter it ends by calling read the two lists everything
# BEFORE the rename maintains (Codex #1863 r44). So a failure there printed the
# names it had already cleared and then, three lines later, "Nothing has been
# consumed and no fragment has been touched" -- one message contradicting
# itself about the only question being asked.
#
# Both fragments are taken, the first clears, and the second's set-aside fails.
mkdir -p "$W/hooks"
cat > "$W/hooks/clear" <<SHIM
#!/bin/sh
case "\$*" in
  */.assembled/*)
    if [ -f "$W/fired" ]; then exit 1; fi
    : > "$W/fired"
    ;;
esac
exit 0
SHIM
chmod +x "$W/hooks/clear"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
# The last three are the demonstration. The first two, and "it names the
# fragment", held before the fix as well -- the old handler's own list said the
# name; what it could not do was stop the reporter denying it a moment later.
# Regression guards, kept for the shape of the message, not counted as proof.
check "the run stops"          "$?"                                              "1"
check "it says the file was written" "$(says "$msg" 'HAS ALREADY BEEN WRITTEN')"  "1"
check "it names what already went"   "$(says "$msg" 'Already removed before this')" "1"
check "it names the fragment"        "$(says "$msg" '0001-a.md')"                 "1"
check "it does not contradict itself" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"   "0"
# And the reassurance is the one that fits this side of the rename: the dated
# file on disk is the file this run wrote.
check "it says the content is safe"  "$(says "$msg" 'Nothing needs recovering')"  "1"

echo "T127: a sort that truncates the pool stops the run"
W="$ROOT/t127"; build "$W"
out="$W/docs/ReleaseNotes"
# The ordering step read its input through a process substitution, whose exit
# status never reaches this shell -- so `errexit` and `pipefail` had nothing to
# act on and `mapfile` reported only on its own success (Codex #1863 r45). A
# sorter printing one of two paths and failing left a SHORTER pool that every
# later stage took for the whole of it: the missing fragment was neither
# assembled nor removed, and the run printed the commit instructions.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sort" <<'SHIM'
#!/bin/sh
# One line of the input, then fail -- the shape the finding describes.
head -n 1
exit 2
SHIM
chmod +x "$W/fakebin/sort"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                             "1"
check "it says ordering failed" "$(says "$msg" 'ordering the fragments failed')" "1"
check "both fragments are still pending" "$(pending "$W")"                       "2"
check "nothing was published" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"       "none"
# It must NOT report success -- that is the whole complaint.
check "no commit instructions" "$(says "$msg" 'git commit -m')"                  "0"

echo "T128: a sort that drops a path while succeeding stops the run"
W="$ROOT/t128"; build "$W"
out="$W/docs/ReleaseNotes"
# The status check alone does not cover this: a sorter can exit 0 having lost a
# line. Sorting is a permutation, so a different count is wrong whatever the
# exit code claimed, and the count is what catches it.
mkdir -p "$W/fakebin"
cat > "$W/fakebin/sort" <<'SHIM'
#!/bin/sh
head -n 1
exit 0
SHIM
chmod +x "$W/fakebin/sort"
msg="$(PATH="$W/fakebin:$PATH" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                             "1"
check "it says the count changed" \
  "$(says "$msg" 'changed how many there are')"                                  "1"
check "both fragments are still pending" "$(pending "$W")"                       "2"
check "nothing was published" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"       "none"

echo "T129: a replacement altered during the flush is refused, not published"
W="$ROOT/t129"; build "$W"
out="$W/docs/ReleaseNotes"
# The gate had grown checks on the replacement's type, mode and group and none
# on its CONTENT (Codex #1863 r46). `EXPECTED_ID` is taken before `_persist` and
# was compared only AFTER the rename -- the one place it cannot help, since the
# previous dated file is overwritten by then. The refusal arrived having already
# destroyed what it was refusing to destroy.
#
# A dated file with text worth losing, so the case can tell "refused" from
# "overwritten and then complained".
printf '# Release Notes — 2026-08-16\n\nPRE-EXISTING LINE\n' \
  > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
# The flush is the long step the finding names: alter the replacement while it
# runs. \$1 is the file being persisted.
if [ -f "\$ASSEMBLE_WORK" ]; then printf 'INJECTED\n' >> "\$ASSEMBLE_WORK"; fi
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                            "1"
check "it says the content changed" \
  "$(says "$msg" "replacement's content changed")"                              "1"
# The earlier text surviving is a regression guard, not evidence: the
# replacement is a COPY of the dated file with sections appended, so the old
# line came through even on the broken version. What discriminates is whether
# the un-built bytes reached the published file -- and they did.
check "the earlier text is still there" \
  "$(grep -c 'PRE-EXISTING LINE' "$out/ReleaseNotes-2026-08-16.md")"             "1"
check "nothing was injected into it" \
  "$(grep -c 'INJECTED' "$out/ReleaseNotes-2026-08-16.md")"                      "0"
check "both fragments are still pending" "$(pending "$W")"                       "2"

echo "T11: argument handling"
W="$ROOT/t11"; build "$W"
S="$W/docs/ReleaseNotes/assemble.sh"
bash "$S" --nope              >/dev/null 2>&1; check "unknown option refused" "$?" "1"
bash "$S" 2026-08-16 2026-08-17 >/dev/null 2>&1; check "two dates refused"   "$?" "1"
bash "$S" 20260816            >/dev/null 2>&1; check "bad date format refused" "$?" "1"
bash -n "$SRC"                >/dev/null 2>&1; check "assemble.sh parses"    "$?" "0"

echo ""
if (( SKIPPED > 0 )); then
  echo "assemble.test.sh: $SKIPPED case(s) SKIPPED in this pass (uid $(id -u))."
  if [ -z "$DROP_UID" ] && [ "${ASSEMBLE_TEST_NESTED:-}" != "1" ] && [ "$(id -u)" = "0" ]; then
    echo "  No unprivileged account was reachable, so the permission-staged" >&2
    echo "  cases did not run anywhere in this invocation. They are not" >&2
    echo "  passing — they are unmeasured." >&2
  fi
fi
_pass_rc=0
if (( FAILED )); then echo "assemble.test.sh: FAILURES above ^^^" >&2; _pass_rc=1; fi
if (( ! FAILED )) && [ -z "$DROP_UID" ]; then echo "assemble.test.sh: all cases pass"; fi

# The second pass is part of the verdict, not an appendix to it: a failure
# there fails the suite exactly as one here does.
if [ -n "$DROP_UID" ]; then
  if (( ! FAILED )); then echo "assemble.test.sh: first pass clean"; fi
  if ! _second_pass "$@"; then _pass_rc=1; fi
  echo ""
  if (( _pass_rc )); then
    echo "assemble.test.sh: FAILURES in one or both passes ^^^" >&2
  else
    echo "assemble.test.sh: all cases pass (both passes)"
  fi
fi
exit "$_pass_rc"
