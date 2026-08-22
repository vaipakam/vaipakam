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
#   bash docs/ReleaseNotes/assemble.sh --force-append      # append even where
#                                                          # a markerless file
#                                                          # looks like it may
#                                                          # already hold it
#
# The dated file is created with a header if absent, or appended to if
# it already exists. Review the result, add an intro paragraph by hand,
# then `git add -A docs/ReleaseNotes/` and commit.
#
# Crash safety (#1788). Two steps cannot be made one: replacing the dated
# file, and removing the fragments it consumed. Both windows are closed,
# by different means.
#
#   Interrupted BEFORE the dated file is replaced — the whole assembly is
#   built in a temp file and renamed into place at the end, so the dated
#   file is either the old one or the complete new one. Never a partial
#   append, and never the header-only stub that the next run would take
#   for a real existing file and append to. Just re-run.
#
#   Interrupted AFTER the rename, before the fragments are removed — the
#   content is in place and the fragments are still pending, which used
#   to make the next run append them a SECOND time: duplicated prose in a
#   published document, silently, with nothing lost to hint at it. Each
#   folded fragment now leaves an invisible marker in the dated file, so
#   the next run recognises it, removes it, and does not re-append. The
#   marker records a HASH of the fragment, not just its name, and every
#   dated file is searched rather than only today's — see the recovery
#   block for the several ways a name-only match went wrong.
#
# Either way the recovery is the same: run the script again. It says
# which fragments it found in that state rather than acting silently.
#
# TWO states need a manual step.
#
# The first is NOT limited to a hard kill (Codex #1863 r34). An ordinary
# Ctrl-C landing after a fragment has been moved into
# `unreleased/.assembled/` but before it is hashed or removed leaves it
# there: cleanup releases the lock and removes temporary files, but it
# does not move a fragment back. It is reported rather than acted on,
# because nothing distinguishes "already folded in" from "a newer edit" —
# compare it against the dated file, then delete it or move it back up a
# level.
#
# Cleanup deliberately does not restore it. By then the original path may
# hold a file somebody has just saved, and putting the older copy back
# over it would destroy the newer text — the fault this whole mechanism
# exists to prevent, committed by the recovery for it.
#
# The second needs a HARD kill (SIGKILL, or the machine dying), where no
# trap runs at all: the lock directory is left behind.
# Later runs then stop with "another assembly appears to be running"
# until it is removed. Deliberate — the lock guards a step that deletes
# files, so a stale one is reported with its `rmdir` rather than cleared
# on a guess about whether the other process is alive. Ordinary
# interruption, Ctrl-C included, releases it.
# Where it CANNOT tell — a dated file with no markers at all, from before
# they existed or because one was edited away — it stops and asks rather
# than guessing in either direction. `--force-append` is the override.

set -euo pipefail

# `pwd -P`, not `pwd`. Every path comparison below is against
# `git rev-parse --show-toplevel`, which is always PHYSICAL. A logical `pwd`
# through a symlinked checkout returns the symlink path instead, the repo-root
# prefix then fails to strip, and every fragment's `HEAD:<rel>` lookup misses —
# so each one reads as newly written and the whole selection pass silently
# becomes a no-op. Not an edge case when it happens: it disables the guard
# entirely, for every fragment, while looking like an ordinary successful run.
# Bash 4+ REQUIRED, and checked here so the failure is one clear line at the
# top rather than a `mapfile: command not found` partway through a run. Stock
# macOS ships Bash 3.2, where `mapfile` and `declare -A` do not exist.
#
# Declared rather than worked around. Both are load-bearing: `mapfile` is what
# keeps a fragment whose name holds a glob metacharacter from silently vanishing
# from the list, and `declare -A` keys the staged-rename map and the shallow
# boundary set by arbitrary path strings, which Bash 3 can only fake by encoding
# paths into variable names. Two sibling scripts in this repo already require
# Bash 4 the same way (`run-regression.sh` uses `mapfile` + `declare -A`,
# `deploy-chain.sh` uses `declare -A`), and `run-regression.sh` additionally
# needs GNU `find -printf`. The baseline was already Bash 4; what was missing
# was saying so. `brew install bash` on macOS.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "Error: this script requires Bash 4 or newer (found ${BASH_VERSION})." >&2
  echo "" >&2
  echo "It uses mapfile and associative arrays, both absent from the Bash 3.2" >&2
  echo "that stock macOS ships. Install a newer bash (e.g. 'brew install bash')" >&2
  echo "and run it with that, e.g. '/opt/homebrew/bin/bash ${BASH_SOURCE[0]}'." >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
UNREL="$DIR/unreleased"

# Provenance marker written after each folded fragment (#1788). An HTML
# comment: invisible in every rendered view of the notes, and the record
# the next run reads to tell "already folded" from "still pending".
# Full form: `<!-- assembled-fragment: <basename> sha256=<hex> -->`. The
# NAME is for the operator reading the file; the HASH is the identity the
# recovery below matches on, because a name is neither stable (a fragment
# can be renamed) nor unique to its content (a name can be reused for
# different text). See that block for why getting this wrong is worse
# than the bug it fixes.
MARKER_PREFIX='<!-- assembled-fragment: '

# A literal carriage return, for the marker patterns below. POSIX ERE has
# no `\r` escape — GNU grep reads it as a literal `r` — so writing
# `-->\r?$` silently matches "--> optionally followed by the letter r"
# and never the thing intended. The byte has to be put in by the shell.
CR=$'\r' 

# Content identity for a fragment, hashed from its ORIGINAL bytes before
# any link rewriting — which is what makes it exact rather than
# approximate (see the recovery block below). Resolved once: `sha256sum`
# on Linux, `shasum -a 256` on macOS, and a hard error rather than a
# silent fallback if neither exists, because a degraded identity here
# would authorise deleting a fragment on a guess.
#
# Hashed from STDIN, never by passing the path (Codex #1863 r2). Both
# tools escape a filename containing a backslash and prefix the whole
# line with `\`, so `cut -f1` returns `\<hash>` — which is written into
# the marker, then rejected by the strict parser below, so the fragment
# is never recognised on recovery and its section is appended twice. The
# one file shape that most needs the guarantee is the one that loses it.
# Redirecting the file in removes the filename from the output entirely.
if command -v sha256sum >/dev/null 2>&1; then
  frag_hash() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  frag_hash() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  echo "Error: neither sha256sum nor shasum found." >&2
  echo "" >&2
  echo "This script identifies an already-assembled fragment by the hash of" >&2
  echo "its contents, so it cannot run safely without one of them." >&2
  exit 1
fi

# ── A file's mode, as octal digits ───────────────────────────────────────────
# Sets MODE_READ and returns 0, or returns 1 with MODE_READ meaningless.
#
# GNU first, then BSD. If BOTH fail the mode is UNKNOWN, and a caller
# falling back to the new-file default would silently WIDEN an existing
# file — a deliberately restricted 0600 becoming 0644 under the usual
# umask (Codex #1863 r10). "I could not read it" and "there is nothing to
# read" are different answers, so this reports failure rather than
# guessing.
#
# Each form is tried with its OWN status (Codex #1863 r12), and the
# status is checked BEFORE the shape: a `stat` that prints a plausible
# `644` and exits non-zero was once accepted by the regex alone, and an
# existing 0600 file was then widened before its fragments were consumed.
# Shape cannot tell a real answer from a failed one that looks like one.
read_mode() {  # read_mode <path>
  local rc=0
  MODE_READ="$(stat -c '%a' "$1" 2>/dev/null)" || rc=$?
  if (( rc != 0 )); then
    rc=0
    MODE_READ="$(stat -f '%Lp' "$1" 2>/dev/null)" || rc=$?
  fi
  (( rc == 0 )) || return 1
  [[ "$MODE_READ" =~ ^[0-7]{3,4}$ ]] || return 1
  return 0
}

# ── A file's group ───────────────────────────────────────────────────────────
# Same GNU-then-BSD shape as read_mode, and the same reason for checking
# the status separately from the shape.
read_gid() {  # read_gid <path>; sets GID_READ
  local rc=0
  GID_READ="$(stat -c '%g' "$1" 2>/dev/null)" || rc=$?
  if (( rc != 0 )); then
    rc=0
    GID_READ="$(stat -f '%g' "$1" 2>/dev/null)" || rc=$?
  fi
  (( rc == 0 )) || return 1
  [[ "$GID_READ" =~ ^[0-9]+$ ]] || return 1
  return 0
}

# ── Where a fragment goes when it is set aside ───────────────────────────────
# A SUBDIRECTORY, so the fragment keeps its own name (Codex #1863 r21,
# r22, r23, r24, r25 — five rounds of the same subject).
#
# The previous approach glued `.assembled.` onto the front of the name.
# That made this script capable of turning a legal name into an illegal
# one, and every attempt to bound it produced another finding: measured
# in characters rather than bytes, a fixed threshold assuming NAME_MAX is
# 255, a fallback that reimposed the same assumption when `getconf`
# failed, a floor of 32 that discarded smaller real limits, and a
# second name shape the recovery scan did not know to look for. All of
# it failed AFTER the dated file was published, which is the worst place
# in this script to fail.
#
# A directory removes the question rather than answering it: the name is
# not modified, so a name that was legal as a fragment is legal here. No
# limit to query, no truncation, no second form, nothing to keep in sync.
# Deleting the machinery fixed three of that round's findings outright.
QDIR="$UNREL/.assembled"

# Whether the pool restricts unlinking to owners. Resolved once, used per
# fragment in the final gate.
STICKY_POOL=0
if [ -k "$UNREL" ]; then STICKY_POOL=1; fi

# Created and checked BEFORE anything is published (Codex #1863 r26).
# Introduced as a step inside the clearing loop, its first failure — a
# stale file or a dangling symlink sitting at that path — happened only
# AFTER the dated file was renamed into place, leaving the run half done
# and every retry blocked at the same point. A prerequisite this script
# invented must not be able to fail where failure is expensive.
#
# Also verified to be on the SAME FILESYSTEM as the pool. `mv` is only
# the atomic rename the set-aside argument depends on within one
# filesystem; across a mount boundary it degrades to copy-then-unlink,
# and a writer opening the original path between the two has its bytes
# unlinked while the copy keeps the older text (Codex #1863 r26). That
# is precisely the loss the quarantine exists to prevent, so it is
# refused rather than accepted quietly.
_ensure_qdir() {
  if [ -L "$QDIR" ] || { [ -e "$QDIR" ] && [ ! -d "$QDIR" ]; }; then
    echo "Error: $QDIR exists and is not a directory." >&2
    echo "Refusing to assemble: fragments set aside during the run are moved" >&2
    echo "there, and this would fail after the dated file was written." >&2
    exit 1
  fi
  if ! mkdir -p "$QDIR"; then
    echo "Error: could not create $QDIR." >&2
    echo "Refusing to assemble: see above; the failure is cheap here and" >&2
    echo "expensive later." >&2
    exit 1
  fi
  # WRITABLE, not merely present (Codex #1863 r27). `mkdir -p` succeeds on
  # a directory that already exists whatever its mode, so a 0555 one
  # passed the check and the first set-aside then failed after the dated
  # file had been published. Existence was never the question; being able
  # to put a file there is.
  # A NEW entry, and its removal is required (Codex #1863 r28). `: >`
  # TRUNCATES an existing file, which succeeds on a writable `.probe`
  # inside an otherwise unwritable directory — so the probe passed while
  # the thing it stands for, creating a directory entry, would still
  # fail. Creating and removing an entry is the operation being tested,
  # so that is the operation to perform.
  _probe_f=""
  # Signals held off across creating the entry and recording its path
  # (Codex #1863 r30) — the same two-instruction window the lock
  # acquisition has, and the same reason: bash checks traps BETWEEN
  # commands, so a signal landing after `mktemp` returns but before the
  # assignment runs leaves cleanup looking at an empty variable and the
  # random dotfile behind. Tracking the path was necessary and, on its
  # own, not sufficient.
  trap '' INT TERM
  if ! _probe_f="$(mktemp "$QDIR/.probe.XXXXXX" 2>/dev/null)"; then
    trap '_cleanup; exit 130' INT
    trap '_cleanup; exit 143' TERM
    echo "Error: entries cannot be created and removed in $QDIR." >&2
    echo "Refusing to assemble: fragments set aside during the run are moved" >&2
    echo "there, so this would fail only after the dated file was written." >&2
    exit 1
  fi
  # Tracked so the trap removes it if a signal lands before the rm below.
  PROBE="$_probe_f"
  trap '_cleanup; exit 130' INT
  trap '_cleanup; exit 143' TERM
  if ! rm "$_probe_f" 2>/dev/null; then
    rm -f "$_probe_f" 2>/dev/null || :
    echo "Error: entries cannot be created and removed in $QDIR." >&2
    echo "Refusing to assemble: fragments set aside during the run are moved" >&2
    echo "there, so this would fail only after the dated file was written." >&2
    exit 1
  fi
  PROBE=""
  local a b
  a="$(stat -c '%d' "$UNREL" 2>/dev/null || stat -f '%d' "$UNREL" 2>/dev/null)" || a=""
  b="$(stat -c '%d' "$QDIR"  2>/dev/null || stat -f '%d' "$QDIR"  2>/dev/null)" || b=""
  if [ -z "$a" ] || [ -z "$b" ]; then
    # "Cannot tell" is not "is wrong". Refusing here would make a working
    # `stat` a hard dependency of assembling release notes, for a check
    # guarding an arrangement nobody has: this directory is created
    # inside the pool, so it differs only if something is mounted there.
    # Said out loud rather than assumed either way.
    echo "Warning: could not confirm $QDIR is on the same filesystem as the" >&2
    echo "pool. If it is a mount point, setting a fragment aside is a copy" >&2
    echo "and delete rather than a rename, and a concurrent write to the" >&2
    echo "original could be lost." >&2
  elif [ "$a" != "$b" ]; then
    echo "Error: $QDIR is not on the same filesystem as $UNREL." >&2
    echo "" >&2
    echo "Refusing to assemble: setting a fragment aside relies on the move" >&2
    echo "being a rename. Across a filesystem boundary it becomes a copy" >&2
    echo "followed by a delete, and anything writing to the original path in" >&2
    echo "between has its text deleted while the copy keeps the older" >&2
    echo "version — the loss setting aside exists to prevent." >&2
    exit 1
  fi
}

# ── What this script defends against, and what it does not ───────────────────
# Stated because forty rounds of review kept escalating past it, and an
# unstated boundary cannot be argued with (Codex #1863 r40).
#
# IN SCOPE. The operator's own environment behaving ordinarily but
# awkwardly: a run interrupted at any point, an editor saving a file
# mid-run, a second assembly started by mistake, a filesystem that
# refuses something, a name or byte the shell handles badly. Everything
# above is about those, and they are the reason a release-notes
# assembler needs any of this: they happen by accident, routinely, and
# they cost text.
#
# NOT IN SCOPE. A hostile co-tenant with write access to
# docs/ReleaseNotes/. Not because such races are unreal — they are — but
# because anyone holding that access can delete the fragments, rewrite
# the dated file, or edit THIS SCRIPT, all without racing anything. A
# guard here would protect the least convenient of their options while
# the direct ones stay open, which is the appearance of security rather
# than security.
#
# The concrete consequence: the pool lock is a directory, and a
# co-tenant with write access to the pool can remove it and let a second
# run start. That is a real property of directory locking in a shared
# directory, it is not fixable in bash without a locking primitive the
# shell does not have, and it is out of scope for the reason above
# rather than by oversight. See #1877.
#
# Where a defence costs nothing, it is taken anyway — the replacement is
# built inside a private directory, and no `chmod` is applied to a path
# another party could substitute. Cheap is worth doing; the line is
# drawn at contorting the design for an adversary who does not need to
# beat it.

