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
# ONE exception, and it needs a manual step: a HARD kill (SIGKILL, or the
# machine dying) leaves the lock directory behind, because no trap runs.
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
# ONE cleanup for every exit path. Separate traps drifted apart once
# already: the EXIT trap was later replaced with one that also removed
# the temp file, which left the signal traps still cleaning only the
# lock. A single function cannot fall out of step with itself.
_cleanup() {
  [ -n "$WORK" ] && rm -f "$WORK"
  (( LOCK_HELD )) && rmdir "$LOCK" 2>/dev/null
  return 0
}
trap '_cleanup' EXIT
trap '_cleanup; exit 130' INT
trap '_cleanup; exit 143' TERM
if ! mkdir "$LOCK" 2>/dev/null; then
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

# One CHECKED basename per fragment, resolved once and reused (Codex
# #1863 r13). Inline `$(basename "$f")` in the test below could fail
# transiently, and its empty output would slip past the rejection while a
# later successful call wrote the forbidden name into the marker — the
# check and the use disagreeing about what the name even is. Resolving it
# once removes that gap by construction, the same way FRAG_HASH does for
# the digest.
declare -A FRAG_NAME=()
for f in "${frags[@]}"; do
  run_checked 0 "naming $f" basename "$f"
  FRAG_NAME["$f"]="$CAPTURED"
  # A basename cannot be allowed to close the marker's HTML comment
  # (#1863 r12). `note-->visible.md` produces
  # `<!-- assembled-fragment: note-->visible.md sha256=… -->`, which ends
  # at the name: the hash — and anything else the name carries — then
  # renders as visible text in the published notes, breaking the one
  # promise the marker makes. Refused rather than escaped, because these
  # names are ours and a legible one never contains `-->`.
  case "${FRAG_NAME[$f]}" in
    *'-->'* | *'<!--'*)
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
    env LC_ALL=C grep -a -E "^$MARKER_PREFIX.+ sha256=[0-9a-f]{64} -->$" "$f"
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
    env LC_ALL=C grep -a -E "^$MARKER_PREFIX.+ sha256=[0-9a-f]{64} -->$" "$dated"
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
  run_checked 0 "hashing $(basename "$f")" frag_hash "$f"
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
  for f in "${already[@]}"; do
    rm "$f"
  done
fi

