#!/usr/bin/env bash
#
# run-regression-batched.sh — local full-regression gate, run in compile-bounded
# CHUNKS so no single `solc` invocation forms the over-threshold compilation unit
# that trips viaIR "Variable size is N too deep in the stack".
#
# WHY: this codebase sits near the viaIR whole-unit stack ceiling. Compiling
# `src` + ALL `test` + `script` in one pass (`forge test --no-match-path
# "test/invariants/*"`) currently fails to COMPILE on some branches even though
# every test is correct — it's a toolchain limit, not a code bug. CI sidesteps
# it by running the narrower `cifast` lane; this script is the LOCAL end-of-step
# gate that still exercises the full suite, just split into chunks that each
# stay under the ceiling. See issue #601 and the design note in
# docs/ReleaseNotes (#603) for the full rationale; the principled cause-fix is
# to keep paginated/array views returning lean DTOs (not arrays of 40-field
# structs) so the chunks stay comfortably small.
#
# COVERAGE GUARANTEE: Foundry tests are per-test isolated (fresh EVM + setUp per
# test), so splitting files across invocations is behaviour-neutral — no test
# result changes. The only way batching could "miss" a suite is a coverage GAP
# (a test file matched by no chunk). The exhaustiveness guard below makes that
# impossible: it diffs `find test -name '*.t.sol'` (the source of truth, so any
# NEW suite is auto-discovered) against the union of the chunk globs and ABORTS
# if any non-invariant file is uncovered. A new suite therefore either lands in
# an existing chunk automatically or fails the guard loudly — never silently
# skipped.
#
# USAGE:
#   bash script/run-regression-batched.sh            # all chunks + exhaustiveness guard
#   bash script/run-regression-batched.sh --invariants   # also run the invariants pass
#   INCLUDE_INVARIANTS=1 bash script/run-regression-batched.sh
#
# If a chunk ever trips "stack too deep", subdivide it (e.g. split the top-level
# chunk into 'test/[A-M]*.t.sol' and 'test/[N-Z]*.t.sol') and add the new globs
# to BOTH the CHUNKS array and the COVER_GLOBS expansion — the guard keeps them
# honest.

set -uo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

PREFIX=(ionice -c 2 -n 0)

# ── Chunk globs (each a subset verified to compile under the viaIR ceiling) ──
# forge --match-path takes ONE glob per run, so each chunk is its own glob.
CHUNKS=(
  'test/*.t.sol'                                         # top-level suites
  'test/{scenarios,deploy,fork,seaport,token}/*.t.sol'  # subdirectory suites
)
INVARIANTS_GLOB='test/invariants/*.t.sol'

# Bash-expanded equivalents of the chunk globs, used ONLY by the exhaustiveness
# guard. Keep these in lockstep with CHUNKS above.
shopt -s nullglob
COVER_GLOBS=(
  test/*.t.sol
  test/scenarios/*.t.sol test/deploy/*.t.sol
  test/fork/*.t.sol test/seaport/*.t.sol test/token/*.t.sol
)

# ── Exhaustiveness guard ─────────────────────────────────────────────────────
mapfile -t ALL < <(find test -name '*.t.sol' ! -path 'test/invariants/*' | sort -u)
declare -A COVERED=()
for f in "${COVER_GLOBS[@]}"; do COVERED["$f"]=1; done
MISSED=()
for f in "${ALL[@]}"; do [[ -n "${COVERED[$f]:-}" ]] || MISSED+=("$f"); done
if (( ${#MISSED[@]} > 0 )); then
  echo "ERROR: ${#MISSED[@]} test file(s) not covered by any chunk glob — add them to a chunk:" >&2
  printf '  %s\n' "${MISSED[@]}" >&2
  exit 1
fi
echo "exhaustiveness guard OK — ${#ALL[@]} non-invariant suites all covered by ${#CHUNKS[@]} chunks"

# ── Run each chunk ───────────────────────────────────────────────────────────
FAILED=0
i=0
for glob in "${CHUNKS[@]}"; do
  i=$((i+1))
  echo ""
  echo "===== CHUNK $i/${#CHUNKS[@]}: forge test --match-path '$glob' ====="
  if ! "${PREFIX[@]}" forge test --match-path "$glob"; then
    echo "CHUNK $i FAILED ($glob)" >&2
    FAILED=1
  fi
done

# ── Optional invariants pass ─────────────────────────────────────────────────
if [[ "${INCLUDE_INVARIANTS:-0}" == "1" || "${1:-}" == "--invariants" ]]; then
  echo ""
  echo "===== INVARIANTS: forge test --match-path '$INVARIANTS_GLOB' ====="
  if ! "${PREFIX[@]}" forge test --match-path "$INVARIANTS_GLOB"; then
    echo "INVARIANTS FAILED" >&2
    FAILED=1
  fi
fi

echo ""
if (( FAILED )); then
  echo "REGRESSION: FAILURES above ^^^" >&2
  exit 1
fi
echo "REGRESSION: all chunks green"
