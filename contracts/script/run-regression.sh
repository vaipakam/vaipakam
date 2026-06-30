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

set -uo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

export FOUNDRY_PROFILE=default
# IO-priority boost only — `nice -n -10` (raised CPU priority) needs privileges
# operators/sandboxes lack and a failing nice would abort the run.
PREFIX=(ionice -c 2 -n 0)

CHUNK_SIZE="${CHUNK_SIZE:-25}"

RUN_INVARIANTS=0
FORGE_ARGS=()
for a in "$@"; do
  case "$a" in
    --invariants) RUN_INVARIANTS=1 ;;
    *) FORGE_ARGS+=("$a") ;;
  esac
done

# Subdirectories that hold *.t.sol (excluding invariants, which run separately).
# A new such subdir must be added here; the exhaustiveness guard fails loudly
# if one appears that isn't covered.
SUBDIRS=(scenarios deploy fork seaport token)

# ── Top-level suites, chunked ────────────────────────────────────────────────
# `test/*.t.sol` recurses under globset (its `*` crosses `/`), so we CANNOT use
# it to mean "top-level only". Instead enumerate the top-level files explicitly
# (find -maxdepth 1) and pass each chunk as a brace glob of exact file stems —
# no slashes inside the brace, so no recursion ambiguity.
mapfile -t TOP < <(find test -maxdepth 1 -name '*.t.sol' -printf '%f\n' | sed 's/\.t\.sol$//' | sort)

FAILED=0
run() {  # run(label, glob...)
  local label="$1"; shift
  echo ""
  echo "===== $label : forge test --match-path '$*' ====="
  "${PREFIX[@]}" forge test --match-path "$*" "${FORGE_ARGS[@]}" || { echo "CHUNK FAILED: $label" >&2; FAILED=1; }
}

n=0; chunk=()
flush() {
  (( ${#chunk[@]} == 0 )) && return
  local joined; joined=$(IFS=,; echo "${chunk[*]}")
  run "top-level chunk #$1" "test/{$joined}.t.sol"
  chunk=()
}
ci=0
for stem in "${TOP[@]}"; do
  chunk+=("$stem"); n=$((n+1))
  if (( n % CHUNK_SIZE == 0 )); then ci=$((ci+1)); flush "$ci"; fi
done
ci=$((ci+1)); flush "$ci"

# ── Subdirectory suites — one chunk PER subdir ───────────────────────────────
# Running all subdirs in a single `test/{scenarios,deploy,fork,seaport,token}/
# *.t.sol` glob compiles them as ONE unit, which trips the viaIR whole-unit
# stack ceiling ("Variable size is N too deep") — the heavy fork + deploy +
# seaport sources together exceed it (the #601/#603 ceiling), even though every
# test passes. Per-subdir invocations keep each compile unit small AND are
# future-proof: a newly-added subdir gets its own ceiling-safe chunk
# automatically and can never recombine with the others to re-trip the limit.
# Foundry caches src/ artifacts across invocations, so this is the same total
# compile, just split into units that each stay under the ceiling. (Verified
# 2026-07-01: the combined glob trips at "1 too deep"; the two halves
# {scenarios,deploy,token} = 58 tests and {fork,seaport} = 59 tests both
# compile + pass — per-subdir is strictly smaller still.)
for sub in "${SUBDIRS[@]}"; do
  run "subdir ($sub)" "test/$sub/*.t.sol"
done

# ── Optional invariants pass ─────────────────────────────────────────────────
if (( RUN_INVARIANTS )); then
  run "invariants" "test/invariants/*.t.sol"
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

echo ""
if (( FAILED )); then echo "REGRESSION: FAILURES above ^^^" >&2; exit 1; fi
echo "REGRESSION: green (all chunks + exhaustiveness guard)"
