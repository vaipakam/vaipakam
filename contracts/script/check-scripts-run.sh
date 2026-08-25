#!/usr/bin/env bash
# #1938 r11 — RUN each operator script's early path.
#
# `bash -n` parses; it cannot see an unset variable. I shipped
# `pause-all-chains.sh` with `__env_load_failed` uninitialised, so under
# `set -euo pipefail` it aborted with "unbound variable" in every mode —
# including the incident path — and `bash -n` reported it clean the whole time.
#
# This executes each script in a mode that returns quickly and asserts the run
# does not die on unbound state. It is not a functional test; it is the
# smallest check that would have caught what I shipped.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0

probe() {                      # $1 = label, rest = command
  local label="$1"; shift
  local out; out="$("$@" 2>&1 | head -40)"
  if printf '%s' "$out" | grep -q 'unbound variable'; then
    echo "  x $label — dies on unbound state" >&2
    printf '%s\n' "$out" | grep 'unbound variable' | head -2 >&2
    fail=1
  else
    echo "  ok $label"
  fi
}

probe "pause-all-chains.sh (calldata)"  bash "$SCRIPT_DIR/pause-all-chains.sh"
probe "pause-all-chains.sh (--check)"   bash "$SCRIPT_DIR/pause-all-chains.sh" --check
probe "pause-all-chains.sh (--unpause)" bash "$SCRIPT_DIR/pause-all-chains.sh" --unpause-calldata
probe "deploy-mainnet.sh (usage)"       bash "$SCRIPT_DIR/deploy-mainnet.sh"
probe "deploy-testnet.sh (usage)"       bash "$SCRIPT_DIR/deploy-testnet.sh"
probe "deploy-chain.sh (usage)"         bash "$SCRIPT_DIR/deploy-chain.sh"

exit "$fail"
