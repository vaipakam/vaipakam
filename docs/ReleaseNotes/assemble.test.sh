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

# ── Assertions retired with the shell implementation (#1877) ─────────────
#
# Each of these pinned the SOURCE TEXT of `assemble.sh` — a trap, a
# `mapfile`, a `mktemp` flag, a `local`. The implementation is Python
# now, so the construct is gone and the grep can only fail. What the
# assertion GUARDED is not gone: it is either guaranteed by construction
# in Python, or covered by a behavioural assertion in the same case that
# still runs. The reason is recorded per name, here, rather than the
# lines being deleted — 29 assertions vanishing during a rewrite is
# exactly how the coverage that made the rewrite safe would be lost.
#
# Matched BY NAME, and every name was verified to appear exactly once in
# this file before this table was written. Retiring by name is what let
# this be done without moving a line; three attempts to excise the
# statements mechanically each broke the file, because a `check` can
# span a heredoc or a `case` and no simple span rule survives that.
declare -A RETIRED_ASSERTIONS=(
  ["guard present"]="no Bash-4 floor — the entry point uses no bash-4 feature and the work is Python"
  ["guard is before the first mapfile"]="no mapfile anywhere"
  ["guard names bash 4"]="no Bash-4 floor any more"
  ["the script clears the flag"]="lock_held is cleared before the rmdir, in one place"
  ["removals are non-fatal in the script"]="every cleanup step is a try/except pass, by construction"
  ["it reads the replacement"]="the gate stats the replacement itself; no probe file to confuse it"
  ["no second probe file"]="no probe file is created for the group read at all"
  ["the owner comes from the baseline"]="the baseline is one identity string, compared whole"
  ["the group comes from OUT_ID"]="the baseline is one identity string, compared whole"
  ["the probe runs after the traps"]="no traps — cleanup runs in a finally"
  ["signals are held across it"]="HoldSignals is a context manager; it cannot be left half-applied"
  ["and restored after recording"]="HoldSignals restores in __exit__"
  ["the source is probed too"]="covered behaviourally by the rest of this case"
  ["it is created under SNAP"]="the heading is normalised in memory; no temp file is created"
  ["no bare mktemp for it"]="no temp file is created for it"
  ["the check exists"]="covered behaviourally by the rest of this case"
  ["no startup cache is used"]="the sticky bits are stat-ed inside the gate, never cached"
  ["the gate re-reads the group"]="covered behaviourally by the rest of this case"
  ["and compares the approved one"]="covered behaviourally by the rest of this case"
  ["it builds inside a private directory"]="tempfile.mkdtemp is 0700 by construction"
  ["which is private by construction"]="tempfile.mkdtemp is 0700 by construction"
  ["the directory denies others"]="tempfile.mkdtemp is 0700 by construction"
  ["the approved group is recorded for new outputs"]="covered behaviourally by the rest of this case"
  ["the gate compares unconditionally"]="covered behaviourally by the rest of this case"
  ["membership is compared element-wise"]="list membership in Python is exact, by construction"
  ["and by exact match"]="list membership in Python is exact, by construction"
  ["both directories are tested"]="covered behaviourally by the rest of this case"
  ["the pool is still tested"]="covered behaviourally by the rest of this case"
  ["the trap is cleared after publishing"]="no traps — the backstop words itself from run.published"
)

# ── Which case is speaking ───────────────────────────────────────────────
# The suite had no notion of a current case, so a failure could only be
# attributed to one by scanning the output, and a case could only be
# retired by assertion NAME — where 23 names collide, and retiring one
# would have quietly retired a live assertion in another case.
#
# `case_start` prints exactly what the bare `echo` printed. It just also
# records who is speaking, which is what lets a retirement be precise.
CASE=""
case_start() { CASE="${1%%:*}"; echo "$1"; }

# Cases whose FAULT MODEL was the shell's: each injected a failure at a
# subprocess boundary — sed, grep, rm, stat, sort — that the Python
# implementation does not have. The behaviour each described is not
# abandoned; it is re-tested against the named seams further down, where
# the fault can actually be produced. Retiring the old body rather than
# contorting it is the point: a case that cannot inject its fault is not
# testing anything, whatever its assertions say.
#
# EVERY ROW HERE IS CHECKED, not asserted (T211, Codex #1898 r2). A
# retirement is a claim — "this case can no longer produce its fault" —
# and I had been making it by reading the body, which got it wrong
# nineteen times: three git cases were retired as "re-tested at the seam
# below" when no seam for git existed and the PATH shim still worked
# perfectly, and sixteen more still passed untouched. A claim nobody
# tests is exactly what the suite exists to disallow, so T211 lifts
# every retirement and requires the case to FAIL. A case that passes
# without its retirement does not belong in this table — restore it.
declare -A RETIRED_CASES=(
  ["T101"]="shimmed chmod(1) after recovery deletions — re-tested at the seam below"
  ["T102"]="shimmed to replace the output after publishing — clear seam below"
  ["T103"]="shimmed rm(1) after a recovery deletion — re-tested at the seam below"
  ["T104"]="shimmed rm(1) to save a fragment mid-clear — re-tested at the seam below"
  ["T108"]="shimmed rm(1) to recreate a cleared path — re-tested at the seam below"
  ["T109"]="shimmed sync to alter the replacement — re-tested at the flush seam below"
  ["T111"]="shimmed chmod during the flush — re-tested at the flush seam below"
  ["T114"]="shimmed to swap the replacement for a FIFO — re-tested at the gate below"
  ["T116"]="pinned mktemp -d flags; tempfile.mkdtemp is 0700 by construction"
  ["T117"]="shimmed stat for the group pin, which is now one os.stat"
  ["T118"]="shimmed rm(1) during recovery — re-tested at the recover seam below"
  ["T122"]="shimmed sed to force an implicit errexit — no errexit, no sed"
  ["T123"]="shimmed mv(1) mid-clear — re-tested at the clear seam below"
  ["T124"]="shimmed stat for the device read — re-tested at the gate below"
  ["T125"]="shimmed mv(1) for the publication rename — re-tested at the seam below"
  ["T126"]="shimmed mv(1) after publication — re-tested at the clear seam below"
  ["T127"]="shimmed sort(1) to truncate; sorting is in-process and cannot lose an entry"
  ["T128"]="shimmed sort(1) to drop a path; sorting is in-process and cannot"
  ["T30"]="shimmed sha256sum to fail the fragment hash — re-tested at the seam below"
  ["T31"]="shimmed tail(1) for the last-byte read, which is now a slice"
  ["T32"]="shimmed grep for the heading scan, which is now a regex over bytes"
  ["T32b"]="shimmed grep for the output heading scan, now a regex over bytes"
  ["T32d"]="shimmed stat(1) for the mode read, which is now os.stat"
  ["T33"]="existed to prove run_checked fires; checked() is proven at the seam below"
  ["T35"]="shimmed stat(1) to print a plausible mode while failing — os.stat cannot"
  ["T42"]="shimmed mv(1) during clearing — re-tested at the clear seam below"
  ["T51"]="shimmed grep mid-scan — re-tested at the scan seam below"
  ["T52"]="shimmed grep mid-scan — re-tested at the scan seam below"
  ["T53"]="shimmed grep mid-scan — re-tested at the scan seam below"
  ["T54"]="shimmed grep mid-scan — re-tested at the scan seam below"
  ["T55"]="shimmed rm(1) per deletion — re-tested at the clear seam below"
  ["T56"]="shimmed cp(1) during the copy — re-tested at the snapshot seam below"
  ["T63"]="shimmed cp(1) during the copy — re-tested at the snapshot seam below"
  ["T66"]="pinned that shell removals were non-fatal; they are try/except pass now"
  ["T70"]="shimmed rm(1) during recovery — re-tested at the recover seam below"
  ["T73"]="shimmed rmdir(1) to fail the lock release — re-tested for real below"
  ["T82"]="shimmed cp+grep together to fake a transient marker — seam below"
  ["T86"]="shimmed chmod(1) to apply a different mode — re-tested at the seam below"
  ["T95"]="pinned trap ordering around the probe; HoldSignals cannot be half-applied"
  ["T97"]="shimmed rm(1) mid-consumption — re-tested at the clear seam below"
  ["T98"]="shimmed sha256sum in the recovery loop — re-tested at the seam below"
)

# The audit pass T211 drives: every retirement lifted, so each case runs
# with its assertions live and is expected to FAIL. Kept as a mode of
# this same file rather than a second script, so the audit can never be
# auditing an older copy of the suite.
RETIRED_CASE_IDS=("${!RETIRED_CASES[@]}")
if [ "${ASSEMBLE_TEST_AUDIT:-}" = "1" ]; then
  RETIRED_CASES=()
fi

RETIRED=0
retired() { echo "  RTRD — $1"; RETIRED=$((RETIRED + 1)); }
check() {  # check <condition-description> <actual> <expected>
  if [ -n "$CASE" ] && [ -n "${RETIRED_CASES[$CASE]+set}" ]; then
    retired "$1 — ${RETIRED_CASES[$CASE]}"
    return
  fi
  if [ -n "${RETIRED_ASSERTIONS[$1]+set}" ]; then
    retired "$1 — ${RETIRED_ASSERTIONS[$1]}"
    return
  fi
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
case_start "T1: mixed backlog assembles one day at a time"
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
case_start "T2: a date with no fragments of its own is refused"
W="$ROOT/t2"; build "$W"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-15 >/dev/null 2>&1
check "refused"              "$?"                                                    "1"
check "no dated file made"   "$([ -f "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-15.md" ] && echo yes || echo no)" "no"
check "nothing consumed"     "$(pending "$W")"                                       "2"

# ── The deliberate-fold escape hatch ─────────────────────────────────────────
case_start "T3: --allow-mixed-dates folds every pending day together"
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
case_start "T4: a shallow clone whose fragments predate the boundary is refused"
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

case_start "T4b: a shallow clone whose fragments POST-date the boundary proceeds"
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
case_start "T5: an untracked fragment is taken, not held back"
W="$ROOT/t5"; build "$W"
printf '## c\n' > "$W/docs/ReleaseNotes/unreleased/0003-c.md"   # never committed
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 >/dev/null 2>&1
check "succeeds"                       "$?"                                                            "0"
check "own-day fragment + untracked"   "$(sections "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "2"
check "other day still held"           "$(pending "$W")"                                               "1"

# ── No git at all (export / tarball) degrades, it does not lie ───────────────
case_start "T6: a non-git tree assembles everything and says so"
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
case_start "T7: a renamed fragment keeps its original day"
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
case_start "T8: a staged (uncommitted) rename keeps the original day"
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
case_start "T8b: an unreadable git history aborts"
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
case_start "T9: a reused fragment name is dated as new, not inherited"
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
case_start "T10: an unpairable staged rename is announced, not silently misfiled"
W="$ROOT/t10"; build "$W"
git -C "$W" mv docs/ReleaseNotes/unreleased/0001-a.md \
              docs/ReleaseNotes/unreleased/0001-a-rewritten.md
# Replace the content wholesale so similarity detection cannot pair the two.
# The heading is INCIDENTAL to what this case tests — it is here only because
# #2295 refuses a fragment whose opening line is not one, and this case is
# about rename pairing, not headings. It shares no line with the original, so
# the pairing it is testing is unaffected.
printf '## Thread — totally different content, sharing no line (PR #4210)\n' \
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
case_start "T10b: a symlinked checkout does not disable the guard"
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
case_start "T10c: a glob metacharacter in a fragment name is not dropped"
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
case_start "T10d: log.showSignature does not break dating"
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
case_start "T10e: damaged .git metadata is refused, not treated as an export"
W="$ROOT/t10e"; build "$W"
mv "$W/.git/HEAD" "$W/.git/HEAD.bak"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 2>&1)"
check "refused"          "$?"                                        "1"
check "says why"         "$(says "$msg" 'git cannot read this work tree')" "1"
check "nothing consumed" "$(pending "$W")"                           "2"
mv "$W/.git/HEAD.bak" "$W/.git/HEAD"

# ── An unreadable index must not read as "no renames staged" ────────────────
case_start "T10f: an unreadable index aborts"
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
case_start "T10g: an unreadable HEAD lookup aborts"
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
case_start "T10h: a FAILING shallow probe aborts instead of reading as non-shallow"
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

case_start "T10i: a DANGLING .git symlink is damage, not an export"
W="$ROOT/t10i"; build "$W"
rm -rf "$W/.git"
ln -s "$W/.git-gone-missing" "$W/.git"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-16 2>&1)"
check "aborts"            "$?"                                    "1"
check "says damaged"      "$(says "$msg" 'cannot read this work tree')" "1"
check "did NOT call it an export" "$(says "$msg" 'not a git work tree')" "0"
check "nothing consumed"  "$(pending "$W")"                       "2"