if (( ${#pending[@]} == 0 )); then
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
    env LC_ALL=C grep -a -E "^$MARKER_PREFIX.+ sha256=[0-9a-f]{64} -->$" "$OUT"
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
    _head_file="$(mktemp)"
    _hrc=0
    env LC_ALL=C grep -a -m1 '^#\{1,6\} ' "$f" > "$_head_file" 2>/dev/null || _hrc=$?
    if (( _hrc > 1 )); then
      rm -f "$_head_file"
      echo "Error: reading ${FRAG_NAME[$f]} failed (exit $_hrc)." >&2
      echo "Refusing to assemble: this fragment could not be checked against" >&2
      echo "the existing file, and skipping that check silently is how a" >&2
      echo "duplicated section gets through." >&2
      exit 1
    fi
    if [ ! -s "$_head_file" ]; then rm -f "$_head_file"; continue; fi
    # Status, not just the boolean. As an `if` condition a grep ERROR
    # (exit 2) is indistinguishable from an ordinary no-match, so a
    # transient read failure would quietly clear the duplicate check and
    # let the section be appended twice (Codex #1863 r9). `-x` via `-F`
    # with the whole line, and `-a` for the same NUL reason as above.
    run_checked 0,1 "checking $(basename "$OUT") for a repeated heading" \
      env LC_ALL=C grep -a -xF -f "$_head_file" "$OUT"
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
    exit 1
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
WORK="$(mktemp "$DIR/.assemble-$DATE.XXXXXX")"
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
    exit 1
  fi
  if [ "$out_uid" != "$(id -u)" ]; then
    echo "Error: $(basename "$OUT") is owned by uid $out_uid, not by you." >&2
    echo "" >&2
    echo "Refusing to assemble: this script replaces the dated file by" >&2
    echo "renaming a new one over it, which would transfer ownership to you" >&2
    echo "and leave the current owner unable to change its permissions." >&2
    echo "Ask the owner to run the assembly, or take ownership deliberately" >&2
    echo "before re-running." >&2
    exit 1
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
  _sm_rc=0
  out_mode="$(stat -c '%a' "$OUT" 2>/dev/null)" || _sm_rc=$?
  if (( _sm_rc != 0 )); then
    _sm_rc=0
    out_mode="$(stat -f '%Lp' "$OUT" 2>/dev/null)" || _sm_rc=$?
  fi
  if (( _sm_rc != 0 )) || [[ ! "$out_mode" =~ ^[0-7]{3,4}$ ]]; then
    echo "Error: could not read the current mode of $(basename "$OUT")." >&2
    echo "Refusing to assemble: replacing it would have to guess a mode, and" >&2
    echo "guessing wider than it was would expose content that was" >&2
    echo "deliberately restricted." >&2
    exit 1
  fi
  FINAL_MODE="$out_mode"
else
  FINAL_MODE="$(printf '%o' "$(( 0666 & ~0$(umask) ))")"
fi

if [ -f "$OUT" ]; then
  cat "$OUT" > "$WORK"
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
  ' "$f" >> "$WORK"
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
  run_checked 0 "reading the last byte of $(basename "$f")" last_byte_code "$f"
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

# The atomic step. Until this line $OUT is untouched, so an interruption
# at ANY point above leaves the previous release-notes file exactly as it
# was and every fragment still pending — the state a plain re-run
# handles. `mv` within one directory is a rename(2): $OUT is the old file
# or the new one, never a half-written mixture, and never a header-only
# stub that the next run would mistake for a real existing file.
# Applied to the FINISHED file, so nothing above can be locked out of it.
chmod "$FINAL_MODE" "$WORK"
mv "$WORK" "$OUT"
# $WORK has become $OUT, so clear the variable rather than the trap: the
# lock must stay held until the fragments below are deleted, which is the
# rest of the transaction, and `_cleanup` reads this to decide whether
# there is still a temp file to remove.
WORK=""

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
  exit 1
}

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
  # DETERMINISTIC, no PID. The pool lock is held, so no other assembly can
  # be choosing names at the same time — and a name that does not depend
  # on a PID makes a leftover from an earlier crashed run both detectable
  # and reproducible, instead of a collision that only happens when a PID
  # is reused. A file already there is a fragment somebody has not looked
  # at yet, so it is reported rather than overwritten.
  _q="$UNREL/.assembled.${FRAG_NAME[$f]}"
  if [ -e "$_q" ]; then
    _abort_after_write "a set-aside file already exists at $(basename "$_q")"
  fi
  mv "$f" "$_q" || _abort_after_write "could not set aside ${FRAG_NAME[$f]}"
  run_checked 0 "re-hashing ${FRAG_NAME[$f]} before removing it" frag_hash "$_q"
  if [ "$CAPTURED" = "${FRAG_HASH[$f]}" ]; then
    rm "$_q" || _abort_after_write "could not remove ${FRAG_NAME[$f]}"
    _cleared+=("${FRAG_NAME[$f]}")
  else
    # Deliberately NOT moved back: the editor may already have written a
    # new file at the original path, and restoring over it would destroy
    # the very text this branch exists to protect.
    _kept+=("${FRAG_NAME[$f]} -> $(basename "$_q")")
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
  echo "$UNREL under the shown names." >&2
  echo "Compare them against the assembled file, then delete them or restore" >&2
  echo "the name by hand once you are satisfied nothing was lost." >&2
fi

echo "Assembled ${#frags[@]} fragment(s) -> $OUT"
echo ""
echo "Next:"
echo "  - review $OUT and add an intro paragraph"
echo "  - git add -A docs/ReleaseNotes/"
echo "  - git commit -m 'docs: release notes $DATE'"
