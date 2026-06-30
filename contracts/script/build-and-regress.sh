#!/usr/bin/env bash
#
# build-and-regress.sh — one entry point for "compile, then run every test
# suite" on this viaIR-stack-ceiling codebase, WITHOUT tripping the
# "Variable size is N too deep in the stack" whole-unit compile failure.
#
# Two stages:
#
#   [1] forge build --skip test
#         Compiles src/ + script/ ONLY (no test/). This is the safe build on
#         this repo — a bare `forge build` folds src + ALL test + ALL script
#         into one solc unit and trips the viaIR stack ceiling (Issue #601).
#         `--skip test` catches any src/ or script/ compile error up front and
#         warms the src cache so the test stage below doesn't re-pay it.
#
#   [2] run-regression.sh
#         Runs the full suite (minus invariants) in compile-bounded CHUNKS via
#         `forge test --match-path '{...}'`. `--match-path` (NOT
#         `--match-contract`) is what makes each chunk's COMPILATION sparse —
#         forge selects files by path before compiling, so the standalone
#         deploy scripts stay out of the unit and each chunk stays under the
#         ceiling. The chunk set is derived from `find` (auto-covers new
#         suites) and an exhaustiveness guard aborts if any *.t.sol is missed.
#
# WHY NOT `forge test --match-contract a|b|c`: that filters which tests RUN,
# but forge must still compile every test file to resolve those contract names,
# so the compilation unit stays whole and still trips the ceiling. It also
# needs a hand-maintained contract list that drifts as suites change. Use
# `--match-path` chunks (this script) instead.
#
# USAGE (from anywhere):
#   bash contracts/script/build-and-regress.sh              # build + full suite (no invariants)
#   bash contracts/script/build-and-regress.sh --invariants # ALSO run invariant suites
#   CHUNK_SIZE=20 bash contracts/script/build-and-regress.sh # smaller chunks if one trips
#
set -uo pipefail
cd "$(dirname "$0")/.."   # -> contracts/

export FOUNDRY_PROFILE=default
# IO-priority boost only (ionice). `nice -n -10` needs privileges sandboxes
# lack; a failing nice would abort the run, so it's intentionally omitted here.
PREFIX=(ionice -c 2 -n 0)

echo "===== [1/2] forge build --skip test (src/ + script/ compile) ====="
if ! "${PREFIX[@]}" forge build --skip test; then
  echo "BUILD FAILED — fix src/script compile errors before running tests." >&2
  exit 1
fi

echo "===== [2/2] chunked regression (run-regression.sh) ====="
exec bash "$(dirname "$0")/run-regression.sh" "$@"
