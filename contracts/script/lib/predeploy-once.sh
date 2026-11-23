# shellcheck shell=bash
# ── The pre-deploy check, once per tree (#3896) ───────────────────────────
#
# Deploy rehearsal design §18 ("Tree digest") and hardening lesson 10: the
# pre-deploy check reads a property of the tree, not of a chain. A passing run
# of `predeploy-check.sh` records its verdict against the tree digest
# (`predeploy-verdict.mjs`); this helper reuses that verdict for the default
# check when it covers the present tree and the present context (forge
# version, FOUNDRY_* settings), and runs the check otherwise. The full check
# (`--full`, mainnet) always runs. A tree changed in any tracked or untracked file has
# another digest, so an edit always runs the check again.
#
#   predeploy_check_once [--full]
#       Runs the repository's predeploy-check.sh once per tree and returns its
#       status. With STORAGE_LAYOUT_BASE set it always runs the check, since
#       the baseline it compares against is not part of the tree digest.
#   predeploy_check_once_with <script> [--full]
#       The same with the script named as an argument: only the rehearsal
#       driver uses it (its tests pass a stand-in). The script is never read
#       from the environment, so no deploy env file can choose what runs as
#       the check.

PREDEPLOY_ONCE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

predeploy_check_once() {
  predeploy_check_once_with "$PREDEPLOY_ONCE_LIB_DIR/../predeploy-check.sh" "$@"
}

predeploy_check_once_with() {
  local mode=default found script="$1"
  shift
  [ "${1:-}" = "--full" ] && mode=full
  # Never answered from a verdict: the full check (its live-fork suites read
  # chains and deployment records outside the tree), and a requested
  # storage-layout baseline comparison (the baseline file is outside it too).
  if [ "$mode" = full ] || [ -n "${STORAGE_LAYOUT_BASE:-}" ]; then bash "$script" "$@"; return; fi
  if found=$(node "$PREDEPLOY_ONCE_LIB_DIR/../predeploy-verdict.mjs" covers --mode "$mode" 2>/dev/null); then
    echo "  ✓ the pre-deploy check already passed for this tree ($mode): $found"
    return 0
  fi
  bash "$script" "$@"
}