case_start "T10j: Bash 3 is refused up front, by name"
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
case_start "T12: an interruption AFTER the write does not duplicate content"
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

case_start "T12b: a re-run with nothing but already-assembled fragments still clears"
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

case_start "T13: the dated file is replaced whole, never left half-written"
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

case_start "T13b: a marker-shaped line inside PROSE is not treated as a marker"
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
case_start "T14: a fragment EDITED after an interrupted run is not silently deleted"
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

case_start "T14b: a REUSED basename with different content is treated as new"
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

case_start "T15: a fragment RENAMED between runs stops the run rather than being guessed at"
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

case_start "T16: a marker in ANOTHER dated file stops the run (the midnight case)"
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

case_start "T17: a directory at the output path is refused before anything is consumed"
W="$ROOT/t17"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir "$out/ReleaseNotes-2026-08-16.md"
bash "$out/assemble.sh" 2026-08-16 >/dev/null 2>&1
check "run fails"                  "$?"              "1"
check "no fragment was consumed"   "$(pending "$W")" "2"

case_start "T18: a MARKERLESS file that may already hold the content stops and asks"
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

case_start "T19: a filename containing a backslash still hashes correctly"
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

case_start "T20: identical bytes under a different name are not assumed to be a rename"
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

case_start "T21: the assembled file stays readable, not owner-only"
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

case_start "T22: a name AND its bytes reused on a later day is not assumed to be the same note"
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

case_start "T23: a marker prefix appearing only in prose does not make a file authoritative"
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

case_start "T24: an unreadable dated file aborts instead of scanning as markerless"
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

case_start "T25: a FIFO at a dated path is refused instead of hanging the run"
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

case_start "T26: a symlink at the output path is refused, not replaced"
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

case_start "T27: two overlapping assemblies cannot lose a fragment"
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

case_start "T28: two fragments with IDENTICAL bytes in one assembly both stay recorded"
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

case_start "T29: a symlinked output is refused BEFORE marker recovery deletes anything"
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

case_start "T30: a failing hash aborts instead of writing an empty marker"
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

case_start "T31: a failing tail aborts rather than corrupting the marker"
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

case_start "T32: a failing heading scan aborts rather than skipping the duplicate check"
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

case_start "T32b: a failing heading scan of the OUTPUT is not read as no-match"
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

case_start "T32c: a fragment containing a NUL byte is still scanned as text"
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

case_start "T32d: an unreadable existing mode aborts instead of widening the file"
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

case_start "T33: run_checked's fatal path actually fires (no root needed)"
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

case_start "T34: a fragment ENDING in NUL still gets a findable marker"
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

case_start "T35: a stat that prints a plausible mode but FAILS is not believed"
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

case_start "T36: a fragment name that would close the marker comment is refused"
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

case_start "T37: a fragment cannot supply its own marker record"
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

case_start "T38: a fragment edited mid-run is kept, not deleted"
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

case_start "T39: the output mode is applied to the finished file, not the temp file"
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

case_start "T40: an output owned by someone else is refused, not silently taken over"
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

case_start "T41: the fragment deleted is the one that was checked"
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

case_start "T42: a failure DURING clearing says the file is already written"
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

case_start "T43: a set-aside fragment is reported, not silently invisible"
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

case_start "T44: a fragment filename containing a newline is refused clearly"
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

case_start "T45: an edit to the dated file mid-run is not overwritten"
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

case_start "T45b: a dated file CREATED mid-run is not clobbered"
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

case_start "T46: a dated file that BECOMES a symlink mid-run is refused"
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

case_start "T47: a temp file left by a hard kill is reported, not staged silently"
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

case_start "T48: an edit during the disk flush is still caught"
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

case_start "T49: a permission change mid-run is not silently undone"
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

case_start "T50: an ownership change mid-run is not silently undone"
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

case_start "T51: a marker injected into a fragment mid-run never reaches the index"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<SHIM
#!/bin/sh
_marker=0
for a in "\$@"; do
  case "\$a" in *sha256=*) _marker=1 ;; esac
