# shellcheck shell=bash
# ── The rehearsal gate on a real fresh deploy (#3896) ─────────────────────
#
# Deploy rehearsal design sections 8 and 18. The first broadcasting step of a
# fresh deploy (the contracts phase with --fresh, or the first deploy on a
# chain with no Diamond recorded) refuses unless a green rehearsal verdict
# covers it: the same commit, tree digest, input digest, plan digest, network
# and chain set, with forks taken less than 24 hours ago. The comparison is
# `rehearsal-gate.mjs`; this file is the deploy scripts' side of it.
#
# Used by deploy-testnet.sh and deploy-mainnet.sh, in this order:
#
#   rehearsal_gate_capture_inputs <env-file>
#       Right after `load_env_file`, before the script derives or exports
#       anything: the input digest worked out at the point the rehearsal
#       driver works out its own, so the two compare equal for equal inputs.
#   the argument loop sets REHEARSAL_GATE_PLAN from `--plan <file>`, and
#       REHEARSAL_GATE_OVERRIDE_SET=1 / REHEARSAL_GATE_OVERRIDE_REASON from
#       `--without-rehearsal <reason>`.
#   rehearsal_gate_check <network> <chain>
#       At the top of the contracts phase of a fresh deploy, in a real run.
#       Refuses (returns 1) or sets REHEARSAL_GATE_RESULT to one JSON line.
#   rehearsal_gate_record <markers-dir> <history-dir>
#       Once the phase's own archive has run: writes that line into the
#       chain's markers and its history record.
#   rehearsal_gate_mark_phase <phase-marker-file>
#       After the phase marker is written: an override's reason is appended
#       to it.
#   rehearsal_gate_source_value <markers-dir>
#       The value written as `rehearsalGate` in deployment_source.json: this
#       run's result, or, when this run did not check (a resume past the
#       Diamond step, a rerun on a recorded Diamond), the record the gate
#       left in the markers when that Diamond was deployed, so a later run
#       never erases it. `null` when there is neither.
#
# A rehearsal (REHEARSE=1) is what produces a verdict, so it never runs the
# gate. The verdict is a local file: the gate guards against mistakes, and
# its refusal says it does not guard against someone who means to skip it.

REHEARSAL_GATE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REHEARSAL_GATE_INPUT_DIGEST=""
REHEARSAL_GATE_PLAN=""
REHEARSAL_GATE_OVERRIDE_SET=0
REHEARSAL_GATE_OVERRIDE_REASON=""
REHEARSAL_GATE_RESULT=""

rehearsal_gate_capture_inputs() {
  local out
  out=$(node "$REHEARSAL_GATE_LIB_DIR/../rehearsal-inputs.mjs" digest "$1" 2>/dev/null) || out=""
  REHEARSAL_GATE_INPUT_DIGEST=$(printf '%s' "$out" | sed -n 's/.*"inputDigest":"\([0-9a-f]\{64\}\)".*/\1/p')
}

rehearsal_gate_check() {
  local network="$1" chain="$2" args
  if [ "${REHEARSE:-0}" = 1 ]; then return 0; fi
  if [ -z "$REHEARSAL_GATE_INPUT_DIGEST" ]; then
    echo "  ✗ rehearsal gate: the input digest could not be worked out from .env (node and script/rehearsal-inputs.mjs are needed)" >&2
    return 1
  fi
  args=(check --network "$network" --chain "$chain" --input-digest "$REHEARSAL_GATE_INPUT_DIGEST")
  [ -n "$REHEARSAL_GATE_PLAN" ] && args+=(--plan "$REHEARSAL_GATE_PLAN")
  [ "$REHEARSAL_GATE_OVERRIDE_SET" = 1 ] && args+=(--without-rehearsal "$REHEARSAL_GATE_OVERRIDE_REASON")
  REHEARSAL_GATE_RESULT=$(node "$REHEARSAL_GATE_LIB_DIR/../rehearsal-gate.mjs" "${args[@]}") || return 1
  [ -n "$REHEARSAL_GATE_RESULT" ]
}

rehearsal_gate_record() {
  local markers="$1" history="$2"
  [ -n "$REHEARSAL_GATE_RESULT" ] || return 0
  mkdir -p "$markers" "$history"
  printf '%s\n' "$REHEARSAL_GATE_RESULT" > "$markers/rehearsal-gate.json"
  printf '%s\n' "$REHEARSAL_GATE_RESULT" > "$history/rehearsal-gate-$(date +%s).json"
}

rehearsal_gate_mark_phase() {
  [ "$REHEARSAL_GATE_OVERRIDE_SET" = 1 ] && [ -n "$REHEARSAL_GATE_RESULT" ] || return 0
  printf 'without-rehearsal: %s\n' "$REHEARSAL_GATE_OVERRIDE_REASON" >> "$1"
}

rehearsal_gate_source_value() {
  local f="$1/rehearsal-gate.json"
  if [ -n "$REHEARSAL_GATE_RESULT" ]; then printf '%s' "$REHEARSAL_GATE_RESULT"; return; fi
  if [ -f "$f" ] && jq -ce . "$f" >/dev/null 2>&1; then jq -ce . "$f"; return; fi
  printf 'null'
}
