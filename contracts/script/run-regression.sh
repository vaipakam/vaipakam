#!/usr/bin/env bash
#
# run-regression.sh — local full-regression gate, run in compile-bounded CHUNKS
# so no single `solc` invocation forms the over-threshold compilation unit that
# trips viaIR "Variable size is N too deep in the stack".
#
# WHY CHUNKS (not one sparse pass): this codebase sits AT the viaIR whole-unit
# stack ceiling. The bare `forge test --no-match-path "test/invariants/*"` is
# non-sparse (compiles src+all-test+all-script) and fails outright. A single
# sparse `--match-path 'test/*.t.sol'` pass (matched files + deps, no standalone
# scripts) bought headroom for a while, but ordinary feature growth (#591)
# re-crossed even that. So we split the suite into chunks small enough that
# each `forge test --match-path` invocation stays under the ceiling. Foundry
# caches `src` across invocations, so only the first chunk pays the full src
# compile; the rest add just their own test files. See Issue #601 / #605.
#
# COVERAGE — CANNOT MISS A SUITE: the chunk set is DERIVED FROM `find`, so any
# new `*.t.sol` is picked up automatically. An exhaustiveness guard cross-checks
# every non-invariant test file against the chunks and ABORTS if one is
# uncovered — so a new suite can never be silently skipped.
#
# Forces FOUNDRY_PROFILE=default so a stray quick/cifast in the caller's env
# can't narrow the suite and still report green.
#
# USAGE:
#   bash script/run-regression.sh              # full suite minus invariants
#   bash script/run-regression.sh --invariants # ALSO run the invariant suites
#   CHUNK_SIZE=20 bash script/run-regression.sh # smaller chunks if a chunk trips
#
#   SHARDED (#2770) — the same chunks split across parallel machines:
#   bash script/run-regression.sh --shard 2/4 --manifest shard-2.tsv
#   bash script/run-regression.sh --list-chunks           # the plan, no forge
#   bash script/run-regression.sh --verify-shards DIR     # union check over
#                                                         # DIR/*.tsv manifests
#
# SHARDING (#2770): the chunk list is built first (the PLAN), then run. With
# `--shard i/N` this run executes only the plan's chunks whose position p
# (0-based) has p % N == i-1, so N shards together run every chunk exactly
# once. Each chunk's compile unit is unchanged, so a shard needs no more
# memory than the unsharded run; sharding buys wall time, not headroom.
# `--manifest FILE` records what this run did: the plan's digest, the shard,
# and one `pass`/`fail` line per chunk it ran. `--verify-shards DIR` rebuilds
# the plan and requires the manifests in DIR to be N distinct shards of THAT
# plan (same digest, indices 1..N once each) that between them passed every
# chunk exactly once. That union check is what makes a sharded gate as
# strong as the single run: a shard left out of the CI matrix, a shard given
# a different N, or a shard whose environment changed the plan (a FORK_URL_*
# or a chunk size) fails it instead of passing with chunks unrun.

set -uo pipefail
cd "$(dirname "$0")/.."   # -> contracts/
# The chunk rule both this script and predeploy-check.sh step 2 use (#2712).
# shellcheck source=lib/forge-chunks.sh
source script/lib/forge-chunks.sh

export FOUNDRY_PROFILE=default
# IO-priority boost only — `nice -n -10` (raised CPU priority) needs privileges
# operators/sandboxes lack and a failing nice would abort the run.
#
# The boost is a nicety, never a requirement, so PROBE it rather than assume:
# `ionice` may be absent (minimal container images), and RAISING best-effort
# priority to -n 0 needs CAP_SYS_NICE, which an unprivileged CI runner may not
# have. Either way the probe fails and we drop the prefix instead of failing
# every chunk. This matters since #1620 — `predeploy-check.sh --full` now
# delegates here, so this script runs on GitHub-hosted runners via
# `mainnet-gate.yml`, not just on the operator's box.
PREFIX=(ionice -c 2 -n 0)
if ! "${PREFIX[@]}" true 2>/dev/null; then
  echo "note: ionice unavailable or not permitted — running without the IO-priority boost" >&2
  PREFIX=()
fi

CHUNK_SIZE="${CHUNK_SIZE:-25}"