done
_rc=0
if [ "\$_marker" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '<!-- assembled-fragment: 0002-b.md sha256=%s -->\n' \\
    ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \\
    >> "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/scan"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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

case_start "T52: recovery deletion rechecks the output it is trusting"
W="$ROOT/t52"; build "$W"
out="$W/docs/ReleaseNotes"
# The records authorising these deletions are read from the dated file early;
# the deletions happen later. If it changed in between, the evidence may
# describe text it no longer holds — and when EVERY fragment takes the
# recovery path the run exits before the check ahead of the rename, so this is
# the only place that can catch it (Codex #1863 r19).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/   # the interrupted state
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<SHIM
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
_rc=0
if [ "\$_dated" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '# Release Notes — 2026-08-16\n\n## replaced entirely\n' \\
    > "$out/ReleaseNotes-2026-08-16.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/scan"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                  "1"
check "no fragment consumed"   "$(pending "$W")"                     "2"
check "it says what changed"   "$(says "$msg" 'changed while this run')" "1"

case_start "T53: recovery deletion keeps a fragment that changed since it was read"
W="$ROOT/t53"; build "$W"
out="$W/docs/ReleaseNotes"
# The recovery loop deleted outright, so a fragment edited since the run read
# it was thrown away while the dated file held only the older text — the fault
# the consumption loop already refuses to commit, sitting unguarded a few
# lines away. Found by auditing this path rather than by a review round.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/scan" <<SHIM
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
_rc=0
if [ "\$_dated" = "1" ] && [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## 0001-a\n\nnewly added line\n' \\
    > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/scan"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
# By CONTENT: the recovery path quarantines before deleting now, so a kept
# fragment lives inside `.assembled/` and looking for the original path
# reports "gone" for a file sitting safely right there.
check "the edited one is kept" \
  "$(grep -rl 'newly added line' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "1"
check "and it says so"         "$(says "$msg" 'Kept (changed')"      "1"
check "the untouched one goes" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/0002-b.md" ] && echo kept || echo gone)" "gone"

case_start "T54: the published file is rechecked before fragments are removed"
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

case_start "T55: each recovery deletion rechecks for itself, not once for the batch"
W="$ROOT/t55"; build "$W"
out="$W/docs/ReleaseNotes"
# Checked once before the loop, the SECOND deletion still ran on evidence
# gathered before the first — so an edit landing between them removed a
# fragment whose section was no longer anywhere (Codex #1863 r20). Both
# fragments take the recovery path here, and the output is replaced after the
# first removal.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
# The quarantine writability probe is an `rm` too, and it runs first — it
# spent this shim's one shot before the loop under test ever started.
case "\$*" in *.probe*) exit 0 ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */unreleased/*)
      : > "$W/fired"
      printf '# Release Notes — 2026-08-16\n\n## replaced after the first\n' \\
        > "$out/ReleaseNotes-2026-08-16.md"
      ;;
  esac
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
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

case_start "T56: a fragment rewritten DURING the copy is refused, not published torn"
W="$ROOT/t56"; build "$W"
out="$W/docs/ReleaseNotes"
# `cp` is not atomic. Rewritten while it reads, the copy can hold an old
# prefix and a new suffix — a version that never existed — and everything
# downstream trusts it consistently, so the invented text is published and
# only the coherent source is quarantined afterwards (Codex #1863 r20).
# Shimming `cp` reproduces the race deterministically: rewrite the source
# between the two reads that bracket the copy.
mkdir -p "$W/hooks"
cat > "$W/hooks/snapshot" <<SHIM
#!/bin/sh
_rc=0
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf '## rewritten during the copy\n' \\
    > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
fi
exit 0
SHIM
chmod +x "$W/hooks/snapshot"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                        "1"
check "no fragment consumed"   "$(pending "$W")"                           "2"
check "it says what happened"  "$(says "$msg" 'changed while it was being read')" "1"
check "nothing was published" \
  "$([ -f "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"  "none"

case_start "T57: a marker appearing in ANOTHER dated file mid-run stops the run"
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

case_start "T58: a NEW dated file appearing mid-run stops the run"
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

case_start "T59: another day's fragment does not abort this day's run"
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

case_start "T60: the post-write handler exists before anything can call it"
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

case_start "T61: a near-NAME_MAX fragment name can still be set aside"
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

case_start "T62: a marker record containing a NUL is refused, not silently reshaped"
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

case_start "T63: a marker present only during the scan cannot authorise a deletion"
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

case_start "T64: a multibyte name near NAME_MAX is measured in bytes, not characters"
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

case_start "T65: cleanup running twice does not release a lock it no longer holds"
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

case_start "T66: a failing temp-file removal still releases the lock"
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

case_start "T67: a name using the ABRUPT comment terminator is refused"
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

case_start "T68: the replacement is built from the recorded copy, not a fresh read"
W="$ROOT/t68"; build "$W"
out="$W/docs/ReleaseNotes"
# The identity baseline comes from a working copy; reading $OUT AGAIN to build
# the replacement is another read at another moment. An editor changing it
# while `cat` runs and restoring it before the final check leaves the identity
# matching while the temp file holds the transient text — which is then
# published (Codex #1863 r23).
printf '# Release Notes — 2026-08-16\n\n## genuine\n' > "$out/ReleaseNotes-2026-08-16.md"
cp "$out/ReleaseNotes-2026-08-16.md" "$W/pristine.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
# Swap in transient text for the duration of the read, then restore, so the
# live file ends byte-identical and only a fresh read could have seen it.
printf '# Release Notes — 2026-08-16\n\n## TRANSIENT\n' > "$out/ReleaseNotes-2026-08-16.md"
_rc=0
/bin/cp "$W/pristine.md" "$out/ReleaseNotes-2026-08-16.md"
exit 0
SHIM
chmod +x "$W/hooks/build"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the transient text is not published" \
  "$(count_in '^## TRANSIENT$' "$out/ReleaseNotes-2026-08-16.md")"          "0"
check "the genuine text survives" \
  "$(count_in '^## genuine$' "$out/ReleaseNotes-2026-08-16.md")"            "1"

case_start "T69: a near-NAME_MAX name is set aside under its own name"
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

case_start "T70: recovery deletion quarantines before it checks and removes"
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

case_start "T71: the markerless heading check reads the recorded copy"
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

case_start "T73: a lock that cannot be released is reported, not swallowed"
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

case_start "T74: markers written with CRLF endings are still recognised"
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

case_start "T75: marker PRESENCE is read from the recorded copy too"
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

case_start "T76: a dangling symlink at the quarantine path is not overwritten"
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

case_start "T77: the group compared is the one a NEW file here would take"
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

case_start "T78: CRLF and LF headings compare as the same heading"
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

case_start "T78b: a heading below the opening line still stops a markerless run"
W="$ROOT/t78b"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# A REPRODUCED DATA-LOSS BUG, pinned because the suite did not catch it and a
# review did (#2290 r12). `check_heading_conformance` judges the line a
# fragment OPENS with; this guard has to find the heading WHEREVER it is,
# because a legacy interrupted run wrote the fragment's whole body into the
# dated file. Sharing the opening-only parser between them returned None for a
# fragment that opens with prose, so this guard saw nothing to match: the run
# appended the fragment a SECOND time and then consumed the pending source —
# two copies, exit 0, the one outcome here that loses work rather than
# refusing it. Measured before and after the fix.
#
# Sharing was right when the two differed by accident and wrong once they
# asked different questions. Re-unify them and this case fails.
printf 'intro prose\n\n## Later heading (PR #4321)\n\nbody text\n' \
  > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
printf '# Release Notes — 2026-08-16\n\nintro prose\n\n## Later heading (PR #4321)\n\nbody text\n' \
  > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops and asks"   "$?"                                      "1"
check "naming the fragment"      "$(says "$msg" '0001-a.md')"              "1"
check "no fragment consumed"     "$(pending "$W")"                         "1"
check "the heading is not duplicated" \
  "$(count_in '^## Later heading' "$out/ReleaseNotes-2026-08-16.md")"      "1"

case_start "T78c: remediating a BOM does not orphan the published copy"
W="$ROOT/t78c"; build "$W"
out="$W/docs/ReleaseNotes"
rm "$W/docs/ReleaseNotes/unreleased/0002-b.md"
# A legacy markerless dated file can hold a section as `<BOM>## Title`, and
# HEADING_RE never matches a line beginning EF BB BF — so without stripping
# the mark on both sides the guard sees no heading, appends a second copy and
# consumes the source. Measured: pre-fix exit=0, copies=2, pending=0.
#
# The route that first exposed this is GONE: refusing a BOM told the author
# to re-save, and that edit is what stopped the published copy matching
# (#2290 r20/r21). The refusal has since been removed for causing exactly
# that. The stripping stays, because a legacy file can carry a BOM-bearing
# section for reasons that predate this change and the guard must still
# recognise it.
#
# The class — a refusal whose remedy edits the text this guard matches on —
# is filed as #2298 rather than patched per remedy.
printf '## Thread — already published (PR #4400)\n\nbody\n' \
  > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
printf '# Release Notes — 2026-08-16\n\n\xef\xbb\xbf## Thread — already published (PR #4400)\n\nbody\n' \
  > "$out/ReleaseNotes-2026-08-16.md"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops and asks"  "$?"                                              "1"
check "naming the fragment"     "$(says "$msg" '0001-a.md')"                      "1"
check "no fragment consumed"    "$(pending "$W")"                                 "1"
check "not duplicated" \
  "$(count_in 'already published' "$out/ReleaseNotes-2026-08-16.md")"             "1"

case_start "T79: the quarantine directory is validated before publication"
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

case_start "T80: the group compared is the replacement's own, not a later probe"
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

case_start "T81: a transient chown during the owner read does not transfer ownership"
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

case_start "T82: a marker seen only in the copy cannot authorise a deletion"
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

case_start "T83: the set-aside report does not claim changed copies are already filed"
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

case_start "T84: an unwritable quarantine directory is refused before publishing"
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

case_start "T85: a quarantine collision is refused before publishing, not after"
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

case_start "T86: a mode that cannot be applied stops the run before publishing"
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

case_start "T87: a failing heading normalisation aborts instead of comparing raw"
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

case_start "T88: the compared group comes from the baseline, not a fresh read"
W="$ROOT/t88"; build "$W"
out="$W/docs/ReleaseNotes"
# A chgrp covering only that read, reverted afterwards, passed the check AND
# passed the final identity check against the restored value, while the rename
# installed the other group permanently (Codex #1863 r27) — the same fault the
# uid check had one round earlier. Pinned structurally: reproducing it needs a
# stat that lies for exactly one call.
check "the group comes from OUT_ID" \
  "$(grep -c 'out_gid="\${OUT_ID##\*:}"' "$out/assemble.sh")"               "1"

case_start "T89: a heading containing a NUL still matches its duplicate"
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

case_start "T90: the quarantine probe creates an entry rather than truncating one"
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

case_start "T91: a symlinked fragment is refused before anything is published"
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

case_start "T92: a NUL in a marker-SHAPED line is refused at the fragment"
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

case_start "T93: the published file is rechecked after the hash, next to the delete"
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

case_start "T94: a write to the quarantined fragment during the output hash is kept"
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

case_start "T95: a probe left by a signal is cleaned up and reportable"
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

case_start "T96: the probe path is recorded under held signals"
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

case_start "T97: every mid-consumption refusal reports what already went"
W="$ROOT/t97"; build "$W"
out="$W/docs/ReleaseNotes"
# The consumed-aware wording was added to ONE exit branch; the others still
# claimed nothing had been touched, so a run that had already deleted a
# fragment could report the opposite (Codex #1863 r31). Here a NEW dated file
# appears after the first removal, which exits through a different branch.
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
case "\$*" in *.probe*) exit 0 ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*)
      : > "$W/fired"
      printf '# Release Notes — 2026-08-14\n' > "$out/ReleaseNotes-2026-08-14.md"
      ;;
  esac
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                          "1"
check "it names the newcomer"  "$(says "$msg" '2026-08-14.md appeared')"      "1"
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')" "0"
check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"

case_start "T98: the recovery loop re-hashes the quarantine last too"
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

case_start "T99: a fragment that becomes a symlink mid-run is caught before publishing"
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

case_start "T100: a stale write probe is not described as a set-aside fragment"
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

case_start "T101: a failure after recovery deletions still reports them"
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

case_start "T102: \$OUT replaced by a symlink after publishing stops the clearing"
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

case_start "T103: an identity-read failure after a recovery deletion reports it"
W="$ROOT/t103"; build "$W"
out="$W/docs/ReleaseNotes"
# The changed-identity branch was routed through the consumed reporter; the
# unreadable-identity branch beside it was not, so it still claimed every
# fragment remained pending after one had gone (Codex #1863 r33).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
case "\$*" in *.probe*) exit 0 ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*) : > "$W/fired"; chmod 000 "$out/ReleaseNotes-2026-08-16.md" ;;
  esac
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
if [ "$(id -u)" = "0" ]; then
  skip "root reads through mode 000 (CI runs it)"
else
  msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  check "the run stops"          "$?"                                             "1"
  check "it does not claim nothing went" \
    "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"  "0"
  check "it names what already went" "$(says "$msg" 'Already removed before this')" "1"
fi
chmod 0644 "$out/ReleaseNotes-2026-08-16.md" 2>/dev/null || true

case_start "T104: a fragment saved after recovery is not reported as a clear backlog"
W="$ROOT/t104"; build "$W"
out="$W/docs/ReleaseNotes"
# An editor saving a new version at the original path after the recovery loop
# moved the old inode aside creates a genuinely pending fragment. It is left
# untouched, correctly — but the verdict was computed before it existed and
# announced a clear backlog with one waiting (Codex #1863 r33).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
case "\$*" in *.probe*) exit 0 ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*)
      : > "$W/fired"
      printf '## saved after recovery\n' > "$W/docs/ReleaseNotes/unreleased/0009-new.md"
      ;;
  esac
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it does not claim the pool is clear" \
  "$(says "$msg" 'Nothing left to assemble')"                              "0"
check "it names the newcomer"    "$(says "$msg" '0009-new.md')"             "1"
check "and the newcomer survives" \
  "$([ -f "$W/docs/ReleaseNotes/unreleased/0009-new.md" ] && echo kept || echo gone)" "kept"

case_start "T105: quarantine writability is rechecked in the final gate"
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

case_start "T106: a fragment held back for another day is not called a newcomer"
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

case_start "T107: a marker whose name has a non-UTF-8 byte is still recognised"
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

case_start "T108: a fragment recreated at a cleared path is reported as pending"
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
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
_rc=0
case "\$*" in *.probe*) exit 0 ;; esac
if [ ! -f "$W/fired" ]; then
  case "\$*" in
    */.assembled/*)
      : > "$W/fired"
      printf '## saved under the same name\n' > "$W/docs/ReleaseNotes/unreleased/0001-a.md"
      ;;
  esac
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "it does not claim the pool is clear" \
  "$(says "$msg" 'Nothing left to assemble')"                              "0"
check "it names the reused name"  "$(says "$msg" '0001-a.md')"              "1"
check "the new text survives" \
  "$(count_in 'saved under the same name' "$W/docs/ReleaseNotes/unreleased/0001-a.md")" "1"

case_start "T109: the published file must hold the bytes this run built"
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

case_start "T110: the gate probes the source directory as well as the destination"
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

case_start "T111: the replacement's own mode is rechecked after the flush"
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

case_start "T112: the normalised heading is built inside the run's private directory"
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

case_start "T113: a sticky pool with a foreign-owned fragment is refused"
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

case_start "T114: a replacement swapped for a FIFO is refused, not published"
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

case_start "T115: the replacement's group is rechecked before the rename"
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

case_start "T116: the replacement is built where nobody else can swap it"
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

case_start "T117: a brand-new dated file has its group pinned too"
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

case_start "T118: a failed recovery removal still reports what already went"
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

case_start "T119: every pre-rename exit reports what already went"
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

case_start "T120: a held path with a space does not mask a recreated fragment"
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

case_start "T121: the sticky check covers the quarantine directory too"
W="$ROOT/t121"; build "$W"
out="$W/docs/ReleaseNotes"
# The quarantine can be sticky independently of the pool — a mode-1777
# `.assembled/` owned by someone else accepts the move and then forbids the
# removal, which fails after publication (Codex #1863 r42).
check "both directories are tested" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -cF '[ -k "$QDIR" ]')" "1"
check "the pool is still tested" \
  "$(awk '/^_final_gate\(\) \{/,/^\}/' "$out/assemble.sh" | grep -cF '[ -k "$UNREL" ]')" "1"

case_start "T122: an implicit set -e exit reports what already went too"
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

case_start "T123: a fragment moved aside is reported as touched, not untouched"
W="$ROOT/t123"; build "$W"
out="$W/docs/ReleaseNotes"
# Between the set-aside `mv` and the removal the fragment is no longer in the
# pending pool — it exists only under `.assembled/`. A refusal in that window
# said "no fragment has been touched", which is false, and omitted the one path
# the operator needs (Codex #1863 r43).
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -- docs/ReleaseNotes/unreleased/
mkdir -p "$W/hooks"
cat > "$W/hooks/clear" <<SHIM
#!/bin/sh
_rc=0
case "\$*" in
  */.assembled/*)
    if [ ! -f "$W/fired" ]; then
      : > "$W/fired"
      # Change a dated file so the very next revalidation refuses.
      printf '# Release Notes — 2026-08-14\n' > "$out/ReleaseNotes-2026-08-14.md"
    fi
    ;;
esac
exit 0
SHIM
chmod +x "$W/hooks/clear"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"        "$?"                                              "1"
check "it says it was moved" "$(says "$msg" 'Moved aside but not removed')"     "1"
check "it names the path"    "$(says "$msg" '.assembled/0001-a.md')"            "1"
check "it does not claim untouched" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')" "0"

case_start "T124: the quarantine's filesystem is re-checked at the final gate"
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

case_start "T125: a failed publication rename speaks the script's own contract"
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

case_start "T126: a post-publication failure does not contradict itself"
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

case_start "T127: a sort that truncates the pool stops the run"
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

case_start "T128: a sort that drops a path while succeeding stops the run"
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

case_start "T129: a replacement altered during the flush is refused, not published"
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


# ════════════════════════════════════════════════════════════════════════
# The fault model, re-tested at the seams (#1877)
#
# 60 cases above were retired because they injected their fault by
# shimming a command the shell happened to spawn. The behaviours they
# described are not abandoned — they are re-tested here, against the two
# seams the implementation declares:
#
#   ASSEMBLE_TEST_FAIL="<step>"      one named step fails
#   ASSEMBLE_TEST_HOOK_DIR="<dir>"   an executable named for a phase runs
#                                     at that phase
#
# Every case here is CALIBRATED: `broken` installs a deliberately
# damaged implementation in the fixture and the case is run against it
# first, so a negative assertion has been seen failing before it is
# trusted. A replacement suite that was never seen failing would be
# worth less than the cases it replaced.
# ════════════════════════════════════════════════════════════════════════

# Swap the fixture's implementation for one with `$2` applied to `$1`.
# Used to prove a case can fail before it is believed when it passes.
broken() {  # broken <dir> <python-source-substitution>
  python3 - "$1/docs/ReleaseNotes/assemble.py" "$2" <<'BREAK'
import sys, re
path, sub = sys.argv[1], sys.argv[2]
old, new = sub.split('=>', 1)
s = open(path).read()
if old not in s:
    sys.exit("calibration substitution did not match: " + old[:60])
open(path, 'w').write(s.replace(old, new, 1))
BREAK
}

case_start "T200: a named step failing refuses with nothing consumed"
W="$ROOT/t200"; build "$W"
out="$W/docs/ReleaseNotes"
msg="$(ASSEMBLE_TEST_FAIL="reading 0001-a.md" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"            "$?"                                            "1"
check "it names the step"        "$(says "$msg" 'reading 0001-a.md failed')"      "1"
check "it states the contract"   "$(says "$msg" 'must not continue on the strength of')" "1"
check "nothing was consumed"     "$(says "$msg" 'Nothing has been consumed')"     "1"
check "both fragments survive"   "$(pending "$W")"                                "2"
check "nothing was published" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"        "none"

case_start "T201: every fallible step is reachable by name"
W="$ROOT/t201"; build "$W"
out="$W/docs/ReleaseNotes"
# The point of one wrapper is that EVERY step goes through it. A step
# that named itself but was never routed would be untestable and
# unreported — the scattered-handling problem in a new costume.
_steps=0; _named=0
for step in "reading 0001-a.md" "taking a working copy of 0001-a.md" \
            "re-reading 0001-a.md" "checking the working copy of 0001-a.md" \
            "hashing 0001-a.md" "reading the last byte of 0001-a.md"; do
  _steps=$(( _steps + 1 ))
  git -C "$W" checkout -q -- docs/ReleaseNotes/unreleased/ 2>/dev/null
  rm -f "$out/ReleaseNotes-2026-08-16.md"
  m="$(ASSEMBLE_TEST_FAIL="$step" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
  if [ "$(says "$m" "$step failed")" = "1" ]; then _named=$(( _named + 1 )); fi
done
check "every step reports by its own name" "$_named" "$_steps"

case_start "T202: a fragment edited during the flush is refused, not published"
W="$ROOT/t202"; build "$W"
out="$W/docs/ReleaseNotes"
printf '# Release Notes — 2026-08-16\n\nPRE-EXISTING\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
printf 'INJECTED\n' >> "\$ASSEMBLE_WORK"
exit 0
SHIM
chmod +x "$W/hooks/flush"
# Calibrated: without the gate's content comparison the injected bytes
# reach the published file.
cp -r "$W" "$W.cal"
broken "$W.cal" 'if frag_hash(self.work) != self.expected_id:=>if False:'
( cd "$W.cal" && ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash docs/ReleaseNotes/assemble.sh 2026-08-16 --allow-mixed-dates ) >/dev/null 2>&1
check "calibration: the break publishes the injected bytes" \
  "$(grep -c 'INJECTED' "$W.cal/docs/ReleaseNotes/ReleaseNotes-2026-08-16.md" 2>/dev/null)" "1"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"              "$?"                                           "1"
check "it says the content changed" "$(says "$msg" "replacement's content changed")" "1"
check "the injected bytes are not published" \
  "$(grep -c 'INJECTED' "$out/ReleaseNotes-2026-08-16.md")"                        "0"
check "the earlier text survives" \
  "$(grep -c 'PRE-EXISTING' "$out/ReleaseNotes-2026-08-16.md")"                    "1"

case_start "T203: a marker without its section cannot authorise a deletion (#1886)"
W="$ROOT/t203"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -q -- docs/ReleaseNotes/unreleased/
# Delete the SECTION but leave its marker: the signature of someone
# editing the dated notes and keeping the invisible comment.
python3 - "$out/ReleaseNotes-2026-08-16.md" <<'EOF'
import sys
p = sys.argv[1]
lines = open(p).read().split('\n')
open(p, 'w').write('\n'.join(l for l in lines if 'body 0001-a' not in l and l != '## 0001-a'))
EOF
check "the marker is still there" \
  "$(grep -c 'assembled-fragment: 0001-a.md' "$out/ReleaseNotes-2026-08-16.md")"   "1"
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"           "$?"                                              "1"
check "it says the section is missing" \
  "$(says "$msg" 'but not the section it stands for')"                             "1"
check "the fragment is NOT deleted" \
  "$(ls "$W/docs/ReleaseNotes/unreleased/0001-a.md" >/dev/null 2>&1 && echo kept || echo gone)" "kept"

case_start "T204: a fragment altered after being set aside is kept, not deleted"
W="$ROOT/t204"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
# Write through to the quarantined inode by its new path, in the window
# between the move and the delete.
printf '## written after the move\n' >> "\$ASSEMBLE_QUARANTINE"
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the later write survives" \
  "$(grep -rl 'written after the move' "$W/docs/ReleaseNotes/unreleased" 2>/dev/null | wc -l | tr -d ' ')" "2"
check "it says they were kept"  "$(says "$msg" 'set aside as')"                     "1"

case_start "T205: the published file altered during clearing is reported as half done"
W="$ROOT/t205"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/hooks"
cat > "$W/hooks/clear-moved" <<SHIM
#!/bin/sh
if [ ! -f "$W/fired" ]; then
  : > "$W/fired"
  printf 'TAMPERED\n' >> "\$ASSEMBLE_OUT"
fi
exit 0
SHIM
chmod +x "$W/hooks/clear-moved"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"              "$?"                                           "1"
check "it says the file was written" "$(says "$msg" 'HAS ALREADY BEEN WRITTEN')"   "1"
check "it does not claim nothing went" \
  "$(says "$msg" 'Nothing has been consumed and no fragment has been touched')"    "0"

case_start "T206: a failing publication rename speaks the contract"
W="$ROOT/t206"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/hooks"
# Remove the built replacement at the flush, so the rename cannot find it.
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
rm -f "\$ASSEMBLE_WORK"
exit 0
SHIM
chmod +x "$W/hooks/flush"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"            "$?"                                             "1"
check "it refuses before publishing" \
  "$(says "$msg" 'no longer a regular file')"                                      "1"
check "nothing was published" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)"         "none"
check "both fragments are still pending" "$(pending "$W")"                         "2"

case_start "T207: an output replaced during the scan stops the run"
W="$ROOT/t207"; build "$W"
out="$W/docs/ReleaseNotes"
printf '# Release Notes — 2026-08-16\n\nORIGINAL\n' > "$out/ReleaseNotes-2026-08-16.md"
mkdir -p "$W/hooks"
cat > "$W/hooks/build" <<SHIM
#!/bin/sh
printf '\n## edited by someone else\n' >> "$out/ReleaseNotes-2026-08-16.md"
exit 0
SHIM
chmod +x "$W/hooks/build"
msg="$(ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"          "$?"                                               "1"
check "it says what changed"   "$(says "$msg" 'changed while this run was working')" "1"
check "the other edit survives" \
  "$(grep -c 'edited by someone else' "$out/ReleaseNotes-2026-08-16.md")"          "1"
check "nothing was consumed"   "$(pending "$W")"                                   "2"


case_start "T208: SIGTERM releases the lock instead of stranding it"
W="$ROOT/t208"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/hooks"
# Without a SIGTERM handler, Python restores the DEFAULT disposition when
# the mask lifts: the process dies, `finally` never runs, and the lock is
# left for every later run to refuse over (Codex #1898 r1).
cat > "$W/hooks/flush" <<SHIM
#!/bin/sh
kill -TERM \$ASSEMBLE_PID 2>/dev/null
sleep 2
exit 0
SHIM
chmod +x "$W/hooks/flush"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "the lock is not left behind" \
  "$([ -e "$W/docs/ReleaseNotes/unreleased/.assemble.lock" ] && echo stranded || echo released)" "released"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
check "a later run is not blocked" "$?" "0"

case_start "T209: a marker cannot authorise a deletion on a PREFIX match"
W="$ROOT/t209"; build "$W"
out="$W/docs/ReleaseNotes"
bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
git -C "$W" checkout -q -- docs/ReleaseNotes/unreleased/
# Extend the section's final line, leaving the marker. The original body
# is now a PREFIX of what is there, which a substring test accepts — and
# the fragment would be deleted while the run claimed byte-for-byte.
python3 - "$out/ReleaseNotes-2026-08-16.md" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
open(p, 'w').write(s.replace('## 0001-a\n', '## 0001-a extended\n', 1))
PYEOF
msg="$(bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run stops"        "$?"                                                "1"
check "it says the section is missing" \
  "$(says "$msg" 'but not the section it stands for')"                            "1"
check "the fragment is NOT deleted" \
  "$(ls "$W/docs/ReleaseNotes/unreleased/0001-a.md" >/dev/null 2>&1 && echo kept || echo gone)" "kept"

case_start "T210: a hook failing means the phase failed, at every phase"
W="$ROOT/t210"; build "$W"
out="$W/docs/ReleaseNotes"
# The seam's contract is that a non-zero hook exit fails the phase. Four
# call sites ignored the answer, so a migrated case could stop injecting
# its failure and still pass (Codex #1898 r1).
_phases=0; _enforced=0
for phase in snapshot scan build flush; do
  _phases=$(( _phases + 1 ))
  git -C "$W" checkout -q -- docs/ReleaseNotes/unreleased/ 2>/dev/null
  rm -rf "$W/hooks" "$out/ReleaseNotes-2026-08-16.md"; mkdir -p "$W/hooks"
  printf '#!/bin/sh\nexit 9\n' > "$W/hooks/$phase"; chmod +x "$W/hooks/$phase"
  ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates >/dev/null 2>&1
  rc=$?
  published="$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo yes || echo no)"
  if [ "$rc" != "0" ] && [ "$published" = "no" ]; then _enforced=$(( _enforced + 1 )); fi
done
check "every phase enforces a failing hook" "$_enforced" "$_phases"

case_start "T215: a tree with no git EXECUTABLE still assembles"
W="$ROOT/t215"; build "$W"; rm -rf "$W/.git"
out="$W/docs/ReleaseNotes"
# A genuine export or tarball on a machine with Python but no git raised
# FileNotFoundError out of the very first probe, so the non-git fallback
# T6 documents was never reached and the run exited 1 having written
# nothing (Codex #1898 r3). Verified against the pre-fix file.
#
# A PATH FARM rather than a shim: prepending a directory cannot make git
# absent, only shadow it, and the fault under test is the executable not
# existing at all.
_farm="$ROOT/t215bin"; mkdir -p "$_farm"
for _d in /usr/bin /bin /usr/local/bin; do
  [ -d "$_d" ] || continue
  for _f in "$_d"/*; do
    _n="$(basename "$_f")"
    [ "$_n" = git ] && continue
    [ -e "$_farm/$_n" ] || ln -s "$_f" "$_farm/$_n" 2>/dev/null
  done
done
if PATH="$_farm" command -v git >/dev/null 2>&1 || ! PATH="$_farm" command -v python3 >/dev/null 2>&1; then
  skip "could not build a PATH with python3 and without git"
else
  msg="$(PATH="$_farm" bash "$out/assemble.sh" 2026-08-17 2>&1)"
  check "succeeds"              "$?"                                        "0"
  check "says git is missing"   "$(says "$msg" 'no git executable')"        "1"
  check "everything folded"     "$(sections "$out/ReleaseNotes-2026-08-17.md")" "2"
  check "nothing left pending"  "$(pending "$W")"                           "0"
fi

case_start "T216: an unreadable repository root aborts"
W="$ROOT/t216"; build "$W"
out="$W/docs/ReleaseNotes"
# The root lookup ignored its return code and used empty stdout, so every
# later relpath/ls-tree addressed nowhere (Codex #1898 r3). Pre-fix this
# refused with a MISLEADING "cannot read HEAD" — the downstream guard
# catching it is incidental to the working directory, which is exactly
# why the root cause needs its own check rather than a second guard's
# luck.
_fake="$ROOT/t216bin"; mkdir -p "$_fake"
_real_git="$(command -v git)"
cat > "$_fake/git" <<EOF216
#!/bin/sh
for a in "\$@"; do [ "\$a" = "--show-toplevel" ] && exit 9; done
exec "$_real_git" "\$@"
EOF216
chmod +x "$_fake/git"
msg="$(PATH="$_fake:$PATH" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "aborts"                "$?"                                              "1"
check "names the root lookup" "$(says "$msg" 'could not determine the repository root')" "1"
check "not the HEAD message"  "$(says "$msg" 'cannot read HEAD')"                "0"
check "nothing consumed"      "$(pending "$W")"                                 "2"

case_start "T213: an ASCII stdio encoding does not turn a run into a traceback"
W="$ROOT/t213"; build "$W"
out="$W/docs/ReleaseNotes"
# Nearly every diagnostic here carries an em dash. Under LC_ALL=C with
# the UTF-8 mode off, printing one raised UnicodeEncodeError (Codex #1898
# r2) — verified against the pre-fix file, which ends in a traceback from
# `print` rather than the normal exit. The same fault could fire AFTER
# publication and fragment clearing, where a traceback is the one answer
# this script must never give.
msg="$(LC_ALL=C PYTHONUTF8=0 PYTHONCOERCECLOCALE=0 \
  bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates 2>&1)"
check "the run succeeds"       "$?"                                   "0"
check "no traceback"           "$(says "$msg" 'Traceback')"           "0"
check "no encoding error"      "$(says "$msg" 'UnicodeEncodeError')"  "0"
check "the notes were written" \
  "$([ -e "$out/ReleaseNotes-2026-08-16.md" ] && echo wrote || echo none)" "wrote"

case_start "T214: an unsupported interpreter is refused, not run into a syntax error"
W="$ROOT/t214"; build "$W"
out="$W/docs/ReleaseNotes"
# `python` is still Python 2 on some workstations, and selecting it by
# NAME ran assemble.py straight into a syntax error — a traceback where
# the assembler's own diagnostics belong, before it could say what had or
# had not been consumed (Codex #1898 r2). Each candidate is asked its
# version instead, which also catches a python3 that is too old.
_fake="$ROOT/t214bin"; mkdir -p "$_fake"
for _n in python3 python; do printf '#!/bin/sh\nexit 1\n' > "$_fake/$_n"; chmod +x "$_fake/$_n"; done
msg="$(PATH="$_fake:/usr/bin:/bin" bash "$out/assemble.sh" 2026-08-16 2>&1)"
check "the run refuses"        "$?"                                        "1"
check "it names the floor"     "$(says "$msg" 'no Python 3.10 or newer')"   "1"
check "it says what it tried"  "$(says "$msg" "Tried 'python3'")"           "1"
check "nothing was consumed"   "$(pending "$W")"                           "2"

case_start "T212: SIGTERM DURING cleanup still releases the lock"
W="$ROOT/t212"; build "$W"
out="$W/docs/ReleaseNotes"
mkdir -p "$W/hooks"
# The earlier SIGTERM fix installed a handler that RAISES, and it stayed
# armed inside the cleanup that the handler exists to reach: a signal
# arriving mid-cleanup raised straight out of it, so the lock release
# below never ran (Codex #1898 r2). The seam fires at the top of cleanup,
# which is before that release.
cat > "$W/hooks/cleanup" <<'HK'
#!/bin/sh
kill -TERM "$ASSEMBLE_PID"
exit 0
HK
chmod +x "$W/hooks/cleanup"
ASSEMBLE_TEST_HOOK_DIR="$W/hooks" bash "$out/assemble.sh" 2026-08-16 --allow-mixed-dates \
  >/dev/null 2>&1
# CALIBRATED against the pre-fix code, which strands both working
# directories and prints a traceback out of cleanup. The stranded-
# directory assertion is the DISCRIMINATING one; the two below it held
# in both versions for this injection and are regression guards, kept
# because the whole point of the fix is that the release below the
# raise still runs.
check "no working directory is stranded" \
  "$(ls -d "$out"/.assemble-* >/dev/null 2>&1 && echo left || echo clean)" "clean"
check "the lock is not left behind (guard)" \
  "$(ls -d "$out/.assemble.lock" >/dev/null 2>&1 && echo held || echo free)" "free"
check "a later run is not blocked (guard)" \
  "$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1; echo $?)" "0"

# ── The one-home rule is a CONVENTION, not a test — T218 was removed ───────
# Rounds 6, 7, 8 and 11 each found a measured fact stated in two places and
# corrected in one. The answer was to give every figure a single home: the
# docstring of the rule it supports. A test (T218) was then added to enforce
# it, and DELETED two rounds later, which is worth recording rather than
# leaving as a gap somebody re-fills.
#
# It worked once — writing it immediately found a figure the release-note
# fragment had restated, which three manual sweeps had missed. Then it
# produced a false-positive finding in each of the next two rounds. Matching
# bare integers flagged an unrelated `PR #758`; matching a number plus one
# word from its row label flagged `758 published records`. Each fix bought
# one case, which is the shape this whole change exists to stop repeating.
#
# What settled it was not the false positives but the SCOPE. The guard read
# every pending fragment, so it constrained every release note anyone writes
# in future — unbounded, for a rule about one docstring's table. That is the
# unbounded-predicate pattern CLAUDE.md records from #1995, and it is a
# stiffer price than the defect.
#
# The rule stands and is stated where it applies. Enforcing it is review's
# job, because it is a rule about PROSE — which this change concluded three
# separate times is not mechanically checkable, and then tried to mechanise
# anyway.


case_start "T211: every retirement in the table is real"
# A retirement claims a case can no longer produce its fault. Read by
# eye, that claim was wrong nineteen times (Codex #1898 r2) — three git
# cases whose PATH shim still worked, and sixteen more that simply
# passed. So the claim is TESTED: re-run this same file with every
# retirement lifted, and require each retired case to fail. This case
# does not run inside that pass.
#
# The audit takes BOTH privilege passes, like any other run. Restricting
# it to one looked cheaper and was wrong: the permission-staged cases are
# SKIPPED under root, so a root-only audit cannot make them fail and then
# reports every one of them as a bogus retirement. T117 was the proof --
# it failed this guard on its first run for exactly that reason, not
# because its retirement was unjustified.
# Not in the NESTED pass either (Codex #1898 r3). Under root the parent's
# audit already runs both privilege levels, so re-running it as the
# unprivileged pass repeats hundreds of fixture builds and measures
# nothing the parent did not. When the suite is invoked unprivileged to
# begin with there is no nested pass, so the audit still runs — this
# suppresses a DUPLICATE, never the only copy.
if [ "${ASSEMBLE_TEST_AUDIT:-}" != "1" ] && [ "${ASSEMBLE_TEST_NESTED:-}" != "1" ]; then
  _audit_out="$ROOT/audit.log"
  ASSEMBLE_TEST_AUDIT=1 bash "$0" > "$_audit_out" 2>&1 || true
  # Attribute each FAIL to the case_start line above it, which is what
  # `case_start` exists for. `grep -B1` cannot do this: consecutive
  # FAILs make the previous line another FAIL.
  _audit_failed="$(awk '
    /^T[0-9A-Za-z]+:/ { split($0, a, ":"); cur = a[1] }
    /^  FAIL/         { if (cur != "") print cur }
  ' "$_audit_out" | sort -u)"
  # SKIPPED is a THIRD answer, not a quiet no (T117). A permission-staged
  # case cannot run as root and a root-staged one cannot run unprivileged,
  # so in a single-privilege environment some retired cases are simply
  # unmeasured — and counting those as "passed un-retired" condemned a
  # retirement that was perfectly sound. Only a case that RAN and did not
  # fail is a bogus retirement.
  _audit_skipped="$(awk '
    /^T[0-9A-Za-z]+:/ { split($0, a, ":"); cur = a[1] }
    /^  SKIP/         { if (cur != "") print cur }
  ' "$_audit_out" | sort -u)"
  _still_real=0
  _bogus=""
  _unmeasured=""
  for _rc in "${RETIRED_CASE_IDS[@]}"; do
    if printf '%s\n' "$_audit_failed" | grep -qx -- "$_rc"; then
      _still_real=$(( _still_real + 1 ))
    elif printf '%s\n' "$_audit_skipped" | grep -qx -- "$_rc"; then
      _unmeasured="$_unmeasured $_rc"
    else
      _bogus="$_bogus $_rc"
    fi
  done
  # The audit run must itself have produced failures — an audit that
  # silently ran nothing would make every retirement look unjustified
  # rather than justified, so it fails loudly instead of quietly.
  check "the audit pass ran and failed" \
    "$([ -n "$_audit_failed" ] && echo ran || echo empty)" "ran"
  check "no retirement survives without its retirement" \
    "$([ -z "$_bogus" ] && echo none || echo "$_bogus")" "none"
  # Named rather than counted, so an environment that cannot measure a
  # retirement says so instead of reporting a clean table. Under root
  # the audit takes both privilege passes, so this is normally empty.
  if [ -n "$_unmeasured" ]; then
    echo "  RTRD — unmeasured in this environment (privilege-staged):$_unmeasured"
  fi
fi

case_start "T11: argument handling"
W="$ROOT/t11"; build "$W"
S="$W/docs/ReleaseNotes/assemble.sh"
bash "$S" --nope              >/dev/null 2>&1; check "unknown option refused" "$?" "1"
bash "$S" 2026-08-16 2026-08-17 >/dev/null 2>&1; check "two dates refused"   "$?" "1"
bash "$S" 20260816            >/dev/null 2>&1; check "bad date format refused" "$?" "1"
bash -n "$SRC"                >/dev/null 2>&1; check "assemble.sh parses"    "$?" "0"

# ── A fragment heading that will not survive assembly is refused (#2288) ─────
# Two heading defects reached a publishable file in #2286 and nothing between
# authoring and publication looked at the line. Assembly is the last step that
# reads the heading — the review pass afterwards is for wording and the intro,
# not for auditing heading levels or PR numbers — so in practice what gets past
# here stays. (Not "a dated note is never re-edited": that was false, the
# README says editing wording is expected, and it took three rounds to remove
# because the same sentence had been written into four places.)
#
# The LEVEL: a fragment opening at `#` lands in the dated file as a second
# document title instead of nesting under the release title.
# The PR REFERENCE: `_TEMPLATE.md` ships the placeholder literally, and a
# fragment that keeps it publishes a section nothing can trace.
#
# ── ONE RULE FOR THE COMMENTS BELOW, and it is a root fix, not a style
#    preference (#2290 r6/r7/r8). Three consecutive review rounds found a
#    rationale corrected in `assemble.py` and left stale HERE — "a dated note
#    is never re-edited", the fixture-cost argument, and a count that had been
#    right in one file and wrong in the other. Each round fixed whichever copy
#    the finding happened to cite, which is what a duplicated account does.
#
#    So: a MEASURED FIGURE lives in exactly one place — the docstring of the
#    rule it supports — and every other mention states the rule and points
#    there. These comments say what a case pins and why it exists; they do not
#    re-derive the corpus. A figure written in two files is two figures.
#
#    (Figures that exist only here, like the counts of published headings that
#    motivated an r1/r2 case, stay here. The rule is one home each, not one
#    file for all of them.)
case_start "T217: a fragment heading that cannot survive assembly is refused"
W="$ROOT/t217"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '# Thread — opens at the wrong level (PR #4243)\n' > "$u/0003-level.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"              "$?"                                 "1"
check "it names the offending file"  "$(says "$msg" '0003-level.md')"     "1"
check "and what is wrong with it"    "$(says "$msg" 'opens at level 1, a second document title')" "1"
check "nothing was consumed"         "$(pending "$W")"                    "3"
check "no dated file was written"    "$([ -f "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md" ] && echo yes || echo no)" "no"

case_start "T217b: an unsubstituted PR placeholder is refused"
W="$ROOT/t217b"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '## Thread — never filled in (PR #NNNN)\n' > "$u/0003-placeholder.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"             "$?"                                      "1"
check "it names the file"           "$(says "$msg" '0003-placeholder.md')"    "1"
check "and says it is a placeholder" "$(says "$msg" 'placeholder')"           "1"
check "nothing was consumed"        "$(pending "$W")"                         "3"

# The residuals, pinned so that narrowing them later is a deliberate act and
# not an accident. Each is a shape the check deliberately allows; see the
# `check_heading_conformance` docstring for why.
case_start "T217c: the check allows what it deliberately does not police"
W="$ROOT/t217c"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
# No PR reference at all: allowed, because most real fragments carry none —
# the template's `(PR #<n>)` is a convention, not a rule the corpus follows.
# The figures are in `check_heading_conformance`'s docstring and deliberately
# not repeated here; see the note at the top of this section.
#
# NOT because requiring one would need ~70 fixtures here conformed. That was
# the reason this comment gave, a review round rejected it, and it is the
# right rejection: test churn is never a reason to weaken production
# behaviour. Left recorded rather than silently swapped, because it is the
# argument a future maintainer is most likely to reach for again.
printf '## a heading with no reference at all\n' > "$u/0003-noref.md"
# NO HEADING AT ALL USED TO BE ALLOWED HERE TOO, and #2295 inverted it: a
# fragment whose opening line is not an ATX heading is now REFUSED. The two
# allowances were never the same decision, and keeping them in one case made
# them look like one. A missing PR reference is a CONVENTION most real
# fragments do not follow, measured; a missing heading is a shape no fragment
# has ever had, and allowing it published eleven mangled shapes.
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the run succeeds"          "$?"                                                            "0"
check "all three are folded in"   "$(count_in '^<!-- assembled-fragment:' "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "3"
check "nothing left pending"      "$(pending "$W")"                                               "0"

# ── An INDENTED ATX heading is still a heading (#2290 r1) ───────────────────
# Markdown permits up to three leading spaces; at four it becomes an indented
# code block. Anchoring the heading test on `#` made ` # Thread — x` invisible
# to the check while GitHub still rendered it as a level-1 title, so it took
# the deliberate no-heading allowance and published the exact peer-document
# defect the check exists to stop.
case_start "T217d: an indented level-1 heading is refused, not read as absent"
W="$ROOT/t217d"; build "$W"
printf ' # Thread — indented past the anchor (PR #4243)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-indent.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"          "$?"                              "1"
check "it names the file"        "$(says "$msg" '0003-indent.md')" "1"
check "and reports level 1"      "$(says "$msg" 'opens at level 1, a second document title')" "1"
check "nothing was consumed"     "$(pending "$W")"                 "3"

# ── A PR reference carrying more than the number is valid (#2290 r1) ────────
# `(PR #2184, issue #2099)` is an established shape in this repository —
# seventeen such headings — and capturing to the closing parenthesis refused
# every one of them. A check that cannot pass on the project's own convention
# is a check that gets deleted.
case_start "T217e: a PR reference with trailing metadata is accepted"
W="$ROOT/t217e"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '## Thread — names its issue too (PR #2184, issue #2099)\n' > "$u/0003-issue.md"
printf '## Thread — supersedes another (PR #274, supersedes #273)\n' > "$u/0004-sup.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the run succeeds"     "$?"                                                                  "0"
check "all four folded in"   "$(count_in '^<!-- assembled-fragment:' "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "4"
check "nothing left pending" "$(pending "$W")"                                                     "0"

# ── A refusal must not have consumed the recovery set (#2290 r1) ────────────
# `clear_already_assembled` DELETES fragments whose text is already in the
# dated file. Validating after it meant a refused run had eaten its input,
# while the docstring claimed validation came first.
case_start "T217f: a malformed pending fragment does not consume an already-assembled one"
W="$ROOT/t217f"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the first run succeeds" "$?"               "0"
check "and consumed both"      "$(pending "$W")"  "0"
# Put one back, so it is "already assembled" but pending again, and add a
# malformed fragment beside it.
printf '## 0001-a\n' > "$u/0001-a.md"
printf '# Thread — malformed (PR #222)\n' > "$u/0002-bad.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the second run refuses"        "$?"                            "1"
check "naming the malformed one"      "$(says "$msg" '0002-bad.md')"  "1"
check "the recovered fragment SURVIVES" "$([ -f "$u/0001-a.md" ] && echo yes || echo no)" "yes"
check "nothing was consumed at all"   "$(pending "$W")"               "2"

# ── The PR reference is not always first in the parenthetical (#2290 r2) ────
# Nine published headings put it last — `(T-090 v1.2 #428, PR #<n>)`. Anchored
# on `\(PR #`, the check found nothing there, so a placeholder in that position
# read as "no reference at all" and took the deliberate allowance. A check that
# misses a shape does not merely fail to refuse it; it PERMITS it via the
# exemption, which is the same way the indentation gap failed in r1.
case_start "T217g: a placeholder later in the parenthetical is still caught"
W="$ROOT/t217g"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '## Thread — late placeholder (T-090 v1.2 #428, PR #TBD)\n' > "$u/0003-late-ph.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                              "1"
check "naming the file"        "$(says "$msg" '0003-late-ph.md')" "1"
check "as a placeholder"       "$(says "$msg" 'placeholder')"     "1"
check "nothing was consumed"   "$(pending "$W")"                  "3"

case_start "T217g2: a REAL number later in the parenthetical is accepted"
W="$ROOT/t217g2"; build "$W"
printf '## Thread — late but real (T-090 v1.2 #429, PR #2232)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-late-ok.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the run succeeds"     "$?"                                                                  "0"
check "all three folded in"  "$(count_in '^<!-- assembled-fragment:' "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "3"
check "nothing left pending" "$(pending "$W")"                                                     "0"

# ── A heading marker may be closed by a tab or by end-of-line (#2290 r2) ────
# `#<TAB>Title` and a contentless `#` are both level-1 ATX headings. Requiring
# a literal space let each one through the no-heading allowance.
case_start "T217h: tab-delimited and contentless headings are seen"
W="$ROOT/t217h"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '#\tThread — tab after the marker (PR #4243)\n' > "$u/0003-tab.md"
printf '#\n'                                           > "$u/0004-bare.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"          "$?"                            "1"
check "the tab one is named"     "$(says "$msg" '0003-tab.md')"  "1"
check "the bare one is named"    "$(says "$msg" '0004-bare.md')" "1"
check "nothing was consumed"     "$(pending "$W")"               "4"

# ── Markdown's OTHER heading syntax is NOT recognised, on purpose (r3 → r6) ─
# Setext support was added in r3 for a shape nobody had observed, and then
# produced a finding in each of the next three rounds: a list above a thematic
# break read as a heading (r5); the markerless-duplicate guard comparing a
# title line without its underline, refusing a fragment over ordinary prose
# (r6); a title wrapped across lines before its underline, which it missed
# (r6). The corpus settled it: every fragment ever committed opens with ATX and
# none contains a setext-shaped pair anywhere (counts in `first_heading`'s
# docstring). So the branch was REMOVED rather than refined (#2149's pattern),
# and these cases pin the residual: a setext title is published unexamined.
#
# Pinned so that re-adding setext is a deliberate act with these three rounds
# in view, and not a well-meant "the check missed one" patch.
# ── THE FOUR CASES BELOW WERE INVERTED BY #2295 ────────────────────────────
# Each one used to pin the no-heading ALLOWANCE: a shape the parser does not
# recognise was published and its source consumed. That allowance is gone —
# an unrecognised opening line is refused — so each case now pins the
# refusal instead. They are kept rather than deleted because the shapes are
# exactly the ones that reached published notes through the allowance, and a
# future revision that re-introduces it should have to turn these red.
case_start "T217i: a setext level-1 title is refused, not silently published"
W="$ROOT/t217i"; build "$W"
printf 'Thread — underlined with equals (PR #4243)\n=========\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-setext1.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                             "1"
check "it names the file"    "$(says "$msg" '0003-setext1.md')"               "1"
check "and names the line"   "$(says "$msg" 'opening line is not a')"         "1"
check "nothing was consumed" "$(pending "$W")"                                "3"

case_start "T217i2: a setext level-2 title is refused too, placeholder and all"
W="$ROOT/t217i2"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf 'Thread — underlined with dashes (PR #4244)\n---------\n' > "$u/0003-setext2.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                "1"
check "nothing was consumed" "$(pending "$W")"   "3"
# A placeholder in a setext title used to escape BOTH rules — the line was not
# recognised as a heading, so neither reached it, and the fragment published
# its `(PR #TBD)` unexamined. It is now refused for the opening line rather
# than for the placeholder, which is the right reason: the check cannot read
# that line, and says so.
W="$ROOT/t217i3"; build "$W"
printf 'Thread — setext with a placeholder (PR #TBD)\n----\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-setext-ph.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "it is refused, not published" "$?"                                     "1"
check "for the opening line"         "$(says "$msg" 'opening line is not a')" "1"
check "nothing was consumed"         "$(pending "$W")"                        "3"

# A list above a thematic break — the r5 finding — is not a heading, and is
# now refused for that. Pinned because it is the shape that made removing the
# setext parser worth it, and it would have been published before #2295.
case_start "T217i3b: a list above a thematic break is refused, not published"
W="$ROOT/t217i3b"; build "$W"
printf -- '- one\n- two\n---\n\nbody\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-list-break.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"              "1"
check "nothing was consumed" "$(pending "$W")" "3"

case_start "T217i4: prose with no underline is refused"
W="$ROOT/t217i4"; build "$W"
printf 'just prose, and the next line is blank\n\nmore prose\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-prose.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                     "1"
check "and names the line"   "$(says "$msg" 'opening line is not a')"  "1"
check "nothing was consumed" "$(pending "$W")"                         "3"

# ── Front matter is REFUSED, not skipped (#2290 r12) ───────────────────────
# Skipping it was the previous answer, and it created a worse problem than
# the masking it fixed: `build()` appends the fragment's RAW bytes after the
# release title, so a fragment the check had validated by skipping its front
# matter published that front matter as content — the opening `---` a
# thematic break, `title: x` over `---` a setext heading. The check blessed a
# document it had never actually looked at.
#
# Refusing costs nothing: zero of the 759 fragments ever committed open with
# front matter. Both shapes below are now refused for the SAME reason, which
# is the point — the old pair distinguished them by what came after.
case_start "T217j: a fragment opening with front matter is refused"
W="$ROOT/t217j"; build "$W"
printf -- '---\ntitle: x\n---\n\n# Peer document title (PR #TBD)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-fm-bad.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                                  "1"
check "naming the file"        "$(says "$msg" '0003-fm-bad.md')"     "1"
check "saying why"             "$(says "$msg" 'thematic break once folded')" "1"
check "nothing was consumed"   "$(pending "$W")"                     "3"

case_start "T217j2: front matter above a VALID heading is refused too"
W="$ROOT/t217j2"; build "$W"
printf -- '---\ntitle: x\n---\n\n## Thread - after front matter (PR #4246)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-fm-ok.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                              "1"
check "naming the file"      "$(says "$msg" '0003-fm-ok.md')"  "1"
check "nothing was consumed" "$(pending "$W")"                 "3"

# ── ONLY level 1 is refused, measured against practice (#2290 r6) ───────────
# An earlier revision required exactly level 2, which reads as the obvious
# rule and is wrong against what people actually write: about a fifth of every
# fragment ever committed opens at some level other than `##`, most of them at
# `###`, and one of those was in a pull request open while this was written and
# owned by other work (the breakdown is in `check_heading_conformance`'s
# docstring). Refusing a fifth of real input, some of it in flight elsewhere,
# is how a check gets deleted rather than obeyed. It is WARNED instead, and
# not because it is untidy: a deeper opener becomes a subsection of whatever
# shallower heading precedes it in the finished file, which is usually another
# change. See `check_heading_conformance`'s docstring.
case_start "T217k: a level-3 opener is WARNED, and still folded"
W="$ROOT/t217k"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '### Thread — opens deeper than the template (PR #4247)\n' > "$u/0003-l3.md"
printf '#### Thread — deeper still (PR #4248)\n'                   > "$u/0004-l4.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run succeeds"     "$?"                                                                  "0"
check "both folded in"       "$(count_in '^<!-- assembled-fragment:' "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "4"
check "nothing left pending" "$(pending "$W")"                                                     "0"
# The warning is the whole point of allowing it — a silent allowance would
# publish the misattribution below with nothing said.
check "it warns"             "$(says "$msg" 'open below level 2')"        "1"
check "naming the level-3"   "$(says "$msg" '0003-l3.md')"                "1"
check "naming the level-4"   "$(says "$msg" '0004-l4.md')"                "1"
check "and names the real outcome" "$(says "$msg" 'SUBSECTION of whatever shallower heading')" "1"
# The message is CONDITIONAL, because which heading absorbs the fragment
# depends on what precedes it in the finished file (#2290 r11), and the check
# deliberately does not re-derive the fold order to find out.
#
# SOMETHING SHALLOWER ALWAYS PRECEDES IT — `build()` writes `# Release Notes`
# as the file's first line (#2290 r18), so "where nothing shallower precedes
# it" was an impossible second case.
#
# NOR ARE THERE EXACTLY TWO (#2290 r21). A `####` opener after a `###` one
# lands under THAT — neither a `##` section nor the title. The message names
# the rule (nearest preceding shallower heading) and gives the title case as
# the endpoint, rather than enumerating outcomes that a deeper fragment can
# always add one more to.
check "and states the other case"  "$(says "$msg" 'release title itself')" "1"
check "and that it continues"      "$(says "$msg" 'not a refusal')"              "1"

# A WARNING MUST NOT EXEMPT THE REFUSAL. The first version of the warning
# block `continue`d, which let `### Title (PR #TBD)` publish its placeholder
# because the heading happened to be deep. Warnings and refusals are
# independent tests of the same line.
# ── A BOM is ALLOWED — refusing it was tried and removed (r11 → r21) ──────
# Refusing it closed a permit-by-misrecognition and then caused three
# findings of its own: it recognised only UTF-8 (r15), and twice it produced
# a reproduced DATA-LOSS path (r20, r21). Refusing a BOM tells the author to
# re-save the file, and that edit is exactly what stops the markerless
# duplicate guard recognising the copy already published.
#
# It guarded nothing — ZERO of the 759 fragments ever committed carry any
# byte-order mark — so it is the speculative branch this change has already
# removed twice. A BOM fragment is published, as it is on `main`, which has
# no heading check at all. #2295 refuses it properly, as an unrecognised
# opening line, without ever asking for a re-save.
# #2295 REFUSES IT AGAIN, AND THE DIFFERENCE IS THE MESSAGE, NOT THE VERDICT.
# The r11 refusal named the byte-order mark and told the author to re-save the
# file — and that edit is what made the markerless duplicate guard stop
# recognising the already-published copy, losing a fragment twice. The general
# rule names the LINE instead, so no remedy IT SUGGESTS rewrites the evidence
# another guard matches on — which is what the `never says re-save` assertion
# below pins, and it is the whole of the claim.
#
# IT IS NOT A CLAIM THAT THE TRAP IS OUT OF REACH (#2311 r3). An earlier
# revision of this comment read "reached without the trap", which overstates
# it by the distance between a message and an operator. For the UTF-16 case on
# the next lines, re-saving as UTF-8 is the obvious reading of the refusal
# even though the refusal never asks for it — and where the ALREADY-PUBLISHED
# copy is the UTF-16 one, that re-save is exactly what stops the markerless
# duplicate guard matching, so the next run appended a second copy and
# consumed the source until #2315. "Covers UTF-16/32, which the r11 clause never did" is therefore
# about the REFUSAL here, not about safety across the operator's remedy. The
# assertions below test only the single run; the two-run path is T217m5's.
case_start "T217m: a BOM-bearing fragment is refused for its opening line"
W="$ROOT/t217m"; build "$W"
printf '\xef\xbb\xbf## Thread — saved with a mark (PR #4249)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-bom.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                                     "1"
check "for the opening line"   "$(says "$msg" 'opening line is not a')"  "1"
check "never says re-save"     "$(says "$msg" 're-save')"                "0"
check "nothing was consumed"   "$(pending "$W")"                         "3"
# UTF-16 likewise, and it needs no clause of its own — the r11 refusal knew
# only UTF-8 and let this one through.
W="$ROOT/t217m2"; build "$W"
printf '\xff\xfe## Thread — saved as UTF-16 LE (PR #4250)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-bom16.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"              "1"
check "nothing was consumed" "$(pending "$W")" "3"

# ── The duplicate guard compares the PUBLISHED form (#2311 r4) ────────────
# `build()` appends `rewrite_links(raw)`, so a heading carrying a relative
# link is published with that link rewritten. The guard compared the pending
# fragment's own bytes against it, so `## … [the note](./x)` never matched
# the published `## … [the note](../x)`: the run appended a second copy and
# consumed the source — the one outcome in this script that loses work
# rather than refusing. Reproduced before the fix.
#
# The exemption that hid it — "neither substring can occur in an ATX marker"
# — is true of `first_heading`, which reads only the marker, and false here,
# where the whole line is compared. Both sub-cases below share one fixture
# shape and differ only in whether the heading carries a link, so a
# regression in the rewrite shows up as the first one passing and the
# second failing.
case_start "T217m4: a heading with a relative link still stops a markerless run"
W="$ROOT/t217m4"; build "$W"
out="$W/docs/ReleaseNotes"
printf '## Thread — see [the note](./x) (PR #4251)\n\nBody.\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-link.md"
# The legacy markerless file holds it as `build()` would have written it.
printf '# Release Notes — 2026-08-17\n\n## Thread — see [the note](../x) (PR #4251)\n\nBody.\n' \
  > "$out/ReleaseNotes-2026-08-17.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                              "1"
check "naming the fragment"    "$(says "$msg" '0003-link.md')"   "1"
check "nothing was consumed"   "$(pending "$W")"                 "3"
check "and it is not doubled"  \
  "$(count_in 'Thread — see' "$out/ReleaseNotes-2026-08-17.md")"  "1"
# The control: the same fixture with a link-free heading was ALREADY refused,
# which is what localises the defect to the rewrite rather than to the guard.
W="$ROOT/t217m4b"; build "$W"
out="$W/docs/ReleaseNotes"
printf '## Thread — see the note (PR #4251)\n\nBody.\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-plain.md"
printf '# Release Notes — 2026-08-17\n\n## Thread — see the note (PR #4251)\n\nBody.\n' \
  > "$out/ReleaseNotes-2026-08-17.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"              "1"
check "nothing was consumed" "$(pending "$W")" "3"

# ── A markerless file the guard cannot READ is refused, not compared (#2315) ─
# The duplicate guard compares heading lines as bytes, so it can answer only
# for a dated file whose text is in the encoding the pending fragment is
# compared in. A legacy interrupted run appended fragment bytes verbatim, so a
# fragment saved in another encoding sits in the published file in THAT
# encoding. Every case below is TWO runs, because one run was always safe —
# conformance refuses the unreadable pending copy — and the loss is in what
# follows: the author re-saves the pending copy as UTF-8, the published copy
# keeps its old encoding, the guard matches nothing, and the second run
# appended a duplicate and consumed the source. Reproduced on `main` for all
# three before the fix.
#
# Three fixtures because the rule has two arms and each needs its own
# evidence: UTF-16 with a BOM (invalid UTF-8 AND NUL-bearing), UTF-16 without
# one (valid UTF-8, caught only by the NUL arm), and a legacy single-byte
# encoding (no NUL, caught only by the UTF-8 arm).
enc() {  # enc <codec> <text> -> the text's bytes in that codec
  python3 -c 'import sys; sys.stdout.buffer.write(sys.argv[2].encode(sys.argv[1]))' "$1" "$2"
}
two_runs() {  # two_runs <dir> <codec> <heading>
  local w="$1" codec="$2" head="$3" o
  o="$w/docs/ReleaseNotes"
  { printf '# Release Notes — 2026-08-17\n\n'
    enc "$codec" "$head"$'\n\nBody.\n'
    printf '\n'; } > "$o/ReleaseNotes-2026-08-17.md"
  enc "$codec" "$head"$'\n\nBody.\n' > "$o/unreleased/0003-enc.md"
  msg="$(bash "$o/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
  check "run one refuses"            "$?"              "1"
  check "run one consumes nothing"   "$(pending "$w")" "3"
  # The author's obvious remedy, whatever run one's message said.
  printf '%s\n\nBody.\n' "$head" > "$o/unreleased/0003-enc.md"
  msg="$(bash "$o/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
  check "run two refuses"            "$?"                                    "1"
  check "for the unreadable file"    "$(says "$msg" 'cannot be read as')"    "1"
  check "run two consumes nothing"   "$(pending "$w")"                        "3"
  # A whole-line FIXED-string count: the heading carries `(PR #…)`, which an
  # ERE reads as a group, so `count_in` would match nothing and pass either way.
  check "and appends no UTF-8 copy"  \
    "$(grep -cxF -- "$head" "$o/ReleaseNotes-2026-08-17.md" || true)"        "0"
}
case_start "T217m5: an unreadable markerless file survives the author's re-save"
W="$ROOT/t217m5"; build "$W"
two_runs "$W" utf-16 '## Thread — folded in as UTF-16 (PR #4252)'
W="$ROOT/t217m5b"; build "$W"
two_runs "$W" utf-16-le '## Thread — folded in as bare UTF-16 (PR #4252)'
W="$ROOT/t217m5c"; build "$W"
two_runs "$W" cp1252 '## Thread — folded in as café (PR #4252)'
# The refusal is an operator decision point, not a dead end: having read the
# file, `--force-append` proceeds as it does for a matched heading.
out="$W/docs/ReleaseNotes"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates --force-append 2>&1)"
check "--force-append proceeds"     "$?"                                "0"
check "and still says so"           "$(says "$msg" 'cannot be read as')" "1"
# The control: a readable markerless file is compared, not refused.
W="$ROOT/t217m5d"; build "$W"
out="$W/docs/ReleaseNotes"
printf '# Release Notes — 2026-08-17\n\n## Thread — another change (PR #4253)\n\nBody.\n' \
  > "$out/ReleaseNotes-2026-08-17.md"
printf '## Thread — a new one (PR #4254)\n\nBody.\n' > "$out/unreleased/0003-new.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "a readable file assembles"   "$?"                                 "0"
check "without the unreadable note" "$(says "$msg" 'cannot be read as')" "0"
# A MARKED file is noted, not refused — the same gating the heading refusal
# has, and the same weakness (#2312). Pinned for the NOTE: whatever #2312
# decides about the verdict, an unread region must not pass unmentioned.
W="$ROOT/t217m5e"; build "$W"
out="$W/docs/ReleaseNotes"
{ printf '# Release Notes — 2026-08-17\n\n## Thread — marked (PR #4255)\n\nBody.\n'
  printf '<!-- assembled-fragment: 0009-old.md sha256=%064d -->\n\n' 0
  enc utf-16 $'## Thread — legacy UTF-16 (PR #4256)\n'; } > "$out/ReleaseNotes-2026-08-17.md"
printf '## Thread — a new one (PR #4257)\n\nBody.\n' > "$out/unreleased/0003-new.md"
msg="$(bash "$out/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "a marked file is not refused" "$?"                                 "0"
check "but the unread part is named" "$(says "$msg" 'cannot be read as')" "1"

# ── Author text cannot forge the assembler's own output (#2302) ───────────
# Refusals quote a fragment's opening line and its file name back to the
# operator. With nothing filtering them, `\x1b[2K\x1b[G` in that line erased
# the refusal on a terminal and printed a forged success over it — the run
# still refused, but the operator's account of it was forgeable. Both are now
# escaped at the two writers every message goes through, so the assertions
# look for the RAW byte (must be absent) and for its visible escape (must be
# present, because an operator hunting for the file needs to see it).
case_start "T217x: control characters in quoted author text are escaped"
W="$ROOT/t217x"; build "$W"
printf '# Peer — title\033[2K\033[Gassemble.sh: all fragments folded in (PR #4260)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-esc.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"            "$?"                                    "1"
check "no raw escape reaches it"   "$(printf '%s' "$msg" | grep -c $'\033' || true)" "0"
check "the escape is shown"        "$(says "$msg" '\x1b[2K\x1b[G')"        "1"
check "the em dash is untouched"   "$(says "$msg" '# Peer — title\x1b')"   "1"
check "nothing was consumed"       "$(pending "$W")"                       "3"
# A FILE NAME is quoted by far more messages than the opening line is, which
# is why the fix sits at the writers and not at each quoting site.
W="$ROOT/t217x2"; build "$W"
printf '# Peer title (PR #4261)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-"$'\033'"[2Kname.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "a named file still refuses" "$?"                                    "1"
check "no raw escape from a name"  "$(printf '%s' "$msg" | grep -c $'\033' || true)" "0"
check "the name's escape is shown" "$(says "$msg" '0003-\x1b[2Kname.md')"  "1"
# A bidirectional override reorders a line on screen with no escape at all.
W="$ROOT/t217x3"; build "$W"
printf '# Peer \342\200\256title (PR #4262)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-bidi.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "a bidi override is escaped" "$(says "$msg" '\u202e')"               "1"
# And an unbounded opening line is capped, not echoed whole.
W="$ROOT/t217x4"; build "$W"
{ printf '# '; printf 'x%.0s' $(seq 1 400); printf ' (PR #4263)\n'; } \
  > "$W/docs/ReleaseNotes/unreleased/0003-long.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "a long line is capped"      "$(says "$msg" 'more characters)')"     "1"
check "and not echoed whole"       "$(says "$msg" '(PR #4263)')"           "0"
# The cap is on the WHOLE quoted value, not on each piece of it (#2323 r1).
# Every `PR #BAD` token is far under the limit, so capping them one by one
# and then joining them produced tens of kilobytes; the fixture asserts the
# refusal stays short enough to read. A level-2 heading, so the placeholder
# refusal is the one that quotes the token list.
W="$ROOT/t217x5"; build "$W"
{ printf '## Many refs'; printf ' PR #BAD%.0s' $(seq 1 2000); printf '\n'; } \
  > "$W/docs/ReleaseNotes/unreleased/0003-refs.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "a token list still refuses"  "$?"                                    "1"
check "for the placeholder"         "$(says "$msg" 'is not a plain number')" "1"
check "and its output is bounded"   "$(( ${#msg} < 4000 ))"                 "1"

# ── The front-matter refusal is not escaped by trailing whitespace (r14) ───
# `---   ` and `---\t` are valid YAML delimiters. An exact comparison let
# either past the refusal and on to the no-heading allowance, publishing the
# front matter as a thematic break plus a setext heading and leaving any
# later `#` heading or placeholder unexamined.
#
# Trailing only. An INDENTED `---` is a thematic break rather than a fence —
# the r5 finding — so `.strip()` here would re-make that mistake.
case_start "T217n: a front-matter fence with trailing whitespace is still refused"
W="$ROOT/t217n"; build "$W"
printf -- '---   \ntitle: x\n---\n\n# Peer title (PR #TBD)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-fm-ws.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                      "1"
check "naming the file"      "$(says "$msg" '0003-fm-ws.md')"          "1"
check "nothing was consumed" "$(pending "$W")"                         "3"
# A tab delimiter, same rule.
W="$ROOT/t217n2"; build "$W"
printf -- '---\t\ntitle: x\n---\n\n# Peer title (PR #TBD)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-fm-tab.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                      "1"
check "nothing was consumed" "$(pending "$W")"                         "3"
# And an INDENTED `---` is NOT front matter — it is a thematic break. That
# distinction still holds and is still the point of this sub-case, but since
# #2295 it decides the MESSAGE rather than the verdict: the fragment is
# refused either way, and what this pins is that it is not refused as front
# matter, because telling an author to remove front matter they did not write
# sends them looking for something that is not there.
W="$ROOT/t217n3"; build "$W"
printf -- ' ---\nnot front matter, a thematic break\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-fm-indent.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                                     "1"
check "for the opening line"   "$(says "$msg" 'opening line is not a')"  "1"
check "not as front matter"    "$(says "$msg" 'front matter')"           "0"
check "nothing was consumed"   "$(pending "$W")"                         "3"

# ── A real number followed by punctuation is a real reference (r14) ────────
# The capture runs to the next comma, bracket or space, so `PR #123: final`
# captured `123:` and `isdigit()` called it a placeholder — refusing a valid
# reference and telling the operator to replace a placeholder that is not
# there. Verified against the published corpus before changing: the new rule
# refuses the same 179 headings and the same four tokens, zero differences.
# ── The reference token is ALL DIGITS, and that is where it stops (r17) ───
# Five consecutive rounds found an edge in this one rule and each fix opened
# the next: capture to `)` missed `:`; allowing punctuation missed an em dash;
# testing the first byte accepted `1TBD`; a non-alphanumeric boundary accepted
# `123_TBD`. Nine findings across eight rounds, more than any other rule here.
#
# What settles it is that EVERY disputed shape is hypothetical. Across the
# 2,076 published headings, the count of tokens beginning with a digit but not
# all digits is ZERO. The rule was being tuned against invented input.
#
# So it takes the strict side, deliberately, because the directions are not
# symmetric: refusing an ornamented reference costs one message to an author
# who can add a space, while accepting a non-number publishes a section
# nothing can trace and deletes the source. These cases pin the OVER-REFUSAL
# as intended behaviour, so that re-loosening it is a decision rather than a
# patch.
case_start "T217q: a number with anything appended is refused, on purpose"
W="$ROOT/t217q"; build "$W"
printf '## Thread — em dash, no spaces PR #123—final cleanup\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-emdash.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                 "1"
check "naming the token"     "$(says "$msg" 'is not a plain number')" "1"
check "nothing was consumed" "$(pending "$W")"                    "3"
# The message must NOT claim a placeholder — that was the real harm in r14,
# sending an author to look for something that is not in their heading.
check "and does not cry placeholder" "$(says "$msg" "template's placeholder")" "0"

case_start "T217o: a plain number is accepted, with or without a parenthesis"
W="$ROOT/t217o"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
printf '## Thread — plain (PR #123)\n'                       > "$u/0003-plain.md"
printf '## Thread — names its issue too (PR #456, issue #99)\n' > "$u/0004-meta.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the run succeeds"     "$?"                                                                  "0"
check "both folded in"       "$(count_in '^<!-- assembled-fragment:' "$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md")" "4"
check "nothing left pending" "$(pending "$W")"                                                     "0"

# ── The raw-HTML residual, pinned (#2290 r17) ─────────────────────────────
# `<h1>Title</h1>` renders as a heading on GitHub but is not Markdown syntax
# and is not detected, so such a fragment is ALLOWED. That residual was
# documented and never tested, while the release note claimed every residual
# was pinned — a coverage claim the suite did not support.
#
# Pinned here so the claim is true and so removing the allowance later is a
# visible decision rather than a silent behaviour change. Zero fragments have
# ever opened this way.
# INVERTED BY #2295. This used to be the worst instance of the allowance:
# `<h1>` renders on GitHub as a peer document title AND carries an
# unsubstituted placeholder, so the fragment published both defects the check
# exists to stop — because the line was not Markdown. It is refused now, and
# still without parsing any HTML: the rule is that the line must be an ATX
# heading, not that it must not be something.
case_start "T217r: a raw-HTML heading is refused, without parsing HTML"
W="$ROOT/t217r"; build "$W"
printf '<h1>Peer document title (PR #TBD)</h1>\n\nbody\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-rawhtml.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                     "1"
check "for the opening line" "$(says "$msg" 'opening line is not a')"  "1"
check "nothing was consumed" "$(pending "$W")"                         "3"

# ── A heading inside a container is not a heading here (#2295) ─────────────
# `> # Title` and `- # Title` render as headings on GitHub but are a block
# quote and a list item. Before the inversion they took the no-heading
# allowance and published a peer document title; now they are refused, and
# without the check having to know what a block quote is.
case_start "T217s: a heading inside a blockquote or list is refused"
W="$ROOT/t217s"; build "$W"
printf -- '> # Peer title in a quote (PR #TBD)\n\nbody\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-quote.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"      "$?"                                     "1"
check "for the opening line" "$(says "$msg" 'opening line is not a')"  "1"
check "nothing was consumed" "$(pending "$W")"                         "3"
W="$ROOT/t217s2"; build "$W"
printf -- '- # Peer title in a list (PR #TBD)\n\nbody\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-listitem.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "a list item too"      "$?"              "1"
check "nothing was consumed" "$(pending "$W")" "3"

# ── CR-ONLY LINE ENDINGS (#2295) ───────────────────────────────────────────
# NOT closed by the inversion, which is why it gets its own case rather than
# a line in a list: a CR-only file's opening line IS a valid ATX heading, so
# refusing unrecognised openers never reached it. What was wrong is narrower
# — splitting on `\n` alone made the whole file read as ONE line, so the
# PR-reference scan ran over the entire body and refused the fragment for a
# `PR #<n>` written in its prose. Splitting on all three CommonMark line
# endings bounds the heading correctly.
#
# Both directions are pinned, because a fix that only ever refuses is
# indistinguishable from the bug it replaced.
case_start "T217t: a CR-only fragment is judged on its heading, not its body"
W="$ROOT/t217t"; build "$W"
printf -- '## Thread — saved with CR endings (PR #4251)\r## a later heading\rbody mentioning PR #TBD\r' \
  > "$W/docs/ReleaseNotes/unreleased/0003-cr-ok.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "a valid heading passes"   "$?"              "0"
check "nothing left pending"     "$(pending "$W")" "0"
# And a placeholder in the heading of a CR-only file is still caught.
W="$ROOT/t217t2"; build "$W"
printf -- '## Thread — CR endings, unsubstituted (PR #TBD)\rbody\r' \
  > "$W/docs/ReleaseNotes/unreleased/0003-cr-ph.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"       "$?"                            "1"
check "as a placeholder"      "$(says "$msg" 'placeholder')"   "1"
check "nothing was consumed"  "$(pending "$W")"                "3"

# ── ONE LINE DEFINITION, ENFORCED RATHER THAN REMEMBERED (#2301 r3) ───────
# THE ROOT ARREST. Three consecutive review rounds each found a DIFFERENT
# scan still splitting on `\n` alone after `first_heading` learned about
# CR-only files: r1 the `---` check's idea of blankness, r2 the markerless
# duplicate guard, r3 the two marker scans and `out_has_markers`. Every one
# was found by a human reading the file, one site per round, and each fix
# left the remaining sites looking exactly as correct as the fixed one.
#
# Patching a fourth would be the same move a fourth time. What makes it stop
# is that the invariant is now CHECKED: no line-splitting in the assembler
# except through the shared definition.
#
# This is a test on a STRING, deliberately — the presence of a literal
# idiom in one file — and not an inference about what any call site means.
# That distinction is why it is safe to have; `CLAUDE.md` records at length
# (#1995) what happens to a guard that tries to reason about behaviour
# instead.
case_start "T217w: the assembler splits lines in exactly one way"
bad_splits="$(grep -nE '\.split\(b"\\n"\)|\.splitlines\(\)' "$IMPL" || true)"
check "no ad-hoc line splitting" "$([ -z "$bad_splits" ] && echo 0 || echo 1)" "0"
if [ -n "$bad_splits" ]; then
  echo "     sites still splitting outside LINE_END_RE:" >&2
  echo "$bad_splits" | sed 's/^/       /' >&2
fi
# The shared definition itself must exist and cover all three endings, or the
# check above passes against a splitter that is silently LF-only again.
check "LINE_END_RE covers CR, LF and CRLF" \
  "$(grep -cE 'LINE_END_RE = re\.compile\(rb"\\r\\n\|\\r\|\\n"\)' "$IMPL")" "1"

# ── THE DUPLICATE GUARD MUST SPLIT LINES THE SAME WAY (#2301 r2) ──────────
# A DATA-LOSS path, and a regression this PR introduced before catching it:
# making CR-only fragments publishable while `check_markerless_duplicates`
# still split on `\n` alone meant the guard read such a fragment as ONE line,
# matched nothing in a legacy markerless dated file that already held the
# section, appended a SECOND copy and consumed the source. The parent commit
# had refused the same fragment, so the gap turned a refusal into lost work.
# The r3 chain, end to end: a CR-only fragment carrying a marker-shaped line
# must be refused for that line, not published with the record embedded. If
# it publishes, a later normalisation of the dated file to LF makes the
# record authoritative to `scan_markers`, which can clear a DIFFERENT pending
# fragment unread — data loss at one remove.
case_start "T217v0: a marker record inside a CR-only fragment is caught"
W="$ROOT/t217v0"; build "$W"
printf -- '## Thread — carries a record (PR #4256)\rbody\r<!-- assembled-fragment: 0001-a.md sha256=%064d -->\r' 0 \
  > "$W/docs/ReleaseNotes/unreleased/0003-cr-marker.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                                      "1"
check "naming the fragment"    "$(says "$msg" '0003-cr-marker.md')"      "1"
check "nothing was consumed"   "$(pending "$W")"                         "3"

case_start "T217v: a CR-only fragment already published is not appended twice"
W="$ROOT/t217v"; build "$W"
u="$W/docs/ReleaseNotes/unreleased"
d="$W/docs/ReleaseNotes/ReleaseNotes-2026-08-17.md"
# A markerless dated file that already holds the section, with LF endings.
printf '# Release Notes — 2026-08-17\n\nintro\n\n## Thread — already folded in (PR #4255)\n\nbody\n' > "$d"
# The same fragment still pending, saved with CR endings.
printf -- '## Thread — already folded in (PR #4255)\rbody\r' > "$u/0003-cr-dup.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"        "$?"                                  "1"
check "naming the fragment"    "$(says "$msg" '0003-cr-dup.md')"     "1"
check "the source is retained" "$(pending "$W")"                     "3"
check "not appended twice"     "$(count_in '^## Thread — already folded in' "$d")" "1"

# ── BLANK MEANS SPACES AND TABS, not Python's idea of whitespace (#2301) ───
# `bytes.strip()` also counts a vertical tab, a form feed and the C0
# separators. A fragment opening with a lone `\x0b` was therefore skipped past
# to the heading below and ACCEPTED — published with a stray control
# character above its title, and in contradiction of the rule that the opening
# line must be the heading. CommonMark counts only spaces and tabs.
case_start "T217u: a control character above the heading is not a blank line"
W="$ROOT/t217u"; build "$W"
printf -- '\x0b\n## Thread — heading under a vertical tab (PR #4252)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-vtab.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"       "$?"                                     "1"
check "for the opening line"  "$(says "$msg" 'opening line is not a')"  "1"
check "nothing was consumed"  "$(pending "$W")"                         "3"
# A form feed likewise.
W="$ROOT/t217u2"; build "$W"
printf -- '\x0c\n## Thread — heading under a form feed (PR #4253)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-ff.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "refused too"           "$?"              "1"
check "nothing was consumed"  "$(pending "$W")" "3"
# Real blank lines — empty, spaces, tabs — are still skipped, or every
# fragment that opens after one would now be refused.
W="$ROOT/t217u3"; build "$W"
printf -- '\n   \n\t\n## Thread — after genuine blank lines (PR #4254)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-blanks.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "still accepted"        "$?"              "0"
check "nothing left pending"  "$(pending "$W")" "0"

case_start "T217k2: a deep heading is still refused for its placeholder"
W="$ROOT/t217k2"; build "$W"
printf '### Thread — deep AND unsubstituted (PR #TBD)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-deep-ph.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"       "$?"                              "1"
check "as a placeholder"      "$(says "$msg" 'placeholder')"     "1"
check "nothing was consumed"  "$(pending "$W")"                  "3"

# And a refusing run does not also print the warning — one verdict per run,
# so the operator is not told "assembly continues" by a run that stopped.
check "no warning on a refusal" "$(says "$msg" 'not a refusal')" "0"

# ── EVERY PR token is checked, not just the first (#2290 r6) ────────────────
# `(PR #123, PR #TBD)` satisfied a `search`, which returns the numeric one and
# never looks further — the guard passing on the evidence that should have
# refused it. No heading in the corpus carries two tokens, so this refuses
# nothing that exists; it closes a way to satisfy the check with a prefix.
case_start "T217l: a placeholder after a real number is still caught"
W="$ROOT/t217l"; build "$W"
printf '## Thread — one real, one not (PR #123, PR #TBD)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-two-refs.md"
msg="$(bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates 2>&1)"
check "the run refuses"          "$?"                                "1"
check "naming the file"          "$(says "$msg" '0003-two-refs.md')" "1"
check "as a placeholder"         "$(says "$msg" 'placeholder')"      "1"
check "nothing was consumed"     "$(pending "$W")"                   "3"
# And two REAL references are still fine — the allowance side of the same rule.
W="$ROOT/t217l2"; build "$W"
printf '## Thread — supersedes an earlier one (PR #123, PR #456)\n' \
  > "$W/docs/ReleaseNotes/unreleased/0003-two-real.md"
bash "$W/docs/ReleaseNotes/assemble.sh" 2026-08-17 --allow-mixed-dates >/dev/null 2>&1
check "the run succeeds"     "$?"              "0"
check "nothing left pending" "$(pending "$W")" "0"

echo ""
if (( RETIRED > 0 )); then
  echo "assemble.test.sh: $RETIRED assertion(s) RETIRED — the shell construct each"
  echo "  pinned no longer exists (#1877); every one states its reason inline."
fi
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
