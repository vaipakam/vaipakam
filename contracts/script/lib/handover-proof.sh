#!/usr/bin/env bash
# handover-proof.sh — record and load what the handover gate proved (#945).
#
# `HandoverGate.s.sol` proves the live governance topology and prints, on
# lines of their own, the two values a launch binds its Timelock call to,
# both read in the state it proved:
#   HANDOVER_ROLE_EPOCH      the Diamond's role epoch (Codex #2686 r9)
#   HANDOVER_TIMELOCK_CALLS  the Timelock's executed-call count (r14)
# `Launch.s.sol` refuses a proposal once either has moved since the proof,
# and a production one without both.
#
# Every caller goes through these two functions, so the gate's own phase,
# the launch phase and the verify report read ONE record the same way
# (Codex #2686 r14: the verify report used to run without it). The record
# is one file holding both values, written atomically, so they cannot come
# from two different gate runs.
#
# Sourced by deploy-testnet.sh and deploy-mainnet.sh.

HANDOVER_PROOF_FILE="handover-gate.proof"

# clear_handover_proof <markers dir>
#   Removes the record. Called before the gate runs, so a gate that fails
#   leaves no proof from an earlier run behind for a launch to bind.
clear_handover_proof() {
  rm -f "$1/$HANDOVER_PROOF_FILE"
}

# record_handover_proof <gate log> <markers dir>
#   Reads both values from the gate's output and writes the record. Returns
#   1, with a message on stderr, when either line is missing.
record_handover_proof() {
  local log="$1" dir="$2" epoch calls
  epoch=$(sed -n 's/^ *HANDOVER_ROLE_EPOCH=\([0-9][0-9]*\) *$/\1/p' "$log" | tail -n 1)
  calls=$(sed -n 's/^ *HANDOVER_TIMELOCK_CALLS=\([0-9][0-9]*\) *$/\1/p' "$log" | tail -n 1)
  if [ -z "$epoch" ] || [ -z "$calls" ]; then
    echo "handover-gate: the gate passed but did not print both HANDOVER_ROLE_EPOCH and HANDOVER_TIMELOCK_CALLS; refusing to record a proof." >&2
    return 1
  fi
  local tmp="$dir/$HANDOVER_PROOF_FILE.tmp"
  printf 'HANDOVER_ROLE_EPOCH=%s\nHANDOVER_TIMELOCK_CALLS=%s\n' "$epoch" "$calls" > "$tmp"
  mv -f "$tmp" "$dir/$HANDOVER_PROOF_FILE"
}

# load_handover_proof <markers dir>
#   Exports HANDOVER_ROLE_EPOCH and HANDOVER_TIMELOCK_CALLS from the record.
#   Returns 1 when there is no record (nothing exported: the caller decides
#   whether that refuses), and 2, with a message on stderr, when the record
#   does not carry both values.
load_handover_proof() {
  local file="$1/$HANDOVER_PROOF_FILE" epoch calls
  [ -s "$file" ] || return 1
  epoch=$(sed -n 's/^HANDOVER_ROLE_EPOCH=\([0-9][0-9]*\)$/\1/p' "$file" | tail -n 1)
  calls=$(sed -n 's/^HANDOVER_TIMELOCK_CALLS=\([0-9][0-9]*\)$/\1/p' "$file" | tail -n 1)
  if [ -z "$epoch" ] || [ -z "$calls" ]; then
    echo "handover proof $file does not carry both values; re-run --phase handover-gate." >&2
    return 2
  fi
  export HANDOVER_ROLE_EPOCH="$epoch" HANDOVER_TIMELOCK_CALLS="$calls"
}