RUN_INVARIANTS=0
FORGE_ARGS=()
SHARD=""          # "i/N"; unset (SHARDED=0) = run every chunk
SHARDED=0
MANIFEST=""       # file this run records its chunks in
MODE=run          # run | list | verify
VERIFY_DIR=""
die() { echo "run-regression: $*" >&2; exit 2; }
while (( $# )); do
  case "$1" in
    --invariants) RUN_INVARIANTS=1 ;;
    --shard) (( $# > 1 )) || die "--shard needs i/N"; SHARDED=1; SHARD="$2"; shift ;;
    --shard=*) SHARDED=1; SHARD="${1#--shard=}" ;;
    --manifest) (( $# > 1 )) || die "--manifest needs a file"; MANIFEST="$2"; shift ;;
    --manifest=*) MANIFEST="${1#--manifest=}" ;;
    --list-chunks) MODE=list ;;
    --verify-shards) (( $# > 1 )) || die "--verify-shards needs a directory"; MODE=verify; VERIFY_DIR="$2"; shift ;;
    --verify-shards=*) MODE=verify; VERIFY_DIR="${1#--verify-shards=}" ;;
    *) FORGE_ARGS+=("$1") ;;
  esac
  shift
done

SHARD_I=1 SHARD_N=1
if (( SHARDED )); then
  [ "$MODE" = run ] || die "--shard applies to a run, not to --list-chunks / --verify-shards"
  [[ "$SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || die "--shard must be i/N with 1 <= i <= N, got '$SHARD'"
  SHARD_I="${BASH_REMATCH[1]}" SHARD_N="${BASH_REMATCH[2]}"
  (( SHARD_I <= SHARD_N )) || die "--shard must be i/N with 1 <= i <= N, got '$SHARD'"
fi
if [ "$MODE" != run ] && { [ -n "$MANIFEST" ] || (( ${#FORGE_ARGS[@]} )); }; then
  die "--list-chunks / --verify-shards take no forge arguments and write no manifest"
fi
# Planning notes go to stderr while listing, so stdout is the plan alone.
note() { if [ "$MODE" = run ]; then echo "$@"; else echo "$@" >&2; fi; }

# Subdirectories that hold *.t.sol (excluding invariants, which run separately).
# A new such subdir must be added here; the exhaustiveness guard fails loudly
# if one appears that isn't covered.
SUBDIRS=(scenarios deploy fork seaport token)

# ── Top-level suites, chunked ────────────────────────────────────────────────
# `test/*.t.sol` recurses under globset (its `*` crosses `/`), so we CANNOT use
# it to mean "top-level only". Instead enumerate the top-level files explicitly
# (find -maxdepth 1) and pass each chunk as a brace glob of exact file stems —
# no slashes inside the brace, so no recursion ambiguity.
mapfile -t TOP < <(forge_test_stems test)

FAILED=0
# The PLAN: every chunk this regression consists of, in order, built before
# anything runs so a shard can take its share and a verifier can rebuild it.
PLAN_LABELS=() PLAN_GLOBS=()
plan() { PLAN_LABELS+=("$1"); PLAN_GLOBS+=("$2"); }

run() {  # run(label, glob) -> 0 pass, 1 fail
  local label="$1"; local glob="$2"
  # #1780 — the deploy chunk carries `FacetSizeLimitTest`'s headroom report,
  # which ALWAYS PASSES by design (it reports facets running out of EIP-170
  # room rather than failing them). Foundry hides logs from passing tests
  # below `-vv`, so without this the report is silent on the `--full` path —
  # i.e. exactly the mainnet preflight and release gate that most want to know
  # a facet is nearly full. `predeploy-check.sh` fixed its own non-full branch;
  # this branch delegates HERE, so it needs its own answer.
  #
  # Scoped to the deploy chunk on purpose: `-vv` across the whole regression
  # would print logs from every passing test in the suite and bury the six
  # lines this exists to surface.
  local extra=()
  case "$glob" in
    test/deploy/*) extra=(-vv) ;;
  esac
  echo ""
  echo "===== $label : forge test --match-path '$glob' ${extra[*]} ====="
  if "${PREFIX[@]}" forge test --match-path "$glob" "${FORGE_ARGS[@]}" "${extra[@]}"; then
    return 0
  fi
  echo "CHUNK FAILED: $label" >&2
  return 1
}

# run_chunks(label, dir, size, stem...) — one `plan` entry per chunk the shared
# helper (script/lib/forge-chunks.sh) cuts. A bad size aborts the run rather
# than quietly running nothing.
run_chunks() {
  local label="$1" dir="$2" size="$3"; shift 3
  local out; out=$(forge_chunk_globs "$dir" "$size" "$@") || exit 1
  [ -z "$out" ] && return
  local globs=() i=0 g
  mapfile -t globs <<<"$out"
  for g in "${globs[@]}"; do
    i=$((i+1)); plan "$label #$i" "$g"
  done
}

run_chunks "top-level chunk" test "$CHUNK_SIZE" "${TOP[@]}"

# ── Subdirectory suites — chunked PER subdir (like the top-level suites) ──────
# One glob per subdir (`test/$sub/*.t.sol`) was ceiling-safe on 2026-07-01, but
# ordinary growth pushed the `fork` subdir ALONE over the viaIR whole-unit stack
# ceiling by 2026-07-13 ("Variable size is 1 too deep") — its 5 heavy sources
# (2 Seaport-fork + 2 mainnet-fork + Permit2-fork, each pulling large src/ deps)
# now exceed one compile unit. So subdirs are chunked the SAME way the top-level
# suites are: each subdir's files are split into `SUBDIR_CHUNK_SIZE`-file brace
# globs, keeping every compile unit small. Foundry caches src/ across
# invocations, so this is the same total compile, just in ceiling-safe units.
# Future-proof: a newly-added subdir file is picked up by `find` and chunked
# automatically. Tune down via SUBDIR_CHUNK_SIZE=N if a chunk ever trips.
# (fork tests self-skip when their FORK_URL_* envs are unset, so once a chunk
# COMPILES the fork suite passes trivially — the ceiling was the only blocker.)
SUBDIR_CHUNK_SIZE="${SUBDIR_CHUNK_SIZE:-3}"
for sub in "${SUBDIRS[@]}"; do
  mapfile -t SUBFILES < <(forge_test_stems "test/$sub")
  (( ${#SUBFILES[@]} == 0 )) && continue

  # `fork` subdir: each file needs a SPECIFIC fork RPC and self-skips without it
  # (`vm.envOr("FORK_URL_*", "")` → early return), so with no URL it adds zero
  # coverage. Gate each file by the URLs IT reads (Codex #1201) so setting only
  # one URL never drags in — and tries to COMPILE — another chain's files.
  #
  # The URLs a file needs are the `FORK_URL_*` names written in it, and the file
  # is kept when ANY of them is set: a file with one cell per chain (e.g. the
  # #2550 priority-routing proof, Base Sepolia and Arbitrum Sepolia) must run its
  # Arbitrum cell when only FORK_URL_ARB_SEPOLIA is set, and each cell skips
  # itself when its own URL is unset. Classifying by file NAME could not express
  # that (Codex #2589 r1): every *LiveFork* file was gated on the Base URL alone,
  # so an Arbitrum-only run compiled nothing and passed. A fork file that names
  # no `FORK_URL_*` at all is refused rather than guessed at.
  #
  # Today that reads as: the *Seaport* and Base Sepolia *LiveFork* sources need
  # FORK_URL_BASE_SEPOLIA, and the mainnet-fork sources (Oracle / Permit2 /
  # Liquidation) need FORK_URL_MAINNET. The Seaport sources ALSO exceed the viaIR
  # bounded-compile ceiling on current main (even a single Seaport file trips
  # "Variable size N too deep" — full build only, #601/#603), so absent that URL
  # they must not be compiled here at all.
  # A file whose URLs are all unset is dropped (still "covered" by the
  # exhaustiveness guard below). All unset → the whole subdir is skipped, keeping
  # the default no-URL pre-deploy gate green. NOTE: when FORK_URL_BASE_SEPOLIA IS
  # set, the Seaport chunk still needs the src-level lean-DTO ceiling fix to
  # compile — this gate does not pretend otherwise.
  if [ "$sub" = "fork" ]; then
    kept=()
    for stem in "${SUBFILES[@]}"; do
      mapfile -t needs < <(grep -oE 'FORK_URL_[A-Z0-9_]+' "test/fork/$stem.t.sol" | sort -u)
      if (( ${#needs[@]} == 0 )); then
        echo "run-regression: test/fork/$stem.t.sol names no FORK_URL_* variable, so the RPC it needs is unknown -- name the variable it reads" >&2
        exit 1
      fi
      have=0
      for v in "${needs[@]}"; do [ -n "${!v:-}" ] && have=1; done
      if (( have )); then kept+=("$stem")
      else note "  fork: skip $stem (needs one of: ${needs[*]})"; fi
    done
    if (( ${#kept[@]} == 0 )); then
      note ""
      note "===== subdir (fork) : SKIPPED — no matching FORK_URL_* set"
      note "      (each fork test self-skips without its RPC; Seaport also exceeds the"
      note "       viaIR bounded-compile ceiling — full build only. See #601/#603.)"
      continue
    fi
    SUBFILES=("${kept[@]}")
  fi
  run_chunks "subdir ($sub)" "test/$sub" "$SUBDIR_CHUNK_SIZE" "${SUBFILES[@]}"
done

# ── Optional invariants pass ─────────────────────────────────────────────────
if (( RUN_INVARIANTS )); then
  plan "invariants" "test/invariants/*.t.sol"
fi

# ── Exhaustiveness guard ─────────────────────────────────────────────────────
# Every non-invariant test file must be either top-level OR under a covered
# subdir. Anything else (a new subdir, a nested path) is uncovered → fail.
shopt -s nullglob
declare -A COVERED=()
for f in test/*.t.sol; do COVERED["$f"]=1; done
for d in "${SUBDIRS[@]}"; do for f in test/"$d"/*.t.sol; do COVERED["$f"]=1; done; done
MISSED=()
while IFS= read -r f; do [[ -n "${COVERED[$f]:-}" ]] || MISSED+=("$f"); done \
  < <(find test -name '*.t.sol' ! -path 'test/invariants/*' | sort)
if (( ${#MISSED[@]} > 0 )); then
  echo "" >&2
  echo "ERROR: ${#MISSED[@]} non-invariant test file(s) not covered by any chunk — add the dir to SUBDIRS:" >&2
  printf '  %s\n' "${MISSED[@]}" >&2
  FAILED=1
fi

# The plan's identity: a digest over the chunk globs in order, and over any
# extra forge arguments. Two runs share it exactly when they would run the
# same tests, so shards whose environments disagree (a FORK_URL_*, a chunk
# size, --invariants) cannot be verified as parts of one regression, and nor
# can a shard narrowed by a forge filter such as --match-test: the verifier
# takes no forge arguments, so only an unfiltered shard matches its plan.
PLAN_DIGEST=$({ printf 'chunk\t%s\n' "${PLAN_GLOBS[@]}"; printf 'forge-arg\t%s\n' ${FORGE_ARGS[@]+"${FORGE_ARGS[@]}"}; } | sha256sum | cut -d' ' -f1)

# ── --list-chunks ────────────────────────────────────────────────────────────
if [ "$MODE" = list ]; then
  (( FAILED )) && exit 1
  for k in "${!PLAN_GLOBS[@]}"; do printf '%s\t%s\n' "${PLAN_LABELS[$k]}" "${PLAN_GLOBS[$k]}"; done
  exit 0
fi

# ── --verify-shards DIR ──────────────────────────────────────────────────────
# Read every DIR/*.tsv manifest and require: one plan digest, equal to this
# plan's; one N; shard indices 1..N exactly once; and every planned chunk run
# by exactly one shard, which passed it. Nothing run that is not planned.
if [ "$MODE" = verify ]; then
  (( FAILED )) && exit 1
  [ -d "$VERIFY_DIR" ] || die "--verify-shards: '$VERIFY_DIR' is not a directory"
  mapfile -t MANIFESTS < <(find "$VERIFY_DIR" -type f -name '*.tsv' | LC_ALL=C sort)
  (( ${#MANIFESTS[@]} )) || { echo "verify-shards: no *.tsv manifests in $VERIFY_DIR" >&2; exit 1; }
  BAD=0
  declare -A SEEN_SHARD=() RAN=() PLANNED=()
  for g in "${PLAN_GLOBS[@]}"; do PLANNED["$g"]=1; done
  N=""
  for m in "${MANIFESTS[@]}"; do
    md=$(awk -F'\t' '$1=="plan"{print $2}' "$m")
    ms=$(awk -F'\t' '$1=="shard"{print $2}' "$m")
    mc=$(awk -F'\t' '$1=="complete"{print "yes"}' "$m")
    if [ "$md" != "$PLAN_DIGEST" ]; then
      echo "verify-shards: $m was cut from a different plan (digest ${md:-none}, expected $PLAN_DIGEST)" >&2; BAD=1; continue
    fi
    if ! [[ "$ms" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]]; then
      echo "verify-shards: $m names no shard i/N" >&2; BAD=1; continue
    fi
    if [ -z "$N" ]; then N="${BASH_REMATCH[2]}"
    elif [ "$N" != "${BASH_REMATCH[2]}" ]; then
      echo "verify-shards: $m is shard $ms, but another manifest split the plan $N ways" >&2; BAD=1; continue
    fi
    if [ -n "${SEEN_SHARD[${BASH_REMATCH[1]}]:-}" ]; then
      echo "verify-shards: shard ${BASH_REMATCH[1]} reported twice ($m and ${SEEN_SHARD[${BASH_REMATCH[1]}]})" >&2; BAD=1; continue
    fi
    SEEN_SHARD["${BASH_REMATCH[1]}"]="$m"
    [ "$mc" = yes ] || { echo "verify-shards: $m never recorded completing — the shard stopped mid-run" >&2; BAD=1; }
    while IFS=$'\t' read -r status glob; do
      case "$status" in pass|fail) ;; *) continue ;; esac
      if [ -z "${PLANNED[$glob]:-}" ]; then
        echo "verify-shards: $m ran $glob, which the plan does not contain" >&2; BAD=1
      elif [ -n "${RAN[$glob]:-}" ]; then
        echo "verify-shards: $glob was run by two shards" >&2; BAD=1
      else
        RAN["$glob"]="$status"
      fi
    done < "$m"
  done
  if [ -n "$N" ]; then
    for ((k=1; k<=N; k++)); do
      [ -n "${SEEN_SHARD[$k]:-}" ] || { echo "verify-shards: no manifest for shard $k/$N" >&2; BAD=1; }
    done
  fi
  for g in "${PLAN_GLOBS[@]}"; do
    case "${RAN[$g]:-}" in
      pass) ;;
      fail) echo "verify-shards: chunk FAILED: $g" >&2; BAD=1 ;;
      *) echo "verify-shards: chunk never run by any shard: $g" >&2; BAD=1 ;;
    esac
  done
  if (( BAD )); then echo "REGRESSION (sharded): NOT verified ^^^" >&2; exit 1; fi
  echo "REGRESSION (sharded): verified — ${#PLAN_GLOBS[@]} chunks across ${N} shards, each run once and passed (plan $PLAN_DIGEST)"
  exit 0
fi

# ── Run this shard's chunks ──────────────────────────────────────────────────
if [ -n "$MANIFEST" ]; then
  : > "$MANIFEST" || die "cannot write manifest '$MANIFEST'"
  printf 'plan\t%s\nshard\t%s/%s\n' "$PLAN_DIGEST" "$SHARD_I" "$SHARD_N" >> "$MANIFEST"
fi
MINE=0
for k in "${!PLAN_GLOBS[@]}"; do
  (( k % SHARD_N == SHARD_I - 1 )) || continue
  MINE=$((MINE+1))
  if run "${PLAN_LABELS[$k]}" "${PLAN_GLOBS[$k]}"; then st=pass; else st=fail; FAILED=1; fi
  [ -n "$MANIFEST" ] && printf '%s\t%s\n' "$st" "${PLAN_GLOBS[$k]}" >> "$MANIFEST"
done
# Written last, so a manifest without it is a shard that died mid-run.
[ -n "$MANIFEST" ] && printf 'complete\t%s\n' "$MINE" >> "$MANIFEST"
if (( SHARDED )); then
  echo ""
  echo "shard $SHARD_I/$SHARD_N ran $MINE of ${#PLAN_GLOBS[@]} chunks (plan $PLAN_DIGEST)"
fi

echo ""
if (( FAILED )); then echo "REGRESSION: FAILURES above ^^^" >&2; exit 1; fi
if (( SHARDED )); then
  echo "REGRESSION: shard $SHARD_I/$SHARD_N green — the whole regression is green only once --verify-shards accepts every shard"
else
  echo "REGRESSION: green (all chunks + exhaustiveness guard)"
fi