# ── The one invariant this script keeps ──────────────────────────────────────
# Three rounds of review in a row (r17, r18, r19) found the same abstract
# fault in three different places: evidence read at one moment
# authorising an irreversible act at a later one. Mode, then ownership,
# then marker records. Patching the third instance would have invited a
# fourth, so the rule is stated once and enforced the same way
# everywhere:
#
#   NOTHING IRREVERSIBLE HAPPENS WITHOUT REVALIDATING THE EVIDENCE IT
#   RESTS ON, AGAINST BYTES THAT CANNOT HAVE CHANGED UNDER THE RUN.
#
# This script does exactly three irreversible things — replace the dated
# file, delete a fragment recognised as already folded in, and delete a
# fragment it has just folded in — and each is now preceded by that
# check. Fragment evidence is made immutable a second way, by copying
# each fragment once and reading only the copy (see FRAG_SNAP below), so
# validation, hashing and assembly cannot disagree about what a fragment
# said.
#
# ── A file's full identity ───────────────────────────────────────────────────
# Content plus the metadata a replacement would carry over. The rename
# installs a NEW inode owned by whoever ran the script and wearing the
# mode this run resolved, so a concurrent `chmod` or `chown` is undone by
# it — silently, and in the widening direction, which is the direction
# that matters (Codex #1863 r18, r19). Content-only revalidation cannot
# see either, because nothing about the content changed.
# IDENTITY_FAIL names the part that failed, so the caller's message can
# say which — "could not read it" is three different faults, and the one
# that matters most (the mode) is the one that silently widens a
# restricted file if it is ever guessed at.
file_identity() {  # file_identity <path>; sets IDENTITY, non-zero on failure
  local rc=0 _own
  IDENTITY_FAIL=""
  if ! read_mode "$1"; then
    IDENTITY_FAIL="reading its current mode"
    return 1
  fi
  # GNU first, then BSD, same shape as read_mode and for the same reason.
  _own="$(stat -c '%u:%g' "$1" 2>/dev/null)" || rc=$?
  if (( rc != 0 )); then
    rc=0
    _own="$(stat -f '%u:%g' "$1" 2>/dev/null)" || rc=$?
  fi
  if (( rc != 0 )) || [[ ! "$_own" =~ ^[0-9]+:[0-9]+$ ]]; then
    IDENTITY_FAIL="reading its owner"
    return 1
  fi
  rc=0
  IDENTITY="$(frag_hash "$1")" || rc=$?
  if (( rc != 0 )) || [[ ! "$IDENTITY" =~ ^[0-9a-f]{64}$ ]]; then
    IDENTITY_FAIL="reading its contents"
    return 1
  fi
  IDENTITY="$IDENTITY mode=$MODE_READ owner=$_own"
  return 0
}

# ── Running a command whose failure must not be silent ───────────────────────
# Four separate findings on #1863 (r6, r7, r8, and one found by auditing
# for the same shape) were ONE defect written four times:
#
#     value="$(some_command "$arg" || true)"
#
# A failing command then yields an empty — or worse, a plausible —
# value, the script carries on, and something irreversible happens on the
# strength of it: a marker written with no hash, a marker glued onto a
# fragment's last line, a fragment dropped from a duplicate check. Each
# was fixed where it was found, which left the NEXT instance to be found
# by someone else.
#
# So it is a function now rather than a convention. Status and output are
# always both examined, the failure always names what was being done, and
# a new call site cannot reintroduce the shape without deliberately
# avoiding this helper.
#
# `ok_codes` is a comma list because "no match" is a legitimate answer
# from `grep` (exit 1) while a READ ERROR from the same command (exit >1)
# is not — flattening those two together is exactly how the guard at the
# markerless-file check stopped covering one of its inputs.
#
# The result goes in a global rather than being echoed: a `$(...)` around
# this function would put it in a subshell, where its `exit 1` would end
# only that subshell and the caller would sail on with an empty value —
# the very failure being designed out.
CAPTURED=""
run_checked() {  # run_checked <ok-codes> <what> <command> [args...]
  local ok_codes="$1" what="$2"
  shift 2
  local rc=0
  CAPTURED="$("$@")" || rc=$?
  case ",$ok_codes," in
    *",$rc,"*) return 0 ;;
  esac
  echo "Error: $what failed (exit $rc)." >&2
  echo "Refusing to assemble: this run replaces a published file and deletes" >&2
  echo "the fragments it consumed, so it must not continue on the strength of" >&2
  echo "a result it did not get." >&2
  exit 1
}

# The decimal value of a file's final byte, or empty for an empty file.
# Via `od` because a raw byte cannot survive a shell variable: NUL is
# dropped outright and a trailing newline is stripped, so the two states
# that decide whether a separator is needed are exactly the two a naive
# capture cannot tell apart.
last_byte_code() { tail -c1 "$1" | od -An -tu1 | tr -d '[:space:]'; }

DATE=""
ALLOW_MIXED=0
FORCE_APPEND=0
for a in "$@"; do
  case "$a" in
    --allow-mixed-dates) ALLOW_MIXED=1 ;;
    --force-append) FORCE_APPEND=1 ;;
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

# ── The output path must be a plain file, checked FIRST ──────────────────────
# Before the marker scan, before the lock, before anything reads or
# deletes. These guards used to sit next to the `mv`, which is far too
# late: marker recovery runs first and DELETES the fragments it
# recognises, so a symlinked $OUT could consume a fragment and exit
# "Nothing left to assemble" without ever reaching the guard (Codex #1863
# r5). A check that protects a destructive step has to precede it.
#
# `mv SOURCE DIRECTORY` is a documented form: with a directory at $OUT
# the temp file is moved INSIDE it, the rename "succeeds", every fragment
# is deleted, and the run reports a dated file that does not exist
# (#1863 r1). `mv -T` would cover that one but is GNU only.
if [ -e "$OUT" ] && [ ! -f "$OUT" ]; then
  echo "Error: $OUT exists and is not a regular file." >&2
  echo "Refusing to assemble: the fragments would be consumed and the" >&2
  echo "assembled notes would not be at that path." >&2
  exit 1
fi
# A SYMLINK needs its own test because `-f` FOLLOWS it, so a link to a
# regular file passes the check above (#1863 r4). `mv` then replaces the
# LINK rather than writing through it: the intended target is left
# untouched, the path silently stops being a symlink, and every fragment
# is consumed on a successful-looking run. The old append-by-redirect
# wrote through the link, so this is a regression the atomic rename
# introduced rather than an inherited quirk.
if [ -L "$OUT" ]; then
  echo "Error: $OUT is a symbolic link." >&2
  echo "Refusing to assemble: the rename would replace the link itself and" >&2
  echo "leave its target unchanged, while consuming every fragment." >&2
  echo "Assemble into the real path, or replace the link with a regular file." >&2
  exit 1
fi

# ── One assembly at a time ───────────────────────────────────────────────────
# Everything from here to the deletes is one transaction: read the
# pending pool, read $OUT, build, rename, delete. Taken BEFORE the pool
# is listed — a lock acquired after the snapshot guards nothing, since
# the snapshot is the thing two runs disagree about. Two overlapping runs for the same
# date each build from their own snapshot, and the slower rename wins —
# so a fragment the faster run had already folded in and deleted is
# absent from BOTH the output and `unreleased/`. Lost outright, with two
# successful-looking runs (Codex #1863 r4).
#
# `mkdir` as the lock: creating a directory is atomic and fails if it
# exists, on every filesystem worth caring about, with no dependency on
# `flock` (absent on macOS).
#
# ONE lock for the whole pending pool, not one per dated file. The first
# version was per-date, reasoning that two days touch two different
# outputs and so cannot collide. That was wrong: the two runs share the
# `unreleased/` POOL, not just their outputs (Codex #1863 r5).
# `--allow-mixed-dates` selects every pending fragment whatever date is
# asked for, and an untracked fragment is accepted for ANY date — so two
# runs on different dates can select the SAME fragment, both build, both
# rename, and one deletes it while the other has already written it into
# a second dated file. The note ends up duplicated across two days.
# What is contended is the pool, so that is what the lock has to name.
#
# A stale lock after a hard kill is reported with the command to clear
# it, rather than being broken automatically on a timer: this guards a
# transaction that deletes files, so "the other run is probably dead" is
# not a judgement to make on the operator's behalf.
LOCK="$UNREL/.assemble.lock"
# Armed BEFORE the `mkdir`, not after (Codex #1863 r14). A SIGINT landing
# between acquiring the lock and installing the trap would leave it
# behind — and the README and header promise that Ctrl-C releases it.
# `LOCK_HELD` is what keeps a losing contender from removing the lock
# that is legitimately someone else's: the trap only ever clears a lock
# this process created.
LOCK_HELD=0
WORK=""
WORKDIR=""
SNAP=""
PROBE=""
# ONE cleanup for every exit path. Separate traps drifted apart once
# already: the EXIT trap was later replaced with one that also removed
# the temp file, which left the signal traps still cleaning only the
# lock. A single function cannot fall out of step with itself.
# IDEMPOTENT, because it runs TWICE on a signal (Codex #1863 r22). The
# INT/TERM traps call it and then `exit`, which fires the EXIT trap,
# which calls it again. Leaving LOCK_HELD set through the first call
# meant the second `rmdir` ran too — and if another assembly had
# acquired the lock in between, that second call removed SOMEBODY ELSE'S
# lock, letting a third run overlap them. The lock exists to stop two
# runs drawing from the same pool, so releasing one you no longer hold
# reintroduces exactly what it prevents.
#
# Each resource is cleared BEFORE it is released, not after: a failure
# midway must not leave the flag saying there is still something to free.
_cleanup() {
  local _w="$WORK" _wd="$WORKDIR" _s="$SNAP" _p="$PROBE"
  WORK=""; WORKDIR=""; SNAP=""; PROBE=""
  if [ -n "$_p" ]; then rm -f "$_p" 2>/dev/null || :; fi
  # Every removal is NON-FATAL, and the lock release is unconditional
  # (Codex #1863 r23). `set -e` exits on the last command of an `&&`
  # list, so a failing `rm` — $DIR turned unwritable while an error was
  # unwinding, say — aborted this function BEFORE the lock came off. An
  # ordinary pre-publication failure then left behind the stale lock
  # this script documents as a hard-kill-only outcome, blocking every
  # later run for a reason the message does not describe.
  #
  # Cleanup is the one place that must finish whatever it finds broken:
  # it runs while something has already gone wrong.
  if [ -n "$_w" ]; then rm -f "$_w" || :; fi
  if [ -n "$_wd" ]; then rm -rf "$_wd" || :; fi
  if [ -n "$_s" ]; then rm -rf "$_s" || :; fi
  if (( LOCK_HELD )); then
    LOCK_HELD=0
    # A failure here is SAID, not swallowed (Codex #1863 r24). Suppressed,
    # an otherwise successful run exited 0 while leaving the lock behind,
    # and the next invocation was blocked by a stale lock that no message
    # had ever mentioned — the operator left to discover it from an error
    # describing a hard kill that never happened.
    if ! rmdir "$LOCK" 2>/dev/null; then
      echo "" >&2
      echo "Warning: could not release the assembly lock at $LOCK." >&2
      echo "The next run will refuse to start until it is gone. Remove it" >&2
      echo "with:  rmdir $LOCK" >&2
      echo "(or 'rm -rf' it if something has left files inside.)" >&2
    fi
  fi
  return 0
}
# The quarantine probe runs AFTER the traps are armed (Codex #1863 r29).
# Creating a randomly-named entry before any handler exists meant a signal
# between the `mktemp` and its `rm` left `.probe.XXXXXX` behind for good:
# no later run reuses that name, and the recovery scan's glob skipped
# dotfiles, so `git add -A` could stage it after an ordinary Ctrl-C.
trap '_cleanup' EXIT
trap '_cleanup; exit 130' INT
trap '_cleanup; exit 143' TERM
_ensure_qdir
# INT/TERM are held off across the two steps that acquire the lock
# (Codex #1863 r25). A signal arriving after `mkdir` succeeds but before
# the flag is set ran cleanup with LOCK_HELD still 0, so an ordinary
# Ctrl-C left the lock behind — the one outcome this script documents as
# hard-kill-only. Bash checks traps BETWEEN commands, so no ordering of
# the two closes it; the signals have to not arrive.
#
# Ignored rather than deferred, which is the honest cost: a Ctrl-C landing
# in that instant is discarded and has to be pressed again. Weighed
# against a stale lock that blocks every later run and tells the operator
# it was a hard kill, discarding one signal in a two-instruction window is
# the better trade.
trap '' INT TERM
if ! mkdir "$LOCK" 2>/dev/null; then
  trap '_cleanup; exit 130' INT
  trap '_cleanup; exit 143' TERM
  echo "Error: another assembly appears to be running." >&2
  echo "" >&2
  echo "  lock: $LOCK" >&2
  echo "" >&2
  echo "Two overlapping runs share the pending pool, so they can lose a" >&2
  echo "fragment entirely or duplicate one across two dated files — even when" >&2
  echo "they are assembling different days." >&2
  echo "If no other run is active, the lock is stale from an interrupted run:" >&2
  echo "  rmdir '$LOCK'" >&2
  exit 1
fi
LOCK_HELD=1
trap '_cleanup; exit 130' INT
trap '_cleanup; exit 143' TERM

