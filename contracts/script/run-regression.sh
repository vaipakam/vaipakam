#!/usr/bin/env bash
#
# run-regression.sh — local full-regression gate that COMPILES, where the naive
# `forge test --no-match-path "test/invariants/*"` currently does not.
#
# WHY: this codebase sits near the viaIR whole-unit stack ceiling. The naive
# command is NON-sparse — it compiles `src` + ALL `test` + ALL `script` in one
# `solc` unit, and the standalone deploy scripts under `script/*.s.sol` push
# that unit over the edge, failing with "Variable size is N too deep in the
# stack" even though every test is correct (Issue #601; surfaced in #603/#596).
#
# THE FIX (no batching needed): drive the run with `--match-path`, which makes
# Foundry compile SPARSELY — only the matched files + their dependency closure.
# `test/*.t.sol` recursively matches every test file under `test/` (globset's
# `*` crosses `/`; see contracts/foundry.toml), so its dep closure is
# `src` + all tests + only the scripts that tests actually import (e.g.
# DeployDiamond.s.sol via DeployDiamondIntegrationTest). The standalone deploy
# scripts that nothing imports are NOT compiled — and dropping that slice of IR
# keeps the unit under the ceiling. `--no-match-path 'test/invariants/*'` then
# drops the heavy invariant suites from the RUN (they stay matched/compiled but
# don't execute), matching the project's end-of-step regression scope.
#
# CANNOT MISS A SUITE: the recursive `test/*.t.sol` glob matches every current
# AND future `*.t.sol` anywhere under `test/`, so a newly-added suite is picked
# up automatically — there is no chunk list, folder layout, or allowlist to keep
# in sync. (The standalone scripts' compile-correctness is covered separately by
# `forge build` / predeploy-check, not by this test regression.)
#
# Forces FOUNDRY_PROFILE=default so a stray `quick`/`cifast` in the caller's env
# can't silently empty test discovery or narrow the suite and still report green.
#
# USAGE:
#   bash script/run-regression.sh              # full suite minus invariants
#   bash script/run-regression.sh --invariants # ALSO run the invariant suites
#   bash script/run-regression.sh -vvv         # extra args pass through to forge

set -uo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

export FOUNDRY_PROFILE=default
PREFIX=(ionice -c 2 -n 0)

RUN_INVARIANTS=0
FORGE_ARGS=()
for a in "$@"; do
  case "$a" in
    --invariants) RUN_INVARIANTS=1 ;;
    *) FORGE_ARGS+=("$a") ;;
  esac
done

FAILED=0

echo "===== full regression (non-invariant, sparse compile) ====="
if ! "${PREFIX[@]}" forge test --match-path 'test/*.t.sol' \
       --no-match-path 'test/invariants/*' "${FORGE_ARGS[@]}"; then
  FAILED=1
fi

if (( RUN_INVARIANTS )); then
  echo ""
  echo "===== invariant suites ====="
  if ! "${PREFIX[@]}" forge test --match-path 'test/invariants/*' "${FORGE_ARGS[@]}"; then
    FAILED=1
  fi
fi

echo ""
if (( FAILED )); then
  echo "REGRESSION: FAILURES above ^^^" >&2
  exit 1
fi
echo "REGRESSION: green"