# Collect pending fragments — every *.md except the README + template.
shopt -s nullglob
frags=()
for f in "$UNREL"/*.md; do
  case "$(basename "$f")" in
    README.md | _TEMPLATE.md) continue ;;
  esac
  frags+=("$f")
done

# Set-aside files are reported BEFORE any "nothing to assemble" verdict
# (Codex #1863 r15). A run interrupted between the rename and the removal
# leaves a fragment existing only inside `.assembled/` — and the pool
# glob does not match dotfiles, so the next run would say "No pending
# fragments" while one sits right there. Its text is in the dated file
# already (the rename happens after the write), so nothing is lost; what
# would be lost is the operator ever hearing about it.
shopt -s nullglob
_setaside=()
shopt -s dotglob
_stale_probe=()
for q in "$QDIR"/*; do
  case "$(basename "$q")" in
    # The write probe is an empty artefact that was never assembled, so
    # it must not be described as a fragment "folded in or changed" and
    # offered for comparison — advice that makes no sense for it and
    # invites restoring an empty file into the pool (Codex #1863 r32).
    .probe.*) _stale_probe+=("$(basename "$q")"); continue ;;
  esac
  _setaside+=("$(basename "$q")")
done
shopt -u dotglob
if (( ${#_stale_probe[@]} > 0 )); then
  echo "Left in $QDIR by an interrupted run:" >&2
  printf '  %s\n' "${_stale_probe[@]}" >&2
  echo "" >&2
  echo "These are empty writability-test files, not fragments. Nothing was" >&2
  echo "assembled from them and nothing depends on them; delete them." >&2
  echo "" >&2
fi
if (( ${#_setaside[@]} > 0 )); then
  echo "Set aside by an earlier run, still in $QDIR:" >&2
  printf '  %s\n' "${_setaside[@]}" >&2
  echo "" >&2
  echo "Each is either a fragment this script had finished folding into a" >&2
  echo "dated file when it was interrupted, or one whose bytes CHANGED while" >&2
  echo "it was being read." >&2
  echo "" >&2
  echo "Those are not the same, and the difference matters (Codex #1863 r26):" >&2
  echo "an interrupted one is already in the dated file, but a CHANGED one" >&2
  echo "holds the newer text while the dated file holds only what was read" >&2
  echo "first — so it may be the sole copy of an edit. Compare each against" >&2
  echo "the dated file before deleting it, or move one back to assemble it." >&2
  echo "" >&2
fi

# Leftover assembly temp files, reported for the same reason and at the
# same point (Codex #1863 r17). The EXIT trap removes `$WORK` on every
# ordinary exit including Ctrl-C, but a SIGKILL or a dead machine cannot
# run a trap — so a `.assemble-<date>.XXXXXX` snapshot survives in
# $DIR, where nothing else ever looks. It is a DOTFILE but not an
# ignored one, so the `git add -A docs/ReleaseNotes/` this script prints
# at the end would stage it for commit, and a half-written copy of a
# release-notes file is not a thing to discover in a diff.
#
# Reported, never deleted — the same rule the stale lock follows. This
# script's whole subject is not destroying things on a guess about
# whether another run is still alive, and a temp file belonging to a
# LIVE concurrent run is indistinguishable from an abandoned one by
# inspection. (The lock makes that overlap unlikely, not impossible: a
# run killed hard leaves the lock behind too, and clearing the lock by
# hand is exactly the documented recovery.)
shopt -s nullglob
_stale_tmp=()
for t in "$DIR"/.assemble-*; do
  _stale_tmp+=("$(basename "$t")")
done
if (( ${#_stale_tmp[@]} > 0 )); then
  echo "Left behind by an interrupted run, still in $DIR:" >&2
  printf '  %s\n' "${_stale_tmp[@]}" >&2
  echo "" >&2
  echo "Each is scratch work from an assembly that was killed outright: a" >&2
  echo "dated file built but never renamed into place, or a directory of" >&2
  echo "working copies of the fragments. Nothing here depends on them and no" >&2
  echo "dated file is missing anything because of them. Delete them once you" >&2
  echo "have looked -- otherwise 'git add -A docs/ReleaseNotes/' stages one." >&2
  echo "" >&2
fi

# Paths deliberately held back for another day, filled in by the day
# selection below. Only these are excluded from the "appeared while
# working" report: comparing against EVERY startup path also excluded a
# fragment RECREATED at a path that had been cleared, which is genuinely
# new text pending under a reused name (Codex #1863 r35).
HELD_PATHS=()

if [ "${#frags[@]}" -eq 0 ]; then
  echo "No pending fragments in $UNREL — nothing to assemble."
  exit 0
fi


# ── Names, checked before the ordering step ──────────────────────────────────
# ONLY the newline guard runs this early, and only because the sort below
# is newline-delimited: a name containing one becomes two entries there,
# and the run then dies on truncated paths that do not exist (Codex #1863
# r16). Everything else about a fragment — its shape, its contents, its
# working copy — is checked after the day is chosen, so another day's
# fragment cannot abort this day's run (Codex #1863 r21).
#
# This pass is deliberately incapable of rejecting a fragment for
# anything but a name the ORDERING cannot survive.
for f in "${frags[@]}"; do
  run_checked 0 "naming $f" basename "$f"
  _nm="$CAPTURED"
  # A NEWLINE in a basename breaks the ordering step below, which is
  # newline-delimited: one path becomes two entries, the hashing pass
  # then fails on truncated paths that do not exist, and the run aborts
  # with a checksum error naming a file nobody wrote — leaving the pool
  # unassemblable until somebody works out that the name is the problem
  # (Codex #1863 r16). Refused here, before the sort, with a message that
  # says which file and why.
  if [[ "$_nm" == *$'\n'* ]]; then
    echo "Error: a fragment filename contains a newline." >&2
    echo "" >&2
    printf '  %q\n' "$f" >&2
    echo "" >&2
    echo "Refusing to assemble: fragments are ordered by a newline-delimited" >&2
    echo "sort, so such a name would be split into two and the run would fail" >&2
    echo "later with a confusing error about a file that does not exist." >&2
    echo "Rename the fragment." >&2
    exit 1
  fi
done

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
  # This probe fails for TWO very different situations and they must not share
  # an outcome. A genuine export or tarball has no `.git` anywhere and simply
  # cannot be dated — assembling everything is the honest response. A checkout
  # with DAMAGED `.git` metadata fails the same probe, and treating that as an
  # export would disable dating and consume every pending fragment on a broken
  # repository, which is the opposite of the promise made everywhere else here.
  #
  # So look for the metadata rather than trusting the probe: walk up from the
  # script's directory for a `.git` entry. Present but unusable = damaged.
  _damaged=0
  _probe_dir="$DIR"
  while :; do
    # `-L` as well as `-e`: `-e` FOLLOWS symlinks, so a `.git` that is a
    # DANGLING link is invisible to it. Git cannot read such a checkout either,
    # but the entry plainly exists — treating it as a git-less export would
    # assemble every pending fragment under the requested date and delete them.
    # Test the directory entry itself, not what it resolves to.
    if [ -e "$_probe_dir/.git" ] || [ -L "$_probe_dir/.git" ]; then
      _damaged=1; break
    fi
    [ "$_probe_dir" = "/" ] && break
    _probe_dir="$(dirname "$_probe_dir")"
  done
  if (( _damaged )); then
    echo "Error: a .git entry exists but git cannot read this work tree." >&2
    echo "Fragment dates are unavailable, and assembling would consume every" >&2
    echo "pending fragment under a date nothing verified. Repair the checkout," >&2
    echo "or pass --allow-mixed-dates to assemble without dating." >&2
    exit 1
  fi
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
  # The probe's STATUS is checked, not just its output. `$(...)` of a failed
  # `rev-parse` is the empty string, which is not "true", so a probe that FAILS
  # inside a genuinely shallow checkout reads as "not shallow" — the boundary set
  # stays empty, the per-fragment boundary check never runs, and a fragment whose
  # add-commit IS the boundary is accepted and deleted under the boundary's
  # fabricated date. Same fault as the six in `e53a0f952`: a failure that is
  # indistinguishable from a benign answer.
  _shallow_status=0
  _is_shallow="$(git -C "$DIR" rev-parse --is-shallow-repository 2>/dev/null)" \
    || _shallow_status=$?
  if (( _shallow_status != 0 )); then
    echo "Error: could not determine whether this repository is shallow" >&2
    echo "(git rev-parse --is-shallow-repository exited $_shallow_status)." >&2
    echo "" >&2
    echo "A shallow checkout dates a truncated fragment to the boundary commit" >&2
    echo "rather than to itself, so without this answer a fragment could be" >&2
    echo "filed under a fabricated date and then deleted. Refusing instead." >&2
    exit 1
  fi
  if [ "$_is_shallow" = "true" ]; then
    # `--git-common-dir` answers RELATIVE TO THE DIRECTORY GIT RAN IN, which is
    # `$DIR`, not the repo root — resolving it against the root instead walks
    # out of the repository and the file is simply never found, leaving the
    # boundary set empty and this whole check silently inert. Resolve it where
    # git actually meant it, and make it absolute and physical while here.
    #
    # If the repo says it is shallow, the boundary list is REQUIRED — proceeding
    # without it would run the fabricated-date case completely unguarded, which
    # is the one thing this branch exists to prevent. So every way of failing to
    # get it stops the run rather than leaving an empty set behind. `cd ""`
    # silently succeeds and stays put, so an empty answer here would otherwise
    # resolve to `$DIR`, find no `shallow` file, and look exactly like a healthy
    # non-shallow repository.
    cdir_rel="$(git -C "$DIR" rev-parse --git-common-dir 2>/dev/null || true)"
    common_dir=""
    if [ -n "$cdir_rel" ]; then
      common_dir="$(cd "$DIR" && cd "$cdir_rel" 2>/dev/null && pwd -P)" || common_dir=""
    fi
    if [ -z "$common_dir" ] || [ ! -r "$common_dir/shallow" ]; then
      echo "Error: the repository is shallow, but its boundary list could not be" >&2
      echo "read, so there is no way to tell a fragment's real date from the" >&2
      echo "boundary's. Refusing rather than dating on an unchecked history." >&2
      echo "" >&2
      echo "Run 'git fetch --unshallow' (or clone at full depth) and retry, or" >&2
      echo "pass --allow-mixed-dates to assemble without dating." >&2
      exit 1
    fi
    while IFS= read -r boundary_sha; do
      [ -n "$boundary_sha" ] && SHALLOW_BOUNDARY["$boundary_sha"]=1
    done < "$common_dir/shallow"
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
  # `git status` READ FIRST, into a file, with its exit status checked. Feeding
  # the loop from a process substitution puts the command on the far side of a
  # pipe where `set -e` cannot see it: an unreadable or corrupt index prints
  # git's fatal error, yields no rows, and the loop simply runs zero times —
  # leaving an empty rename map that reads exactly like "no renames staged".
  # A file also keeps the NUL-delimited output intact, which a variable cannot.
  _status_out="$(mktemp)"
  if ! git -C "$DIR" status --porcelain=v1 -z -M -- "$UNREL" > "$_status_out"; then
    rm -f "$_status_out"
    echo "" >&2
    echo "Error: could not read the git index, so a staged rename cannot be" >&2
    echo "distinguished from a newly written fragment. Assembling now could" >&2
    echo "file a renamed fragment under the wrong day and then delete it." >&2
    echo "" >&2
    echo "Repair the checkout, or pass --allow-mixed-dates to assemble without" >&2
    echo "dating." >&2
    exit 1
  fi

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
  done < "$_status_out"
  rm -f "$_status_out"

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
    else
      # `cat-file -e` answers only "does this object exist", so it returns the
      # SAME failure for a path absent from HEAD and for an object database it
      # cannot read — and the second would fall through to "new fragment",
      # consuming a committed one under any requested date. `ls-tree` separates
      # them: absent is exit 0 with empty output, an unreadable repository is a
      # non-zero exit.
      _lst_status=0
      # `-C "$git_root"`, not `-C "$DIR"`: a PATHSPEC is interpreted relative to
      # the directory git runs in, unlike the `HEAD:<path>` revision syntax this
      # replaced, which was always repo-root-relative. Running it from `$DIR`
      # makes every committed fragment look absent — the same wrong-base class
      # as the symlink and --git-common-dir fixes, hit a third time.
      _lst="$(git -C "$git_root" ls-tree --name-only HEAD -- "$rel")" || _lst_status=$?
      if (( _lst_status != 0 )); then
        echo "" >&2
        echo "Error: cannot read HEAD to check $(basename "$f") (git exited $_lst_status)." >&2
        echo "Whether this fragment is already committed is unknown, so dating" >&2
        echo "it would be a guess. Repair the checkout, or pass" >&2
        echo "--allow-mixed-dates to assemble without dating." >&2
        exit 1
      fi
      [ -n "$_lst" ] && probe="$f"
    fi

    status=0
    added=""
    added_sha=""
    if [ -n "$probe" ]; then
      # `--no-show-signature` because `log.showSignature=true` in the operator's
      # config prepends GPG verification lines to STDOUT even with a custom
      # --format, so `added` would carry several signature lines plus the date
      # and never match. This repo signs its squash merges, so the config is a
      # plausible one to have set.
      raw="$(TZ=UTC git -C "$DIR" log --no-show-signature --follow --diff-filter=A \
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
      HELD_PATHS+=("$f")
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

# ── Working copies, taken AFTER the day is decided ───────────────────────────
# Snapshotting and content-validating every PENDING fragment, rather than
# every SELECTED one, made another day's fragment able to abort this day's
# run (Codex #1863 r21) — which contradicts the promise a few lines above,
# that a run "takes the fragments belonging to ITS day ... and leaves those
# in place for their own run". A mixed backlog became unassemblable again by
# a different route: the exact failure SELECT-don't-refuse exists to prevent.
#
# Nothing here needs to run earlier. Day selection reads paths and git, not
# names, hashes or copies.

# One CHECKED basename per fragment, resolved once and reused (Codex
# #1863 r13). Inline `$(basename "$f")` in the test below could fail
# transiently, and its empty output would slip past the rejection while a
# later successful call wrote the forbidden name into the marker — the
# check and the use disagreeing about what the name even is. Resolving it
# once removes that gap by construction, the same way FRAG_HASH does for
# the digest.
# Each fragment is copied ONCE, and every later read is of the copy
# (Codex #1863 r19). The run otherwise reads a fragment four times — to
# reject an embedded marker record, to hash it, to assemble it, to check
# the last byte — and a fragment edited between any two of those reads
# makes them disagree about what it said. The gate that refuses a
# fragment carrying its own marker record was the one that mattered:
# pass it, then gain such a line before the hash is taken, and the
# injected record is hashed, assembled and trusted as though this script
# had written it — which can have a DIFFERENT fragment deleted unread.
#
# Validating harder cannot fix that, because the flaw is not in the
# validation; it is that the bytes validated and the bytes used were
# read at two different moments. Copying first removes the gap by
# construction, and no ordering of checks can.
#
# The ORIGINAL is still what gets re-hashed before deletion — that
# comparison is the point, and it is what keeps a fragment edited during
# the run from being thrown away.
SNAP="$(mktemp -d "$DIR/.assemble-snap-$DATE.XXXXXX")"
declare -A FRAG_SNAP=()
_n=0
declare -A FRAG_NAME=()
for f in "${frags[@]}"; do
  run_checked 0 "naming $f" basename "$f"
  FRAG_NAME["$f"]="$CAPTURED"
  # Numbered, not named: a fragment basename can contain anything the
  # filesystem allows, and the copy's path is this script's own business.
  _n=$(( _n + 1 ))
  # Through run_checked like every other command whose failure matters:
  # without the copy, the checks below and the text actually folded in
  # could describe different versions of the fragment, which is the whole
  # point of taking one.
  #
  # Hashed either side of the copy, and the copy compared against both
  # (Codex #1863 r20). `cp` is not atomic: rewritten while it reads, the
  # copy can hold an old prefix and a new suffix — a version that never
  # existed. Everything downstream then trusts that hybrid consistently,
  # so nothing notices, and the re-hash at the end quarantines the
  # coherent new source AFTER the invented one has been published.
  #
  # Three matching reads is evidence of a quiet moment, not proof of one:
  # a writer could still have finished between two of them. It narrows a
  # silent corruption into a loud refusal, which is the trade worth
  # making, and it is not a guarantee — nothing available to a shell
  # script is.
  # A fragment must be a REGULAR FILE, checked before anything is
  # published (Codex #1863 r28). A relative symlink copies fine — the
  # copy follows it — but moving the LINK into the quarantine directory
  # changes the base its target resolves against, so the re-hash fails
  # after the dated file is already written, leaving the link stranded
  # and the run half done. Refused here, where refusing is free.
  if [ -L "$f" ] || [ ! -f "$f" ]; then
    echo "Error: ${FRAG_NAME[$f]} is not a regular file." >&2
    echo "" >&2
    echo "Refusing to assemble: setting a fragment aside moves it into a" >&2
    echo "subdirectory, which changes what a relative link points at — and" >&2
    echo "that failure would happen after the dated file was written." >&2
    echo "Replace it with the file itself." >&2
    exit 1
  fi
  run_checked 0 "reading ${FRAG_NAME[$f]}" frag_hash "$f"
  _before="$CAPTURED"
  run_checked 0 "taking a working copy of ${FRAG_NAME[$f]}" \
    cp "$f" "$SNAP/$_n"
  run_checked 0 "re-reading ${FRAG_NAME[$f]}" frag_hash "$f"
  _after="$CAPTURED"
  run_checked 0 "checking the working copy of ${FRAG_NAME[$f]}" \
    frag_hash "$SNAP/$_n"
  if [ "$_before" != "$_after" ] || [ "$CAPTURED" != "$_before" ]; then
    echo "Error: ${FRAG_NAME[$f]} changed while it was being read." >&2
    echo "" >&2
    echo "Refusing to assemble: the copy taken may hold part of one version" >&2
    echo "and part of another — text that never existed as a fragment — and" >&2
    echo "everything downstream would treat it as authoritative." >&2
    echo "" >&2
    echo "Nothing has been consumed. Re-run once whatever is writing it has" >&2
    echo "finished." >&2
    exit 1
  fi
  FRAG_SNAP["$f"]="$SNAP/$_n"
  # A basename cannot be allowed to close the marker's HTML comment
  # (#1863 r12). `note-->visible.md` produces
  # `<!-- assembled-fragment: note-->visible.md sha256=… -->`, which ends
  # at the name: the hash — and anything else the name carries — then
  # renders as visible text in the published notes, breaking the one
  # promise the marker makes. Refused rather than escaped, because these
  # names are ours and a legible one never contains `-->`.
  # `--!>` as well as `-->` (Codex #1863 r23). HTML treats it as an
  # ABRUPT closing of a comment, so `note--!>visible.md` ends the marker
  # inside the name and renders the rest — the remaining filename and the
  # hash — as visible text in the published notes. Same broken promise as
  # `-->`, through a sequence that is easy not to know about.
  case "${FRAG_NAME[$f]}" in
    *'-->'* | *'<!--'* | *'--!>'*)
      echo "Error: ${FRAG_NAME[$f]} contains an HTML comment delimiter." >&2
      echo "Refusing to assemble: the provenance marker is an HTML comment," >&2
      echo "so such a name would end it early and print the rest of the" >&2
      echo "marker as visible text in the published notes." >&2
      echo "Rename the fragment." >&2
      exit 1
      ;;
  esac
  # A fragment must not be able to WRITE THE INDEX (Codex #1863 r13).
  # Anchoring the parser stopped a marker quoted mid-line from counting,
  # but a fragment can put a complete, valid marker at the start of one —
  # and once assembled it is indistinguishable from a record this script
  # wrote. Naming a fragment from a LATER batch would make the next run
  # delete that one unread, having never written its text anywhere.
  # Content is untrusted input to the index, so it is refused at the door.
  # A fragment DOCUMENTING this mechanism can still quote a marker
  # indented or in a blockquote, which is what the anchor is for.
  run_checked 0,1 "checking ${FRAG_NAME[$f]} for embedded marker records" \
    env LC_ALL=C grep -a -E "^$MARKER_PREFIX.+ sha256=[0-9a-f]{64} -->${CR}?$" "${FRAG_SNAP[$f]}"
  # A prefix-shaped line carrying a NUL is refused too (Codex #1863 r28).
  # The full-record pattern above does not match it, so it was published
  # verbatim — and every LATER run's broader prefix scan then found it,
  # hit the NUL guard, and refused. Assembly became permanently stuck on
  # a file this script had itself written. Rejecting the input costs one
  # error message; creating a file the script will not read afterwards
  # costs an operator a manual repair.
  _pfx="$SNAP/pfx.$_n"
  _pf_rc=0
  LC_ALL=C grep -a "^$MARKER_PREFIX" "${FRAG_SNAP[$f]}" > "$_pfx" 2>/dev/null || _pf_rc=$?
  if (( _pf_rc > 1 )); then
    echo "Error: scanning ${FRAG_NAME[$f]} for marker-shaped lines failed." >&2
    exit 1
  fi
  if ! LC_ALL=C tr -d '\000' < "$_pfx" | cmp -s - "$_pfx"; then
    echo "Error: ${FRAG_NAME[$f]} has a marker-shaped line containing a null" >&2
    echo "byte." >&2
    echo "" >&2
    echo "Refusing to assemble: it would be written into the dated file, and" >&2
    echo "every later run would then refuse to read that file — leaving" >&2
    echo "assembly stuck on something this script had produced itself." >&2
    exit 1
  fi
  if [ -n "$CAPTURED" ]; then
    echo "Error: ${FRAG_NAME[$f]} contains a line that is itself an assembly" >&2
    echo "marker:" >&2
    echo "" >&2
    printf '  %s\n' "$CAPTURED" >&2
    echo "" >&2
    echo "Refusing to assemble: those records are what a later run trusts to" >&2
    echo "decide a fragment is already folded in, so one supplied by a" >&2
    echo "fragment could make a DIFFERENT fragment be deleted unread." >&2
    echo "Indent it or quote it in a blockquote if you are documenting the" >&2
    echo "format." >&2
    exit 1
  fi
done

# ── Already-assembled fragments ──────────────────────────────────────────────
# A fragment that is BOTH pending and already marked in $OUT is the
# signature of a run interrupted between the rename and the deletes
# (#1788, window 1). Its content is in place; what it needs is removing,
# not appending. Re-appending is the silent failure this guards:
# duplicated prose in a published document, with no error and nothing
# lost to hint at it.
#
# Identity is the fragment's CONTENT HASH, not its name (Codex #1863 r1).
# The first version keyed on basename alone, on the stated reasoning that
# content identity "could not survive the link rewriting". That reasoning
# was wrong, and wrong in a way that authorised a destructive action: the
# rewrite happens to what is APPENDED, so matching the rewritten text in
# $OUT would indeed be approximate — but the marker records the identity
# of the SOURCE, hashed before any rewriting, and nothing touches that.
#
# Basename alone was unsafe in both directions:
#   - Same name, different content — a reused filename, or a fragment
#     EDITED after an interrupted run — was deleted unread, taking the
#     new text with it. Silent data loss, worse than the duplication
#     this whole change exists to prevent.
#   - Different name, same content — a fragment renamed between runs —
#     was not recognised, and its content was appended a second time,
#     which is precisely the bug, back by another door.
# Hash identity gets both right: different content is never "already
# assembled", and a rename is still recognised.
#
# Searched across every dated file, not only today's $OUT. An untracked
# fragment is accepted for ANY date, so a run interrupted before UTC
# midnight and resumed after it targets a DIFFERENT dated file; checking
# only the new one wrote the same payload into two files and deleted the
# source (Codex #1863 r1). The hash is unique to the content, so finding
# it anywhere is proof it was folded in somewhere.
#
# Keyed by hash AND name AND file, not by hash alone (Codex #1863 r4).
# One assembly can legitimately contain two differently named fragments
# with identical bytes, and a hash-keyed map keeps only the last of them
# — so on recovery the OTHER one fails its exact-match test, is reported
# ambiguous despite its own exact marker sitting in $OUT, and the
# offered --force-append path then appends it a second time. A hash is
# not a unique key here; the triple is.
#
# `marker_seen` answers "is this exact fragment recorded in this exact
# file"; `marker_where` accumulates every place a given hash appears, for
# the message when the answer is no.
# The output's identity is captured HERE, immediately before the scan
# that reads its records, and re-checked before each irreversible act
# that trusts them (Codex #1863 r19). One baseline, taken once, so the
# marker evidence, the copy made later, and the file finally replaced are
# all provably the same file.
#
# Scope is $OUT alone, deliberately. Records found in OTHER dated files
# feed the `ambiguous` branch, which refuses or appends — it never
# deletes — so a change there cannot cost anyone a fragment. It is the
# records in the file being assembled that authorise removal.
#
# An empty string means "was absent", which no real identity collides
# with.
OUT_ID=""
if [ -f "$OUT" ]; then
  if ! file_identity "$OUT"; then
    echo "Error: $(basename "$OUT") -- $IDENTITY_FAIL failed." >&2
    echo "Refusing to assemble: every later decision about deleting a" >&2
    echo "fragment rests on knowing this file has not changed underneath," >&2
    echo "and replacing it would have to guess a mode -- guessing wider" >&2
    echo "than it was would expose content that was deliberately" >&2
    echo "restricted." >&2
    exit 1
  fi
  OUT_ID="$IDENTITY"
  # The mode the replacement must wear, taken from the SAME read as the
  # baseline. Resolved separately it was a second `stat` at a second
  # moment, which is one more chance for the two to disagree about the
  # same file — the shape of fault this whole section exists to remove.
  OUT_MODE="$MODE_READ"
fi

# Re-read that identity and refuse if it moved. Called before anything
# irreversible; the message names the act being refused, since "the file
# changed" means something different at each of them.
assert_output_unchanged() {  # assert_output_unchanged <what-was-about-to-happen>
  local now=""
  if [ -e "$OUT" ] && [ ! -f "$OUT" ]; then now="__not-a-regular-file__"
  elif [ -L "$OUT" ]; then now="__symlink__"
  elif [ -f "$OUT" ]; then
    if ! file_identity "$OUT"; then
      echo "Error: $(basename "$OUT") -- $IDENTITY_FAIL failed." >&2
      _refuse_reporting_consumed
    fi
    now="$IDENTITY"
  fi
  [ "$now" = "$OUT_ID" ] && return 0
  echo "Error: $(basename "$OUT") changed while this run was working." >&2
  echo "" >&2
  if [ -z "$OUT_ID" ]; then
    echo "It did not exist when this run started and does now, so something" >&2
    echo "else created it." >&2
  elif [ -z "$now" ]; then
    echo "It existed when this run started and does not now, so something" >&2
    echo "else removed it." >&2
  elif [ "$now" = "__symlink__" ] || [ "$now" = "__not-a-regular-file__" ]; then
    echo "It is no longer a regular file, so it changed shape rather than" >&2
    echo "content — and replacing it would not put the notes where they" >&2
    echo "belong." >&2
  elif [ "${now%% *}" != "${OUT_ID%% *}" ]; then
    echo "Its contents differ from the copy this run is working from, so" >&2
    echo "$1 would discard whatever was written in between." >&2
  else
    echo "Its permissions or ownership changed (${OUT_ID#* } -> ${now#* })." >&2
    echo "Replacing it now would put the older ones back, undoing that" >&2
    echo "silently — and possibly widening a file someone just restricted." >&2
  fi
  _refuse_reporting_consumed
}

# ── Every file the index read, not just the one being written ────────────────
# The rule above says "the evidence it rests on". Guarding only $OUT
# enforced it for one file while the index draws on EVERY dated file: a
# marker appearing in another one after the scan leaves this run still
# believing a fragment is unfiled, so it appends the same section to a
# second day and deletes the source (Codex #1863 r20).
#
# SRC_ID is filled by the scan below, one entry per dated file it read,
# $OUT included. Anything irreversible checks the whole map. That is what
# makes the invariant structural rather than a list of places somebody
# remembered: a new read gets recorded by the same loop, and a new act
# inherits the same call.
declare -A SRC_ID=()
CONSUMED=()
_d_n=0

# ── Refusing, once, wherever it happens ──────────────────────────────────────
# What a refusal can honestly say depends on whether anything has gone
# already, and EVERY exit reachable mid-consumption has to say the same
# thing (Codex #1863 r30, r31). The consumed-aware wording was added to
# one branch and the others still claimed nothing had been touched — so a
# run that had already deleted a fragment could report the opposite,
# concealing both the loss and the fact that its text may now have to come
# back out of git. One reporter, called by all of them.
_refuse_reporting_consumed() {
  echo "" >&2
  if (( ${#CONSUMED[@]} > 0 )); then
    echo "Already removed before this was noticed:" >&2
    printf '  %s\n' "${CONSUMED[@]}" >&2
    echo "" >&2
    echo "Their text was in $(basename "$OUT") when they went. If the change" >&2
    echo "above removed it, recover them from git." >&2
  else
    echo "Nothing has been consumed and no fragment has been touched." >&2
  fi
  echo "Nothing further will be consumed. Re-run once the other change has" >&2
  echo "settled." >&2
  exit 1
}
OUT_COPY=""

assert_sources_unchanged() {  # assert_sources_unchanged <what-was-about-to-happen>
  local p now
  # The set itself, first. A dated file CREATED since the scan was never
  # recorded, so comparing recorded entries alone cannot see it — and a
  # new file is exactly where a competing run would have put a marker.
  shopt -s nullglob
  local seen=0
  for p in "$DIR"/ReleaseNotes-*.md; do
    if [ -z "${SRC_ID[$p]+set}" ]; then
      echo "Error: $(basename "$p") appeared while this run was working." >&2
      echo "" >&2
      echo "It was not there when the records were read, so this run cannot" >&2
      echo "know whether it already holds any of these sections." >&2
      _refuse_reporting_consumed
    fi
    seen=$(( seen + 1 ))
  done
  if (( seen != ${#SRC_ID[@]} )); then
    echo "Error: a dated file this run had read is gone." >&2
    _refuse_reporting_consumed
  fi
  # The output's own shape and metadata are checked FIRST, because that
  # function carries the detailed messages — which file, which way it
  # changed, what replacing it would do. Reaching it through the generic
  # per-file loop instead produced a correct refusal with a vaguer
  # explanation.
  assert_output_unchanged "$1"
  for p in "${!SRC_ID[@]}"; do
    # $OUT is NOT exempt from the content comparison (Codex #1863 r26).
    # It was, on the reasoning that assert_output_unchanged covers it in
    # full — but that compares against OUT_ID, read BEFORE the copy,
    # while the markers were parsed FROM the copy. A file changed after
    # the identity read, still changed through the copy, and restored
    # before the deletion left a marker that existed only in the copy
    # authorising a removal, with the older identity passing. Both
    # baselines have to hold: the bytes actually indexed, and the
    # metadata the replacement will carry.
    now=""
    if [ -f "$p" ] && [ ! -L "$p" ]; then
      if ! file_identity "$p"; then
        echo "Error: $(basename "$p") -- $IDENTITY_FAIL failed." >&2
        _refuse_reporting_consumed
      fi
      # CONTENT only for the other dated files. Their permissions are
      # nobody's business here — this run neither replaces them nor
      # carries their metadata anywhere, so refusing on a chmod to an
      # unrelated file would be a false alarm with a destructive-sounding
      # message. $OUT is different precisely because it IS replaced.
      now="${IDENTITY%% *}"
    fi
    if [ "$now" != "${SRC_ID[$p]}" ]; then
      echo "Error: $(basename "$p") changed while this run was working." >&2
      echo "" >&2
      echo "This run's decisions about what is already filed were read from" >&2
      echo "it, so $1 could duplicate a section or delete one that is no" >&2
      echo "longer recorded anywhere." >&2
      _refuse_reporting_consumed
    fi
  done
}

declare -A marker_seen=()
declare -A marker_where=()
shopt -s nullglob
for dated in "$DIR"/ReleaseNotes-*.md; do
  # Regular files only, checked BEFORE opening (Codex #1863 r3). A FIFO
  # at one of these paths blocks `grep` forever waiting for a writer, and
  # every assembly run then hangs with no output — the `$OUT` check
  # further down is never reached, and would not cover a FIFO named for
  # a different date in any case.
  if [ ! -f "$dated" ]; then
    echo "Error: $dated is not a regular file." >&2
    echo "Refusing to scan it for assembly markers: the recovery index must" >&2
    echo "cover every dated file, and this one cannot be read as one." >&2
    exit 1
  fi
  # A WORKING COPY, and the records are parsed from it — the same
  # treatment the fragments get, and for the same reason (Codex #1863
  # r21). Recording a digest and then grepping the live file is two
  # reads: a marker present only for the duration of the grep, and
  # removed before the check, leaves the digest matching while the index
  # holds evidence that never persisted — and that evidence authorises
  # deleting a fragment whose section is then in no file at all.
  #
  # Copy first, identify the COPY, parse the COPY. The later comparison
  # asks whether the live file still equals the bytes actually parsed,
  # which is the question that was being approximated before.
  _d_n=$(( _d_n + 1 ))
  run_checked 0 "taking a working copy of $(basename "$dated")" \
    cp "$dated" "$SNAP/dated.$_d_n"
  _d_copy="$SNAP/dated.$_d_n"
  if ! file_identity "$_d_copy"; then
    echo "Error: $(basename "$dated") -- $IDENTITY_FAIL failed." >&2
    echo "Refusing to assemble: this run's decisions about what is already" >&2
    echo "filed come from these files, so it has to be able to tell whether" >&2
    echo "one changed underneath it." >&2
    exit 1
  fi
  SRC_ID["$dated"]="${IDENTITY%% *}"
  # The copy of the file being ASSEMBLED is kept: the replacement is
  # built from it rather than from a fresh read of the live file
  # (Codex #1863 r23). Reading $OUT again is another read at another
  # moment — an editor changing it while `cat` runs and restoring it
  # before the final check leaves the identity matching while $WORK
  # holds the transient or torn text, which is then published.
  if [ "$dated" = "$OUT" ]; then OUT_COPY="$_d_copy"; fi
  # The copy must equal the live file, or the baseline describes bytes
  # nobody will ever compare against and every later check passes
  # vacuously. Same bracket the fragments use, same non-guarantee.
  run_checked 0 "re-reading $(basename "$dated")" frag_hash "$dated"
  if [ "$CAPTURED" != "${SRC_ID[$dated]}" ]; then
    echo "Error: $(basename "$dated") changed while it was being read." >&2
    echo "Refusing to assemble: the records this run would rely on may be" >&2
    echo "from a version that no longer exists." >&2
    exit 1
  fi
  # A record carrying a NUL is REFUSED, never parsed (Codex #1863 r21).
  # Bash cannot hold a NUL in a variable and drops it from a command
  # substitution, so a line like
  # `<!-- assembled-fragment: note.md<NUL> sha256=... -->` — which the
  # anchored pattern rejects as malformed — arrives as the valid record
  # `note.md sha256=...` and authorises deleting `note.md`, whose section
  # is nowhere in the file. The bytes that failed the check are not the
  # bytes acted on, which is this whole change's subject in miniature.
  #
  # No marker this script writes can contain one: a NUL cannot appear in
  # a filename and the hash is hex. Its presence means the file is not
  # saying what it appears to say.
  #
  # Only MARKER-SHAPED lines are inspected. A fragment may legitimately
  # carry NUL bytes in its prose — two cases in the suite do — and those
  # reach the dated file, so testing the whole file would refuse ordinary
  # input. Run BEFORE the scan below and with its own status variable, so
  # it cannot disturb the CAPTURED the parse loop reads.
  _mrec="$SNAP/markers.$_d_n"
  _mrc=0
  LC_ALL=C grep -a "^$MARKER_PREFIX" "$_d_copy" > "$_mrec" 2>/dev/null || _mrc=$?
  if (( _mrc > 1 )); then
    echo "Error: listing marker lines in $(basename "$dated") failed (exit $_mrc)." >&2
    echo "Refusing to assemble: an incomplete index is worse than none." >&2
    exit 1
  fi
  if ! LC_ALL=C tr -d '\000' < "$_mrec" | cmp -s - "$_mrec"; then
    echo "Error: $(basename "$dated") holds a marker record containing a" >&2
    echo "null byte." >&2
    echo "" >&2
    echo "Refusing to assemble: this shell cannot carry that byte, so the" >&2
    echo "record would be read as a DIFFERENT and apparently valid one, and" >&2
    echo "a fragment deleted on the strength of it." >&2
    echo "" >&2
    echo "Nothing has been consumed. Repair the file by hand." >&2
    exit 1
  fi
  # `grep` exit 1 is "no markers in this file", which is normal. Anything
  # ABOVE 1 is a read error, and `|| true` used to flatten the two
  # together — leaving a silently INCOMPLETE index, which is worse than
  # no index at all: a fragment whose marker lives in the unreadable file
  # reads as never assembled and is appended a second time (Codex #1863
  # r3). The whole point of this scan is that finding nothing is proof.
  #
  # `|| _scan_rc=$?`, not a bare call then `$?`. Under `set -e` a grep
  # that simply finds nothing (exit 1) is a failing command, so the
  # shell would exit before the next line ever ran — silently, with no
  # message and no assembly. The `||` list is exempt and still lets the
  # code be captured.
  # Exit 1 means "no markers in this file", which is ordinary. Anything
  # above it is a read error, and an INCOMPLETE index is worse than none:
  # a fragment whose marker lives in the unreadable file reads as never
  # assembled and is appended a second time. The whole point of this scan
  # is that finding nothing is proof.
  # `-a`: a fragment carrying a NUL byte makes GNU grep treat the file as
  # binary and print "binary file matches" INSTEAD of the marker line, so
  # the index silently loses that fragment's record and recovery appends
  # it again (Codex #1863 r9). These are Markdown inputs; read them as
  # text.
  # `LC_ALL=C`: `-a` changes BINARY-file handling, not multibyte matching,
  # so under a UTF-8 locale a basename containing an invalid byte makes
  # GNU grep fail to match that fragment's own marker — the record is
  # there and the index cannot see it (Codex #1863 r13). These records are
  # bytes by construction; parse them as bytes.
  run_checked 0,1 "scanning $(basename "$dated") for assembly markers" \
    env LC_ALL=C grep -a -E "^$MARKER_PREFIX.+ sha256=[0-9a-f]{64} -->${CR}?$" "$_d_copy"
  # A record carrying a NUL is REFUSED, never parsed (Codex #1863 r21).
  # Bash cannot hold a NUL in a variable and drops it from a command
  # substitution, so `<!-- assembled-fragment: note.md\0 sha256=… -->` —
  # which the anchored pattern would reject as malformed — arrives here
  # as the valid record `note.md sha256=…` and authorises deleting
  # `note.md`, whose section is nowhere in the file. The bytes that
  # failed the check are not the bytes that get acted on, which is this
  # whole document's subject in miniature.
  #
  # No marker this script writes can contain one: a NUL cannot appear in
  # a filename, and the hash is hex. So its presence means the file is
  # not saying what it appears to say, and stopping is the only answer
  # that neither duplicates nor deletes.
  # Parsed under the SAME byte locale as the scan (Codex #1863 r35). The
  # grep runs with LC_ALL=C, so it finds a record whose basename contains
  # a byte invalid in the runner's UTF-8 locale; this regex ran under the
  # parent locale and failed to match that same line. The fragment then
  # read as never assembled, was appended a second time and consumed —
  # the index seeing a record the parser cannot.
  local_lc_all="${LC_ALL-}"; local_lc_set="${LC_ALL+set}"
  LC_ALL=C
  while IFS= read -r line; do
    # `<!-- assembled-fragment: <basename> sha256=<hex> -->`, and ONLY
    # that shape. A line matching the prefix but not the full form is
    # ignored rather than half-parsed: `${line##* sha256=}` returns the
    # whole line when the pattern is absent, which would enter a
    # nonsense key that no real hash can equal — harmless today, and
    # exactly the sort of thing that stops being harmless later.
    #
    # ANCHORED to the whole line, and read as a whole. An unanchored
    # match accepted a marker-shaped string quoted inside prose — a
    # blockquote in these very notes, say, or a fragment documenting
    # this mechanism — and a quoted example could then authorise
    # deleting a real fragment unread (Codex #1863 r2). The grep below
    # is anchored for the same reason; this is the second gate, not the
    # only one.
    # A trailing CR is stripped before matching (Codex #1863 r24). A dated
    # file with CRLF endings — a checkout with Git's CRLF conversion on —
    # leaves \r after the closing -->, so this anchored pattern matched
    # NONE of the markers this script had written. Every fragment then
    # read as never assembled and was appended a second time, and one
    # with no Markdown heading slipped past the duplicate heuristic too.
    line="${line%$'\r'}"
    [[ "$line" =~ ^"$MARKER_PREFIX"(.+)" sha256="([0-9a-f]{64})" -->"$ ]] || continue
    marker_name="${BASH_REMATCH[1]}"
    marker_hash="${BASH_REMATCH[2]}"
    marker_seen["$marker_hash|$marker_name|$dated"]=1
    # Appended, never overwritten — see the note above.
    marker_where["$marker_hash"]="${marker_where[$marker_hash]:+${marker_where[$marker_hash]}; }$marker_name in $(basename "$dated")"
    # `$MARKER_PREFIX` interpolates into the grep pattern unescaped
    # because it contains no ERE metacharacter — it is
    # `<!-- assembled-fragment: `. If that literal ever gains one,
    # escape it there.
  done <<< "$CAPTURED"
  if [ -n "$local_lc_set" ]; then LC_ALL="$local_lc_all"; else unset LC_ALL; fi
done

# ONE rule, and it is narrow on purpose: a fragment is consumed without
# being appended only when its marker is in THE FILE BEING ASSEMBLED,
# under THE SAME NAME. Everything else stops the run.
#
# That is exactly the interrupted-run signature and nothing else. A
# digest identifies bytes, not an occurrence (Codex #1863 r2), and a name
# does not fix that — reusing both a name and its exact text on a later
# day is an occurrence this run has never seen, and deleting it produces
# no note for its day at all (Codex #1863 r3). Widening the rule to cover
# that by treating same-name-same-bytes as ambiguous would be worse
# still: it is the ordinary recovery case, so recovery would stop being
# automatic at all, which is the feature.
#
# What separates them is WHERE the marker is. Resuming an interrupted run
# means re-running for the same day, so the marker is in $OUT. A match in
# a DIFFERENT dated file is either a later reuse, or a fragment whose day
# has moved under it (an untracked fragment resumed after UTC midnight) —
# both real, both wanting different handling, neither knowable from here.
#
# So the stopping cases are: a match under a different name (rename, or
# coincidental text), and a match in a different dated file (reuse, or a
# crossed midnight). Each is reported with what it matched and where.
# Stopping cannot duplicate and cannot delete; guessing can do both.
# Hash every fragment ONCE, here, and validate each in the parent shell
# (Codex #1863 r6). Two reasons it cannot be done at the call sites:
#
#   - a bare `h="$(frag_hash "$f")"` lets `set -e` abort on a failing
#     checksum with the tool's own exit status and NO message, and does
#     not notice a tool that exits 0 while printing something that is not
#     a hash;
#   - validating inside `frag_hash` cannot work either, because `exit`
#     in a command substitution leaves only the SUBSHELL — the parent
#     carries on with an empty hash, which is the failure being fixed.
#
# Computing them up front also stops the same file being hashed three or
# four times per run.
declare -A FRAG_HASH=()
for f in "${frags[@]}"; do
  #
  # Status and output are checked SEPARATELY (Codex #1863 r7). The first
  # version used `|| true`, which discards the status entirely — so a
  # faulty tool that exits non-zero while printing something that merely
  # LOOKS like a hash (64 zeros, a cached line, a partial read) passed
  # validation, and the run wrote a false marker, replaced the output and
  # deleted the fragment. A working checksum later would not match that
  # marker, so the fragment would be appended again. `|| true` was there
  # to stop `set -e` pre-empting the message; `|| _hrc=$?` does that and
  # keeps the status.
  run_checked 0 "hashing ${FRAG_NAME[$f]}" frag_hash "${FRAG_SNAP[$f]}"
  _h="$CAPTURED"
  # Status AND shape, because they catch different faults: a tool that
  # exits non-zero while printing a plausible 64-hex value, and one that
  # exits 0 while printing junk. Either would put a marker in the file
  # that a working checksum could never match.
  if [[ ! "$_h" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Error: could not hash $(basename "$f") (got '${_h}')." >&2
    echo "Refusing to assemble: the marker written for a fragment is what" >&2
    echo "lets a later run tell it has already been folded in, so an" >&2
    echo "unusable hash would silently cost the recovery this exists for." >&2
    exit 1
  fi
  FRAG_HASH["$f"]="$_h"
done

already=()
pending=()
ambiguous=()
for f in "${frags[@]}"; do
  h="${FRAG_HASH[$f]}"
  if [ -n "${marker_seen[$h|${FRAG_NAME[$f]}|$OUT]+set}" ]; then
    already+=("$f")
  elif [ -n "${marker_where[$h]+set}" ]; then
    ambiguous+=("$f")
  else
    pending+=("$f")
  fi
done

if (( ${#ambiguous[@]} > 0 )) && (( FORCE_APPEND == 0 )); then
  echo "Error: these fragments have the same contents as something already" >&2
  echo "assembled, but not in the one place that would make them the same" >&2
  echo "occurrence — same name, in the file being assembled now. A different" >&2
  echo "name means a rename or a coincidentally identical note; a different" >&2
  echo "dated file means a reused note or a run resumed past UTC midnight." >&2
  echo "Nothing here can tell which:" >&2
  echo "" >&2
  for f in "${ambiguous[@]}"; do
    h="${FRAG_HASH[$f]}"
    # Every place this content already appears, not just one — with two
    # identically-worded notes in play, naming a single site would point
    # the operator at an arbitrary one of them.
    printf '  %s\n      same bytes as: %s\n' \
      "$(basename "$f")" "${marker_where[$h]}" >&2
  done
  echo "" >&2
  echo "  - already folded in, under that other name or into that other" >&2
  echo "    dated file          -> delete the fragment(s) by hand" >&2
  echo "  - a new note that reads alike -> re-run with --force-append" >&2
  exit 1
fi
# With --force-append the operator has said these are new. Appending is
# then the safe reading of that instruction: it keeps the text either
# way, where deleting would not.
if (( ${#ambiguous[@]} > 0 )); then
  pending+=("${ambiguous[@]}")
fi

if (( ${#already[@]} > 0 )); then
  # The records that authorise these deletions were read from $OUT some
  # time ago; the deletions happen now (Codex #1863 r19). If the file
  # changed in between, the evidence may describe text it no longer
  # holds — and when EVERY fragment takes this path the run exits below
  # without ever reaching the check before the rename, so this is the
  # only place that can catch it.
  assert_sources_unchanged "removing the fragments already folded into it"
  echo "Already assembled into $(basename "$OUT") — removing without re-appending:"
  # Every entry here matched on name, bytes AND file — anything else is
  # routed to the ambiguous branch above and never reaches this loop — so
  # there is one line to print, not two.
  for f in "${already[@]}"; do
    printf '  %s -> already in %s\n' "$(basename "$f")" "$(basename "$OUT")"
  done
  echo "  (an earlier run was interrupted after writing the file but before"
  echo "   clearing these; their content is already in place, byte for byte)"
  echo ""
  # The fragment is re-hashed before it goes, exactly as the consumption
  # loop at the end does. Found by auditing this path for the class the
  # review had just flagged twice, rather than by a review round: this
  # loop deleted outright, so a fragment EDITED since the snapshot was
  # thrown away while the dated file held only the older text — which is
  # the fault that path already refuses to commit, sitting unguarded a
  # few lines away.
  _changed=()
  for f in "${already[@]}"; do
    # INSIDE the loop, once per removal (Codex #1863 r20). Checked once
    # before it, the second deletion still ran on evidence gathered
    # before the first — so an edit landing between them removed a
    # fragment whose section was no longer anywhere. Each irreversible
    # step revalidates for itself; a loop is N steps, not one.
    assert_sources_unchanged "removing ${FRAG_NAME[$f]}"
    # QUARANTINE, then hash, then delete — the same order the consumption
    # loop uses, and for the same reason (Codex #1863 r24). Hashing the
    # path and then removing the path leaves a window: bytes written in
    # between are deleted having never been anywhere else. This path had
    # the check but not the ordering, so the protection it looked like it
    # had was the one thing it did not have.
    _q_name="${FRAG_NAME[$f]}"
    _q="$QDIR/$_q_name"
    # `-L` as well as `-e`: `-e` FOLLOWS a symlink, so a DANGLING one at
    # this path reads as absent, `mv` replaces the link, and the later
    # `rm` deletes whatever now sits there (Codex #1863 r25).
    if [ -e "$_q" ] || [ -L "$_q" ]; then
      echo "Error: a set-aside file already exists at $_q_name." >&2
      echo "Nothing further will be consumed; move it aside and re-run." >&2
      _refuse_reporting_consumed
    fi
    if ! mv "$f" "$_q"; then
      echo "Error: could not set aside ${FRAG_NAME[$f]}." >&2
      echo "Nothing further will be consumed." >&2
      _refuse_reporting_consumed
    fi
    _rc=0
    _now="$(frag_hash "$_q")" || _rc=$?
    if (( _rc != 0 )) || [ "$_now" != "${FRAG_HASH[$f]}" ]; then
      _changed+=("${FRAG_NAME[$f]} -> .assembled/$_q_name")
      continue
    fi
    # Same reason as the clearing loop below: the hash is the long step,
    # so the evidence is re-checked adjacent to the delete rather than
    # before it (Codex #1863 r28).
    assert_sources_unchanged "removing ${FRAG_NAME[$f]}"
    # And the QUARANTINE last of all (Codex #1863 r31), because the call
    # above performs several long hashes of its own — a writer holding
    # the fragment inode open from before the move can append during
    # them, and those bytes would then be removed having reached no file.
    # The clearing loop already ordered it this way; this one did not.
    _rrh_rc=0
    _rrh="$(frag_hash "$_q")" || _rrh_rc=$?
    if (( _rrh_rc != 0 )) || [ "$_rrh" != "${FRAG_HASH[$f]}" ]; then
      _changed+=("${FRAG_NAME[$f]} -> .assembled/$_q_name")
      continue
    fi
    # Guarded, like every other failure reachable here (Codex #1863 r41).
    # A bare `rm` failing under `set -e` exits with the tool's own
    # diagnostic and nothing else — no list of what an earlier iteration
    # already removed, no word that the pool is partly cleared. Fourth
    # place this same routing was missing; the reporter exists so the
    # answer is uniform, and a bare command silently opts out of it.
    if ! rm "$_q"; then
      echo "Error: could not remove ${FRAG_NAME[$f]} from the quarantine." >&2
      _refuse_reporting_consumed
    fi
    CONSUMED+=("${FRAG_NAME[$f]}")
  done
  if (( ${#_changed[@]} > 0 )); then
    echo ""
    echo "Kept (changed since this run read them, or unreadable now):" >&2
    printf '  %s\n' "${_changed[@]}" >&2
    echo "The version already in $(basename "$OUT") is the older one, so these" >&2
    echo "are left for you to compare rather than deleted." >&2
    echo ""
  fi
fi

if (( ${#pending[@]} == 0 )); then
  # The pool is re-listed before saying so (Codex #1863 r33). An editor
  # saving a new version at the original path after the recovery loop
  # moved the old inode aside creates a genuinely pending fragment — left
  # untouched, correctly, but the verdict was computed before it existed
  # and announced a clear backlog with one waiting.
  # Compared against what was there at STARTUP (Codex #1863 r34). A
  # fragment belonging to another day is held back deliberately and was
  # present all along — calling it something that "appeared while
  # working" and advising a re-run is wrong twice over, since re-running
  # for this date holds it back again.
  shopt -s nullglob
  _still=()
  for _p in "$UNREL"/*.md; do
    case "$(basename "$_p")" in README.md | _TEMPLATE.md) continue ;; esac
    # Element by element, not a flattened string (Codex #1863 r42).
    # `${HELD_PATHS[*]}` joins with spaces, so a legal space in a
    # filename made an unrelated path look held: a recreated `x.md` was
    # skipped because `x.md held.md` was in the list, and the run said
    # the pool was clear with new text pending.
    _is_held=0
    for _h in ${HELD_PATHS[@]+"${HELD_PATHS[@]}"}; do
      if [ "$_h" = "$_p" ]; then _is_held=1; break; fi
    done
    if (( _is_held )); then continue; fi
    _still+=("$(basename "$_p")")
  done
  if (( ${#_still[@]} > 0 )); then
    echo "Nothing further to assemble for $DATE from what this run read."
    echo ""
    echo "These appeared while it was working, and are still pending:"
    printf '  %s\n' "${_still[@]}"
    echo "Re-run to fold them in."
    exit 0
  fi
  echo "Nothing left to assemble for $DATE."
  exit 0
fi
frags=("${pending[@]}")

# ── Markerless outputs cannot be reasoned about ──────────────────────────────
# A dated file written before markers existed — or one whose markers an
# operator edited away while adding the intro paragraph — carries no
# record of what it consumed. Absence of a marker then means either "new
# fragment" or "already folded, no marker written", and nothing in the
# file distinguishes them (Codex #1863 r1).
#
# Appending regardless is what the old script did, so it is not a
# regression, but it does preserve the exact bug this change removes.
# Refusing whenever markers are missing is far too strict: appending a
# second batch to an existing dated file is normal, and every file
# assembled before this change is markerless.
#
# So: refuse only on positive evidence of a duplicate — the fragment's
# own first heading already present in $OUT — and make it an operator
# decision rather than a silent choice either way. A heading match is a
# HEURISTIC, which is safe as a reason to STOP and unsafe as a reason to
# skip or delete; this only ever stops.
if [ -f "$OUT" ]; then
  # Does $OUT carry ANY marker? That is the discriminator. A file this
  # script wrote has a marker for everything it folded in, so "no marker
  # for this hash" is authoritative and the fragment really is new. A
  # file with NO markers at all says nothing either way.
  #
  # A COMPLETE, well-formed marker — not merely the prefix (Codex #1863
  # r3). This is a separate discriminator from the parser above and was
  # not protected by it: prose quoting the prefix, or a malformed
  # example, set this flag and so declared a markerless legacy file
  # "authoritative", skipping the very stop this branch exists for.
  # `if`, not `grep … && out_has_markers=1`: with `set -e` the latter
  # exits the whole script when grep finds nothing, which is the ordinary
  # case here — a markerless file is exactly what this branch is for.
  out_has_markers=0
  run_checked 0,1 "checking $(basename "$OUT") for assembly markers" \
    env LC_ALL=C grep -a -E "^$MARKER_PREFIX.+ sha256=[0-9a-f]{64} -->${CR}?$" "$OUT_COPY"
  [ -z "$CAPTURED" ] || out_has_markers=1

  suspect=()
  for f in "${frags[@]}"; do
    #
    # Same class as the checksum and `tail` cases, found by auditing for
    # it rather than by review: `|| true` here would hide a READ ERROR
    # (grep exit >1) behind the same empty result a fragment with no
    # heading gives. That fragment would then be dropped from the
    # duplicate check silently, so the legacy stop never fires for it —
    # a guard quietly not covering one input. Exit 1 (no heading) is
    # ordinary and continues; anything above it aborts.
    # Exit 1 (no heading in this fragment) is ordinary and skips it; a
    # read error is not, and would drop the fragment from this check
    # silently — a guard quietly not covering one of its inputs.
    # The heading is compared through a PATTERN FILE, never a variable
    # (Codex #1863 r13). Bash strips NUL from a command substitution, so a
    # heading containing one arrives altered — and the fixed-string search
    # then looks for text the file does not contain, misses the duplicate
    # it exists to catch, and the section is appended a second time. Both
    # halves stay as bytes on disk: extract, then match with `-f`.
    # Inside the run's PRIVATE directory, not the shared temp area
    # (Codex #1863 r37). `mktemp` reserves its own name, but the derived
    # `$_head_file.n` used below reserves nothing — on a multi-user host
    # another user can pre-create that predictable path as a symlink, and
    # the redirection then truncates whatever it points at. $SNAP is
    # created by this run and is not shared.
    _head_file="$(mktemp "$SNAP/head.XXXXXX")"
    _hrc=0
    # The SNAPSHOT, like validation, hashing and assembly (Codex #1863
    # r20). Reading the live fragment here made this the one check that
    # judged a different version from the one being published: edit the
    # heading after the copy, and the duplicate-heading heuristic looks
    # for the new heading, does not find it, and publishes the old
    # section a second time. Four of five reads had been repointed; this
    # was the fifth, and missing it is exactly the drift copying was
    # meant to end.
    env LC_ALL=C grep -a -m1 '^#\{1,6\} ' "${FRAG_SNAP[$f]}" > "$_head_file" 2>/dev/null || _hrc=$?
    # Both sides are stripped of a trailing CR before comparing (Codex
    # #1863 r25). A CRLF fragment against an LF dated file leaves the
    # carriage return on one side only, so an identical heading does not
    # match and the section is appended twice — the line endings deciding
    # a question that is about the text.
    if (( _hrc > 1 )); then
      rm -f "$_head_file"
      echo "Error: reading ${FRAG_NAME[$f]} failed (exit $_hrc)." >&2
      echo "Refusing to assemble: this fragment could not be checked against" >&2
      echo "the existing file, and skipping that check silently is how a" >&2
      echo "duplicated section gets through." >&2
      _refuse_reporting_consumed
    fi
    if [ ! -s "$_head_file" ]; then rm -f "$_head_file"; continue; fi
    # Status, not just the boolean. As an `if` condition a grep ERROR
    # (exit 2) is indistinguishable from an ordinary no-match, so a
    # transient read failure would quietly clear the duplicate check and
    # let the section be appended twice (Codex #1863 r9). `-x` via `-F`
    # with the whole line, and `-a` for the same NUL reason as above.
    # The COPY, not a fresh read of $OUT (Codex #1863 r24). A temporary
    # edit hiding the matching heading for the duration of this grep, and
    # reverted before the final check, made the duplicate check pass and
    # the section be appended a second time — the same gap as the `cat`
    # one round earlier, one site over.
    # Both normalisations are CHECKED (Codex #1863 r27). As the left side
    # of an `&&` list the first was exempt from `set -e`, so a failure
    # left the pattern file unnormalised and the comparison silently went
    # back to being decided by line endings — the duplicate appended and
    # the fragment deleted, on a run reporting success.
    # FILE TO FILE, never through a variable (Codex #1863 r28). Routing it
    # through `run_checked` fixed the unchecked-status fault and
    # introduced a NUL one in the same lines: bash drops NUL from a
    # command substitution, so a heading containing one came back altered
    # and the fixed-string search then looked for text the file does not
    # contain — missing the duplicate it exists to catch. The surrounding
    # code is NUL-safe precisely because it never puts these bytes in a
    # variable, and the fix had to keep that.
    if ! env LC_ALL=C sed -e 's/\r$//' "$_head_file" > "$_head_file.n"; then
      rm -f "$_head_file" "$_head_file.n"
      echo "Error: could not normalise the heading of ${FRAG_NAME[$f]}." >&2
      echo "Refusing to assemble: skipping that check silently is how a" >&2
      echo "duplicated section gets through." >&2
      _refuse_reporting_consumed
    fi
    mv "$_head_file.n" "$_head_file"
    _out_n="$SNAP/out.normalised"
    if ! env LC_ALL=C sed -e 's/\r$//' "$OUT_COPY" > "$_out_n"; then
      rm -f "$_head_file"
      echo "Error: could not normalise $(basename "$OUT") for comparison." >&2
      echo "Refusing to assemble: skipping that check silently is how a" >&2
      echo "duplicated section gets through." >&2
      _refuse_reporting_consumed
    fi
    run_checked 0,1 "checking $(basename "$OUT") for a repeated heading" \
      env LC_ALL=C grep -a -xF -f "$_head_file" "$_out_n"
    if [ -n "$CAPTURED" ]; then
      suspect+=("${FRAG_NAME[$f]}")
    fi
    rm -f "$_head_file"
  done

  if (( ${#suspect[@]} > 0 )) && (( out_has_markers == 0 )) && (( FORCE_APPEND == 0 )); then
    echo "Error: $(basename "$OUT") carries no assembly markers at all, and already" >&2
    echo "contains the heading of a fragment about to be appended. It may have been" >&2
    echo "written by an older version of this script whose run was interrupted, in" >&2
    echo "which case appending would duplicate it — and nothing in the file can say:" >&2
    echo "" >&2
    printf '  %s\n' "${suspect[@]}" >&2
    echo "" >&2
    echo "Read that section of $(basename "$OUT") and then either:" >&2
    echo "  - it is already there  -> delete the fragment(s) by hand" >&2
    echo "  - it is a new section  -> re-run with --force-append" >&2
    _refuse_reporting_consumed
  fi

  if (( ${#suspect[@]} > 0 )); then
    # $OUT has markers, so the record IS authoritative and these
    # fragments are genuinely unfolded — most often because an
    # interrupted run was followed by an EDIT to the still-pending
    # fragment, which changes its hash. Appending is right: the
    # alternative, deleting it as "already assembled" on the strength of
    # its name, discards the edit silently, and losing text is worse
    # than repeating it. But a repeated heading is worth a word, since
    # the older version of that section is probably still above.
    echo "Note: $(basename "$OUT") already contains these headings; appending anyway" >&2
    echo "(their fragments are not recorded as folded in, so the text differs):" >&2
    printf '  %s\n' "${suspect[@]}" >&2
    echo "Check for a superseded copy of that section while reviewing." >&2
    echo "" >&2
  fi
fi

# ── Write to a temp file, then rename ────────────────────────────────────────
# Everything below builds $WORK; $OUT is replaced in one `mv` at the end.
# `mktemp` in $DIR rather than /tmp so the rename is within a single
# filesystem — across a mount boundary `mv` degrades to copy-then-unlink
# and stops being atomic, which is the whole point of doing it this way.
# Built inside a PRIVATE directory, not directly in $DIR (Codex #1863
# r39). In a group-writable checkout another member could unlink the
# visible work file and put a symlink in its place before the `chmod`
# below — and `chmod` follows a symlink given on the command line, so a
# runner-owned 0600 file elsewhere was widened to 0644. The type check
# added last round refuses to PUBLISH that, but the widening has already
# happened; refusing afterwards does not undo it.
#
# A 0700 directory removes the capability instead of narrowing the
# window: nobody else can create or unlink entries inside it. Still under
# $DIR, so the rename stays within one filesystem, which is what makes it
# atomic.
# No `chmod` on it: `mktemp -d` already creates the directory 0700, and
# the chmod was both redundant and the whole exposure (Codex #1863 r40).
# `chmod` follows a command-line symlink, so a co-tenant able to rename
# this entry and drop a link at the same path could have redirected it
# onto one of their choosing. Removing the call removes the vector — the
# same lesson as the work file itself one round earlier, and the second
# time on this PR that the fix was to delete something rather than guard
# it.
WORKDIR="$(mktemp -d "$DIR/.assemble-$DATE.XXXXXX")"
WORK="$WORKDIR/replacement"
: > "$WORK"
# `mktemp` creates 0600, and `mv` carries that mode onto $OUT — so every
# successful assembly would quietly turn a world-readable release-notes
# file into an owner-only one, or create the new one that way (Codex
# #1863 r2). Restore what an ordinary file would have had: the existing
# file's own mode when appending, otherwise 0666 less the umask, which
# is what a plain `>` redirect produces.
# NOTE: the mode is only RESOLVED here; it is applied to $WORK further
# down, immediately before the rename. Applying it now can make the temp
# file unwritable to the very process building it — an existing output
# with mode 0460 (group-writable, owner not) copied onto a temp file the
# runner OWNS is evaluated by the owner bits, so the next write fails
# (Codex #1863 r13). Resolve early so a failure aborts before anything is
# consumed; apply late so the build is never locked out of its own file.
if [ -f "$OUT" ]; then
  # OWNERSHIP cannot survive the rename (Codex #1863 r14). Replacing a
  # file by renaming another over it installs a NEW inode, owned by
  # whoever ran the script — so a dated file owned by someone else, on a
  # shared checkout, silently changes hands and only the new owner can
  # chmod it afterwards. The old append wrote THROUGH the existing inode
  # and kept all of that.
  #
  # Unprivileged `chown` back is not available, so the honest options are
  # to change ownership silently or to refuse. It refuses: a metadata
  # change nobody asked for, on a file shared with another user, is not
  # something to do as a side effect of assembling release notes.
  _ow_rc=0
  out_uid="$(stat -c '%u' "$OUT" 2>/dev/null)" || _ow_rc=$?
  if (( _ow_rc != 0 )); then
    _ow_rc=0
    out_uid="$(stat -f '%u' "$OUT" 2>/dev/null)" || _ow_rc=$?
  fi
  if (( _ow_rc != 0 )) || [[ ! "$out_uid" =~ ^[0-9]+$ ]]; then
    echo "Error: could not read the owner of $(basename "$OUT")." >&2
    echo "Refusing to assemble: replacing it installs a new file, so the" >&2
    echo "current ownership has to be known before that is safe to do." >&2
    _refuse_reporting_consumed
  fi
  _og_rc=0
  out_gid="$(stat -c '%g' "$OUT" 2>/dev/null)" || _og_rc=$?
  if (( _og_rc != 0 )); then
    _og_rc=0
    out_gid="$(stat -f '%g' "$OUT" 2>/dev/null)" || _og_rc=$?
  fi
  if (( _og_rc != 0 )) || [[ ! "$out_gid" =~ ^[0-9]+$ ]]; then
    echo "Error: could not read the group of $(basename "$OUT")." >&2
    echo "Refusing to assemble: replacing it installs a new file, so the" >&2
    echo "current group has to be known before that is safe to do." >&2
    _refuse_reporting_consumed
  fi
  # The GROUP matters as much as the owner (Codex #1863 r15). Outside a
  # setgid directory the temp inode takes the runner's primary group, so
  # a `root:65534` file quietly becomes `root:root` and the collaborators
  # who reached it through that group lose access — the ownership refusal
  # alone does not cover this.
  # Compared against the group the REPLACEMENT will actually carry, not
  # against `id -g` (Codex #1863 r25). In a setgid directory `mktemp`
  # inherits the DIRECTORY's group, not the runner's — so where the two
  # differ this check compared the wrong pair, passed, and the rename
  # then changed the output's group silently before consuming anything.
  # The temp file is the authority on what it is about to become.
  # $WORK itself, not a second temp file (Codex #1863 r26). A probe is a
  # different inode created at a different moment: if the directory's
  # group or setgid bit changes between the two `mktemp` calls, the probe
  # can inherit the current group while $WORK still carries the old one,
  # and the check then passes about a file that is not the one being
  # installed. The replacement is the only authority on what it will be.
  _pg_rc=0
  if ! read_gid "$WORK"; then _pg_rc=1; fi
  _new_gid="$GID_READ"
  # And the EXISTING group comes from the baseline, not a fresh stat
  # (Codex #1863 r27) — the same fix the uid check already had. A chgrp
  # covering only this read, reverted afterwards, passed here AND passed
  # the final identity check against the restored value, while the rename
  # installed the other group permanently.
  out_gid="${OUT_ID##*:}"
  # Kept, so the gate can confirm the replacement still carries the group
  # that was approved rather than merely some group (Codex #1863 r38).
  APPROVED_GID="$_new_gid"
  if (( _pg_rc != 0 )); then
    echo "Error: could not determine the group a new file here would take." >&2
    echo "Refusing to assemble: replacing the dated file installs a new" >&2
    echo "inode, so that group has to be known before it is safe." >&2
    _refuse_reporting_consumed
  fi
  if [ "$out_gid" != "$_new_gid" ]; then
    echo "Error: $(basename "$OUT") has group $out_gid; a new file here" >&2
    echo "would take group $_new_gid." >&2
    echo "" >&2
    echo "Refusing to assemble: this script replaces the dated file by" >&2
    echo "renaming a new one over it, and the replacement takes that group —" >&2
    echo "so anyone who reaches the file through its current group would" >&2
    echo "quietly lose access." >&2
    _refuse_reporting_consumed
  fi
  # Compared against the owner recorded in the baseline, not a fresh read
  # (Codex #1863 r26). A file chowned to the runner for the duration of
  # this `stat` and restored afterwards passed here AND passed the final
  # identity check against its restored owner — and the rename then
  # transferred ownership permanently. One coherent version of the
  # metadata governs the rename, and it is the one already on record.
  out_uid="${OUT_ID##*owner=}"; out_uid="${out_uid%%:*}"
  if [ "$out_uid" != "$(id -u)" ]; then
    echo "Error: $(basename "$OUT") is owned by uid $out_uid, not by you." >&2
    echo "" >&2
    echo "Refusing to assemble: this script replaces the dated file by" >&2
    echo "renaming a new one over it, which would transfer ownership to you" >&2
    echo "and leave the current owner unable to change its permissions." >&2
    echo "Ask the owner to run the assembly, or take ownership deliberately" >&2
    echo "before re-running." >&2
    _refuse_reporting_consumed
  fi
  # GNU first, then BSD. If BOTH fail the mode is UNKNOWN, and falling
  # back to the new-file default would silently WIDEN an existing file —
  # a deliberately restricted 0600 becoming 0644 under the usual umask,
  # before the fragments are consumed (Codex #1863 r10). "I could not
  # read it" and "there is nothing to read" are different answers.
  # Each form is tried with its OWN status (Codex #1863 r12). Chained
  # with `|| true`, a `stat` that prints a plausible `644` and exits
  # non-zero was accepted by the regex — and an existing 0600 file was
  # then widened to 0644 before its fragments were consumed. Shape alone
  # cannot tell a real answer from a failed one that happens to look
  # like one.
  #
  # Taken from the identity captured before the marker scan rather than
  # read again here (Codex #1863 r18, r19). `read_mode` is where the
  # portability chain lives; this is just the value it produced, carried
  # forward so the mode applied to the replacement and the mode the final
  # check compares against came from one read of one file.
  FINAL_MODE="$OUT_MODE"
else
  FINAL_MODE="$(printf '%o' "$(( 0666 & ~0$(umask) ))")"
  # A NEW dated file still has a group worth pinning (Codex #1863 r39).
  # APPROVED_GID was set only on the existing-output branch, so for a new
  # file the gate's group check was skipped entirely — and in a setgid
  # checkout a runner in several groups could publish it under a group
  # nobody chose. The replacement's own initial group is the approved
  # one here: it is what a new file in this directory is supposed to get.
  if read_gid "$WORK"; then
    APPROVED_GID="$GID_READ"
  else
    echo "Error: could not read the group of the replacement." >&2
    echo "Refusing to assemble: the published file's group has to be known" >&2
    echo "before it is installed." >&2
    _refuse_reporting_consumed
  fi
fi

# Everything below builds on this COPY of $OUT, and the rename installs
# the copy plus the new sections — so an edit landing in between would be
# overwritten and gone, while the run deleted the fragments and reported
# success (Codex #1863 r17). The pool lock does not help: it excludes
# other assembler runs, not a person with the file open in an editor.
#
# What makes that safe is the baseline recorded before the marker scan
# and the `assert_output_unchanged` call below, not anything here. This
# is the protection the fragments already had, applied to the file they
# are folded into — an inconsistency in this script's own design rather
# than a considered asymmetry, since the dated file is the published one.
if [ -f "$OUT" ]; then
  # From the COPY the baseline describes, never from $OUT again.
  cat "$OUT_COPY" > "$WORK"
else
  printf '# Release Notes — %s\n' "$DATE" > "$WORK"
fi

for f in "${frags[@]}"; do
  printf '\n' >> "$WORK"
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
  ' "${FRAG_SNAP[$f]}" >> "$WORK"
  # Ensure a trailing newline between fragments.
  #
  # `tail`'s status is captured, not discarded (Codex #1863 r8). On
  # failure the substitution is empty, `-z` is TRUE, and the separating
  # newline is skipped — so the provenance marker is concatenated onto
  # the fragment's last line and becomes unparseable. Recovery then does
  # not recognise that fragment, appends it a second time, and deletes
  # the source. The line predates this change; what the marker did was
  # turn "two fragments run together" into "the recovery record for this
  # fragment is silently destroyed".
  # The final byte is examined as a NUMBER, never captured raw (Codex
  # #1863 r12). Bash drops NUL bytes from a command substitution, so a
  # fragment ENDING in NUL yielded an empty `CAPTURED` — read as "already
  # ends with a newline" — and the marker was then written straight after
  # the NUL instead of at the start of a line, where the anchored scan
  # can never find it again. `pipefail` is set, so a failing `tail` still
  # propagates through the pipe into run_checked.
  run_checked 0 "reading the last byte of ${FRAG_NAME[$f]}" last_byte_code "${FRAG_SNAP[$f]}"
  # 10 is LF. Anything else — including an empty fragment, which yields
  # no byte at all — needs a separator before the marker.
  [ "$CAPTURED" = "10" ] || printf '\n' >> "$WORK"
  # Provenance marker — an HTML comment, so it is invisible in every
  # rendered view and visible to the next run of this script. See the
  # "Crash safety" note at the top: this is what makes a re-run after an
  # interruption skip a fragment already folded in, instead of appending
  # it a second time.
  #
  # The hash comes from FRAG_HASH, validated up front (Codex #1863 r6).
  # Inlined as `$(frag_hash "$f")` a checksum failure is swallowed by the
  # command substitution: `printf` still succeeds, so the run writes a
  # marker with an EMPTY hash, replaces the output, deletes the fragment
  # and reports success. That marker can never be indexed, so if the run
  # is then interrupted the recovery it exists for is gone and the
  # section is appended twice. The one write the whole recovery rests on
  # must not be able to fail quietly.
  # The NAME goes into the durable record, so it is checked like the hash
  # (Codex #1863 r10): inlined, a `basename` failure is hidden by the
  # successful `printf` and the marker is written without one, which no
  # later run can match.
  #
  # Where the line is drawn, deliberately: `basename` is guarded where its
  # output is WRITTEN INTO THE FILE, not at the dozens of message-only
  # uses. A wrong word in an error message is a cosmetic fault; a wrong
  # word in the recovery record is a duplicated section.
  printf '%s%s sha256=%s -->\n' \
    "$MARKER_PREFIX" "${FRAG_NAME[$f]}" "${FRAG_HASH[$f]}" >> "$WORK"
done

# Defined BEFORE the rename, not after it (Codex #1863 r21). A shell
# function does not exist until its definition has been executed, and
# the readback below the rename called this one while it was still
# further down the file — so the very first post-publication failure
# died with `_abort_after_write: command not found` and exit 127,
# telling the operator nothing about the dated file already being
# written. A handler that only works after the second failure is not a
# handler. Moved up so every caller is downstream of it.
_cleared=()
_abort_after_write() {
  echo "" >&2
  echo "Error: $1." >&2
  echo "" >&2
  echo "$(basename "$OUT") HAS ALREADY BEEN WRITTEN — this failure is in the" >&2
  echo "clearing step that follows it, so the run is half done." >&2
  if (( ${#_cleared[@]} > 0 )); then
    echo "" >&2
    echo "Already cleared (their content is in the dated file):" >&2
    printf '  %s\n' "${_cleared[@]}" >&2
  fi
  echo "" >&2
  echo "Everything still in $UNREL is either uncleared or set aside. Re-running" >&2
  echo "is safe: the markers in the dated file are how the next run recognises" >&2
  echo "what is already folded in." >&2
  _refuse_reporting_consumed
}

# Every set-aside destination is checked BEFORE publishing (Codex #1863
# r27). A pending fragment sharing a basename with an earlier set-aside
# file collided only in the clearing loop — after the rename — so a first
# run published its section and then stopped half done, and every retry
# hit the same wall until the operator moved the quarantine by hand.
#
# The whole point of doing work before the rename is that failing there
# costs nothing. A precondition discoverable in advance belongs in
# advance.
# ── One gate, immediately before the rename ──────────────────────────────────
# Every precondition that must hold AT publication is checked here rather
# than scattered earlier (Codex #1863 r33). Three separate findings in one
# round were the same complaint — a check sitting before some other long
# step, with the gap between them big enough to drive through. Moving them
# one at a time just relocates the gap, so they are gathered into a single
# gate with nothing slow between it and the act.
#
# What remains after this is a handful of syscalls. That window cannot be
# closed by a shell — there is no way to hold these files against another
# writer — and further "move this check closer" findings are the same
# irreducible fact rather than new defects. See #1877.
_final_gate() {
  assert_sources_unchanged "replacing it"
  # The quarantine directory itself, not just its children: it was
  # validated near startup, and another process can replace it in the
  # meantime — the set-aside move then fails after publication.
  if [ -L "$QDIR" ] || [ ! -d "$QDIR" ]; then
    echo "Error: $QDIR is no longer a directory." >&2
    _refuse_reporting_consumed
  fi
  # And still WRITABLE. The startup probe answers for startup; a mode
  # change during `_persist` — which is slow by design — leaves the gate
  # passing on a directory the set-aside move will be refused by, after
  # publication (Codex #1863 r34). This is the distinction drawn last
  # round: the gap here contains a genuinely long operation, so it is a
  # real finding rather than the irreducible syscall window.
  # Signals held across creation and recording, as `_ensure_qdir` does
  # (Codex #1863 r35). This probe was added last round and repeated the
  # unprotected sequence the earlier one had already been fixed for.
  local _g_probe=""
  trap '' INT TERM
  if ! _g_probe="$(mktemp "$QDIR/.probe.XXXXXX" 2>/dev/null)"; then
    trap '_cleanup; exit 130' INT
    trap '_cleanup; exit 143' TERM
    echo "Error: entries can no longer be created in $QDIR." >&2
    _refuse_reporting_consumed
  fi
  PROBE="$_g_probe"
  trap '_cleanup; exit 130' INT
  trap '_cleanup; exit 143' TERM
  if ! rm "$_g_probe" 2>/dev/null; then
    rm -f "$_g_probe" 2>/dev/null || :
    PROBE=""
    echo "Error: entries can no longer be removed from $QDIR." >&2
    _refuse_reporting_consumed
  fi
  PROBE=""
  for _f in "${frags[@]}"; do
    # The type is re-checked here as well as at the snapshot (Codex #1863
    # r32). The earlier check is one moment near the start; a writer
    # replacing the file with a relative symlink to identical bytes
    # afterwards passes every hash, and only the set-aside move — after
    # publication — discovers that the link resolves somewhere else.
    if [ -L "$_f" ] || [ ! -f "$_f" ]; then
      echo "Error: ${FRAG_NAME[$_f]} is no longer a regular file." >&2
      echo "It changed type while this run was working." >&2
      _refuse_reporting_consumed
    fi
    # A STICKY pool restricts unlinking to the file's owner or the
    # directory's (Codex #1863 r37). A world-writable, sticky
    # `unreleased/` holding a fragment owned by somebody else lets the
    # write probe pass — the probe's own entry belongs to the runner —
    # while the set-aside `mv` cannot remove that foreign entry, and it
    # fails after publication. Per fragment, since the restriction is
    # per file.
    # `-k` read HERE, not from the startup cache (Codex #1863 r38): a
    # pool that gains the sticky bit during `_persist` skipped the guard
    # entirely, and the probe passed because the probe's own entry
    # belongs to the runner.
    # BOTH directories (Codex #1863 r42). The quarantine can be sticky
    # independently of the pool — a mode-1777 `.assembled/` owned by
    # someone else accepts the move and then forbids the removal, which
    # fails after publication. The source restricts the unlink from the
    # pool; the destination restricts the later unlink from quarantine.
    if { [ -k "$UNREL" ] && [ ! -O "$_f" ] && [ ! -O "$UNREL" ]; } \
       || { [ -k "$QDIR" ] && [ ! -O "$_f" ] && [ ! -O "$QDIR" ]; }; then
      echo "Error: ${FRAG_NAME[$_f]} is owned by someone else, and" >&2
      echo "$UNREL is sticky." >&2
      echo "" >&2
      echo "Refusing to assemble: setting a fragment aside has to remove its" >&2
      echo "entry from that directory, which only its owner or the" >&2
      echo "directory's owner may do there — so this would fail after the" >&2
      echo "dated file was written. Ask its owner to run the assembly." >&2
      _refuse_reporting_consumed
    fi
    _dest="$QDIR/${FRAG_NAME[$_f]}"
    if [ -e "$_dest" ] || [ -L "$_dest" ]; then
      echo "Error: a set-aside file already occupies $_dest." >&2
      echo "" >&2
      echo "Refusing to assemble: if ${FRAG_NAME[$_f]} had to be set aside" >&2
      echo "during this run it would have nowhere to go, and that failure" >&2
      echo "would happen after the dated file was already written." >&2
      echo "" >&2
      echo "Compare that file against the dated notes and remove it, or move" >&2
      echo "it elsewhere, then re-run." >&2
      _refuse_reporting_consumed
    fi
  done
  # The REPLACEMENT's own mode, re-read after the flush (Codex #1863
  # r37). Everything else in this gate looks at the output and the
  # sources; nothing looked at $WORK, and the post-rename readback
  # compares content only — so a mode change during `_persist` published
  # a widened file and consumed the fragments.
  # TYPE first (Codex #1863 r38). Checking the mode without the type let
  # a same-user process swap $WORK for a FIFO carrying the expected mode:
  # the gate passed, `mv` installed the FIFO at $OUT, and the
  # post-publication hash then blocked forever with the real dated file
  # already gone. A hang after publication is the worst outcome this
  # script has — it cannot even report.
  if [ -L "$WORK" ] || [ ! -f "$WORK" ]; then
    echo "Error: the replacement is no longer a regular file." >&2
    _refuse_reporting_consumed
  fi
  if ! read_mode "$WORK"; then
    echo "Error: could not re-read the mode of the replacement." >&2
    _refuse_reporting_consumed
  fi
  if [ "$MODE_READ" != "$FINAL_MODE" ]; then
    echo "Error: the replacement's mode changed while this run was" >&2
    echo "preparing it ($FINAL_MODE -> $MODE_READ)." >&2
    echo "Publishing it would install permissions this run did not choose." >&2
    _refuse_reporting_consumed
  fi
  # And the GROUP. A runner in several groups can change $WORK's group
  # without touching its bytes or its mode, and the existing checks —
  # content, mode, owner — all still passed while the rename installed a
  # different group on the published file (Codex #1863 r38).
  if ! read_gid "$WORK"; then
    echo "Error: could not re-read the group of the replacement." >&2
    _refuse_reporting_consumed
  fi
  if [ "$GID_READ" != "$APPROVED_GID" ]; then
    echo "Error: the replacement's group changed while this run was" >&2
    echo "preparing it ($APPROVED_GID -> $GID_READ)." >&2
    echo "Publishing it would hand the file to a group this run did not" >&2
    echo "approve." >&2
    _refuse_reporting_consumed
  fi
  # The SOURCE directory as well (Codex #1863 r36). A rename removes the
  # source entry, so `mv` needs write permission on BOTH directories —
  # $UNREL turning read-only during `_persist` leaves the destination
  # probe passing and the set-aside move failing after publication.
  local _s_probe=""
  trap '' INT TERM
  if ! _s_probe="$(mktemp "$UNREL/.probe.XXXXXX" 2>/dev/null)"; then
    trap '_cleanup; exit 130' INT
    trap '_cleanup; exit 143' TERM
    echo "Error: entries can no longer be created in $UNREL." >&2
    _refuse_reporting_consumed
  fi
  PROBE="$_s_probe"
  trap '_cleanup; exit 130' INT
  trap '_cleanup; exit 143' TERM
  if ! rm "$_s_probe" 2>/dev/null; then
    rm -f "$_s_probe" 2>/dev/null || :
    PROBE=""
    echo "Error: entries can no longer be removed from $UNREL." >&2
    _refuse_reporting_consumed
  fi
  PROBE=""
}

# The atomic step. Until this line $OUT is untouched, so an interruption
# at ANY point above leaves the previous release-notes file exactly as it
# was and every fragment still pending — the state a plain re-run
# handles. `mv` within one directory is a rename(2): $OUT is the old file
# or the new one, never a half-written mixture, and never a header-only
# stub that the next run would mistake for a real existing file.
# Applied to the FINISHED file, so nothing above can be locked out of it.
chmod "$FINAL_MODE" "$WORK"
# VERIFIED, not assumed (Codex #1863 r27). Linux clears the set-group-ID
# bit on a chmod by a user who is not a member of the file's group, and
# `chmod` still exits 0 — so a 2755 output was replaced by a 0755 one on
# a successful-looking run that then consumed the fragments. A command
# reporting success is not evidence the file now has the mode asked for.
if ! read_mode "$WORK"; then
  echo "Error: could not read back the mode of the replacement." >&2
  _refuse_reporting_consumed
fi
if [ "$MODE_READ" != "$FINAL_MODE" ]; then
  echo "Error: the replacement could not be given mode $FINAL_MODE" >&2
  echo "(it has $MODE_READ)." >&2
  echo "" >&2
  echo "This happens when a bit cannot be set by you — the set-group-ID bit" >&2
  echo "is dropped for a user outside the file's group, and chmod reports" >&2
  echo "success anyway. Replacing the file would silently drop it." >&2
  echo "" >&2
  _refuse_reporting_consumed
fi

# Push the replacement's bytes to disk BEFORE the fragments — the only
# copies of that text — are removed (Codex #1863 r17). `mv` within a
# directory is a rename(2), which is atomic for what a running system
# SEES, but says nothing about what survives a power cut: with write-back
# caching the deletions can reach disk while the new file's data has not,
# and the text is then gone from both places.
#
# Best-effort on purpose, and the one deliberate exception to this
# script's no-silent-failure rule. It narrows a crash window and cannot
# corrupt anything by not happening, so aborting a release-notes assembly
# because `sync` is missing or refuses a file argument would trade a rare
# fault for a common one. GNU `sync` takes file operands; BSD/macOS
# `sync` does not, hence the fallback to the whole-system form.
#
# It runs BEFORE the revalidation below, not between it and the rename
# (Codex #1863 r18). Placed after the check it is a long operation — the
# whole-system fallback can take seconds — sitting inside the very window
# the check exists to close, so an edit arriving during the flush was
# validated as absent and then overwritten anyway. A slow step belongs on
# the far side of the last look, never between it and the act.
_persist() { sync "$@" 2>/dev/null || sync 2>/dev/null || true; }
# The bytes this run BUILT, recorded before the flush (Codex #1863 r36).
# Reading the hash back off $OUT after the rename adopts whatever is
# there rather than checking it is what was constructed — so $WORK
# altered during `_persist`, which is deliberately slow, was published
# and then vouched for by its own digest, with the fragments consumed on
# the strength of it.
_exp_rc=0
EXPECTED_ID="$(frag_hash "$WORK")" || _exp_rc=$?
if (( _exp_rc != 0 )) || [[ ! "$EXPECTED_ID" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Error: could not hash the replacement before publishing it." >&2
  _refuse_reporting_consumed
fi
_persist "$WORK"

# ── Last look at the output before replacing it ──────────────────────────────
# One call, against the baseline taken before the marker scan. Content,
# shape, mode and ownership are all one question here: "is this still the
# file this run was working from?" (Codex #1863 r17, r18, r19 — three
# rounds of the same fault, answered once.)
#
# Nothing has been consumed yet, so refusing costs nothing: the temp file
# goes with the trap, every fragment is still pending, and a re-run
# builds on whatever landed.
_final_gate

# What remains between the last check and the rename is a handful of
# syscalls, which is as narrow as this gets without holding a lock on
# $OUT itself — a shell script cannot, and claiming the window is closed
# rather than minimised would be overstating it.

mv "$WORK" "$OUT"

# What was just published, recorded so the removals below can check it is
# still there (Codex #1863 r20). Every check up to this point asked "is
# $OUT still the file this run started from" — and after the rename that
# question is retired: the answer is deliberately no. Without a new
# baseline the fragments were then deleted on the strength of bytes
# nothing had looked at since, so a dated file removed during the flush
# below took the only other copy with it and the run still exited 0.
_pub_rc=0
PUBLISHED_ID="$(frag_hash "$OUT")" || _pub_rc=$?
if (( _pub_rc != 0 )) || [[ ! "$PUBLISHED_ID" =~ ^[0-9a-f]{64}$ ]]; then
  _abort_after_write "could not read $(basename "$OUT") back after writing it"
fi
# COMPARED with what was built, not merely recorded. Otherwise the
# readback is a tautology: whatever landed becomes the thing every later
# check agrees with.
if [ "$PUBLISHED_ID" != "$EXPECTED_ID" ]; then
  _abort_after_write "$(basename "$OUT") does not hold the bytes this run built"
fi

# The directory entry too, for the same reason: the rename itself is
# metadata, and the fragments about to be deleted are metadata in the
# same filesystem.
_persist "$DIR"
# $WORK has become $OUT, so clear the variable rather than the trap: the
# lock must stay held until the fragments below are deleted, which is the
# rest of the transaction, and `_cleanup` reads this to decide whether
# there is still a temp file to remove.
WORK=""
# The private directory is now empty; the trap removes it.

# Only now are the fragments consumed. An interruption between the rename
# and these deletes leaves fragments pending whose content IS already in
# $OUT — the one window a temp file cannot close, because the two files
# cannot be renamed as a unit. The markers written above are what make
# that state recoverable: the next run reads them, skips those fragments
# rather than duplicating them, and deletes them.
# Re-hash before removing (Codex #1863 r13). A fragment can be edited
# between the hash taken at classification and the read that built the
# output — an editor saving during the run. Deleting it then would throw
# away text that never reached $OUT, and the marker in $OUT would name a
# digest the file no longer has, so a later run would not recognise it
# either. Both halves are visible from here: if the bytes moved, the
# fragment is KEPT and said out loud.
#
# What this does NOT do is make the read atomic. The output may already
# contain the older text under the older digest; what it guarantees is
# that nothing is deleted on the strength of a hash that has since gone
# stale, so no writing is lost and the divergence is reported rather than
# buried.
# Failing HERE is different from failing anywhere else in this script,
# and the message has to say so. $OUT has already been replaced, so the
# run cannot simply be retried from scratch: some fragments are cleared,
# some are not, and the operator needs to know which. Bare `mv`/`rm`
# would abort under `set -e` with the tool's own status and no word about
# any of that — the same silence the whole PR has been closing, in the
# one place where the file is already published.

_kept=()
for f in "${frags[@]}"; do
  # QUARANTINE first, then check, then delete (Codex #1863 r14). Hashing
  # the path and then removing the path leaves a window: an editor
  # writing between the two has its bytes deleted, so the earlier
  # "nothing is deleted on a stale hash" was a stronger claim than
  # check-then-remove could support. `mv` within one directory is a
  # rename(2), so after it the inode we hold cannot be written by anyone
  # still addressing the old path — a save there creates a NEW file,
  # which is left alone and stays pending, exactly as it should. The
  # object checked and the object deleted are now the same one by
  # construction.
  # What the rename DOES and does not do (Codex #1863 r15 corrected an
  # earlier overstatement here). It stops anything opening the OLD PATH
  # from reaching this inode: a save there creates a new file, which is
  # left alone and stays pending. It does NOT close a descriptor already
  # open on the fragment — a writer holding one can still modify these
  # bytes between the re-hash and the `rm`, and no rename can prevent
  # that. So this narrows the window to the gap between two adjacent
  # statements and removes the whole class of "a NEW writer arrived",
  # rather than making the object immutable. The earlier comment claimed
  # the stronger thing and was wrong.
  #
  # DETERMINISTIC, no PID. The pool lock is held, so no other assembly can
  # be choosing names at the same time — and a name that does not depend
  # on a PID makes a leftover from an earlier crashed run both detectable
  # and reproducible, instead of a collision that only happens when a PID
  # is reused. A file already there is a fragment somebody has not looked
  # at yet, so it is reported rather than overwritten.
  # The published file, re-checked before every removal. These fragments
  # are the only other copy of what it holds, so "it is still there and
  # still says what it said" is the precondition for deleting any of
  # them — and it is checked per fragment, since the loop is N
  # irreversible steps rather than one.
  _pub_rc=0
  _pub_now="$(frag_hash "$OUT" 2>/dev/null)" || _pub_rc=$?
  if (( _pub_rc != 0 )) || [ "$_pub_now" != "$PUBLISHED_ID" ]; then
    _abort_after_write "$(basename "$OUT") is gone or altered since it was written"
  fi
  _q_name="${FRAG_NAME[$f]}"
  _q="$QDIR/$_q_name"
  # `-L` as well as `-e`, for the reason given at the other site.
  if [ -e "$_q" ] || [ -L "$_q" ]; then
    _abort_after_write "a set-aside file already exists at $(basename "$_q")"
  fi
  mv "$f" "$_q" || _abort_after_write "could not set aside ${FRAG_NAME[$f]}"
  # NOT `run_checked`: its message is the generic pre-publication one, and
  # by here $OUT is already replaced and this fragment already moved
  # (Codex #1863 r15). A failure has to speak the half-done contract or
  # the operator reads it as "refused before publishing".
  _rh_rc=0
  _rh="$(frag_hash "$_q")" || _rh_rc=$?
  if (( _rh_rc != 0 )); then
    _abort_after_write "could not re-hash ${FRAG_NAME[$f]} (now set aside as $(basename "$_q"))"
  fi
  CAPTURED="$_rh"
  if [ "$CAPTURED" = "${FRAG_HASH[$f]}" ]; then
    # Re-checked AFTER the hash and immediately before the delete (Codex
    # #1863 r28). Hashing is the long step here, and the published-file
    # check sat before it — so $OUT removed or altered during that hash
    # was never noticed, and the fragment went while the dated file held
    # none of its text. The check has to be adjacent to the act, not
    # merely somewhere upstream of it.
    # TYPE as well as bytes (Codex #1863 r33). Comparing only the digest
    # accepts $OUT replaced by a symlink to an identical copy elsewhere —
    # the content matches, the fragments are consumed, and the release
    # note path is left pointing outside the repository, so the `git add`
    # this script prints would not commit the assembled bytes at all.
    if [ -L "$OUT" ] || [ ! -f "$OUT" ]; then
      _abort_after_write "$(basename "$OUT") is no longer a regular file"
    fi
    _pub_rc=0
    _pub_now="$(frag_hash "$OUT" 2>/dev/null)" || _pub_rc=$?
    if (( _pub_rc != 0 )) || [ "$_pub_now" != "$PUBLISHED_ID" ]; then
      _abort_after_write "$(basename "$OUT") is gone or altered since it was written"
    fi
    # The QUARANTINE is re-hashed last, so the check nearest the delete is
    # the one about the thing being deleted (Codex #1863 r29). Hashing
    # $OUT above is itself a long step, and a writer holding the fragment
    # inode open from before the move can still write to it during that
    # window — bytes then deleted having reached no file at all.
    #
    # Two things must hold at the moment of the `rm` and only one can be
    # checked immediately before it. Ordering them puts the shorter window
    # on the output — which the operator still has, whole, either way —
    # and the shorter window on the fragment, which is the only copy.
    # The residual gap is a few syscalls and cannot be closed by a shell.
    _rh2_rc=0
    _rh2="$(frag_hash "$_q")" || _rh2_rc=$?
    if (( _rh2_rc != 0 )) || [ "$_rh2" != "${FRAG_HASH[$f]}" ]; then
      _kept+=("${FRAG_NAME[$f]} -> .assembled/${FRAG_NAME[$f]}")
      continue
    fi
    rm "$_q" || _abort_after_write "could not remove ${FRAG_NAME[$f]}"
    _cleared+=("${FRAG_NAME[$f]}")
  else
    # Deliberately NOT moved back: the editor may already have written a
    # new file at the original path, and restoring over it would destroy
    # the very text this branch exists to protect.
    _kept+=("${FRAG_NAME[$f]} -> .assembled/${FRAG_NAME[$f]}")
  fi
done

if (( ${#_kept[@]} > 0 )); then
  echo "" >&2
  echo "Kept (changed while this run was reading them), set aside as:" >&2
  printf '  %s\n' "${_kept[@]}" >&2
  echo "" >&2
  echo "$(basename "$OUT") holds the version read at the start of the run, and" >&2
  echo "its marker records THAT version — so these are not recognised as" >&2
  echo "folded in and were set aside rather than deleted. They are in" >&2
  echo "$QDIR — a hidden directory, so 'git add -A' would stage them." >&2
  echo "" >&2
  echo "Each holds the NEWER text while the dated file holds what was read" >&2
  echo "first, so one of these may be the only copy of an edit. Compare" >&2
  echo "before deleting; move one back up a level to assemble it instead." >&2
fi

echo "Assembled ${#frags[@]} fragment(s) -> $OUT"
echo ""
echo "Next:"
echo "  - review $OUT and add an intro paragraph"
echo "  - git add -A docs/ReleaseNotes/"
echo "  - git commit -m 'docs: release notes $DATE'"
