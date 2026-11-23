#!/usr/bin/env bash
__lenv_baseline="$(declare -p $(compgen -v) 2>/dev/null)"
# Cases for lib/rehearsal-gate.sh (#3896, deploy rehearsal design §8, §18 and
# §20 test 10): the deploy scripts' side of the rehearsal gate. Needs node and
# git; no network, no key. Run: bash contracts/script/lib/rehearsal-gate.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
RUN="$CONTRACTS_DIR/deployments/.forge-test/rehearsal/t-gate-$$"
trap 'rm -rf "$WORK" "$RUN"' EXIT

# shellcheck source=load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
# shellcheck source=rehearsal-gate.sh
source "$SCRIPT_DIR/lib/rehearsal-gate.sh"
fails=0
ok() { echo "ok    $1"; }
bad() { fails=$((fails + 1)); echo "FAIL  $1"; }

printf 'ADMIN_ADDRESS=0x4444444444444444444444444444444444444444\nADMIN_PRIVATE_KEY=0xsecret\nBASE_SEPOLIA_RPC_URL=https://p.example/v2/KEY\nCCIP_LANE_CHAIN_IDS=421614\n' > "$WORK/.env"

# ── test 10: one input digest for a rehearsal and a real run ──
# The rehearsal driver loads .env without the key variables and digests in
# its own shell; the deploy script loads it whole and captures right after.
rehearsal_digest=$( (load_env_file "$WORK/.env" --drop-key-vars >/dev/null 2>&1 \
  && node "$SCRIPT_DIR/rehearsal-inputs.mjs" digest "$WORK/.env") | sed -n 's/.*"inputDigest":"\([0-9a-f]*\)".*/\1/p')
real_digest=$( (load_env_file "$WORK/.env" >/dev/null 2>&1 && rehearsal_gate_capture_inputs "$WORK/.env" && echo "$REHEARSAL_GATE_INPUT_DIGEST"))
[ -n "$real_digest" ] && [ "$rehearsal_digest" = "$real_digest" ] \
  && ok "test 10: a rehearsal and a real run with the same .env have one input digest" || bad "input digests differ: $rehearsal_digest vs $real_digest"

load_env_file "$WORK/.env" >/dev/null 2>&1
rehearsal_gate_capture_inputs "$WORK/.env"
[[ "$REHEARSAL_GATE_INPUT_DIGEST" =~ ^[0-9a-f]{64}$ ]] && ok "the deploy captures the input digest after loading .env" || bad "no input digest captured"

# ── a plan and a verdict as the driver writes them ──
echo '{"network":"testnet"}' > "$WORK/desired.json"
printf '# desired %s sha256 %s\nchains base-sepolia arb-sepolia\nstep base-sepolia contracts --confirm-i-have-multisig-ready --fresh\n' \
  "$WORK/desired.json" "$(sha256sum "$WORK/desired.json" | cut -d' ' -f1)" > "$WORK/plan"
tree=$(node "$SCRIPT_DIR/rehearsal-tree.mjs" digest)
commit=$(printf '%s' "$tree" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
tdig=$(printf '%s' "$tree" | sed -n 's/.*"treeDigest":"\([0-9a-f]*\)".*/\1/p')
write_verdict() { # <input digest> <fork taken at>
  mkdir -p "$RUN"
  cat > "$RUN/verdict.json" <<JSON
{"kind":"vaipakam-deploy-rehearsal-verdict","version":1,"result":"pass","failedStage":"","network":"testnet",
 "commit":"$commit","treeDigest":"$tdig","inputDigest":"$1","planDigest":"$(sha256sum "$WORK/plan" | cut -d' ' -f1)",
 "chains":["base-sepolia","arb-sepolia"],"forks":[],"forkTakenAt":$2,"maxAgeHours":24,"createdAt":"x"}
JSON
}

reset() { REHEARSAL_GATE_PLAN=""; REHEARSAL_GATE_OVERRIDE_SET=0; REHEARSAL_GATE_OVERRIDE_REASON=""; REHEARSAL_GATE_RESULT=""; REHEARSE=0; }

# ── a rehearsal never runs the gate ──
reset; REHEARSE=1
rehearsal_gate_check testnet base-sepolia && [ -z "$REHEARSAL_GATE_RESULT" ] \
  && ok "a rehearsal run skips the gate (it is what makes the verdict)" || bad "the gate ran inside a rehearsal"

# ── a covering verdict passes; its record lands in the markers and history ──
reset; REHEARSAL_GATE_PLAN="$WORK/plan"
write_verdict "$REHEARSAL_GATE_INPUT_DIGEST" "$(date +%s)"
if rehearsal_gate_check testnet base-sepolia 2>"$WORK/err"; then
  ok "a green verdict of this tree, inputs and plan passes the gate"
else
  bad "a covering verdict was refused: $(cat "$WORK/err")"
fi
rehearsal_gate_record "$WORK/m" "$WORK/h"
grep -q '"gate":"passed"' "$WORK/m/rehearsal-gate.json" && ls "$WORK/h"/rehearsal-gate-*.json >/dev/null 2>&1 \
  && ok "the gate's record is written to the markers and the history record" || bad "no gate record"
echo stamp > "$WORK/m/phase-contracts.done"
rehearsal_gate_mark_phase "$WORK/m/phase-contracts.done"
[ "$(wc -l < "$WORK/m/phase-contracts.done")" -eq 1 ] && ok "a passed gate adds nothing to the phase marker" || bad "phase marker changed"

# ── other inputs are refused, and the refusal says why ──
reset; REHEARSAL_GATE_PLAN="$WORK/plan"
write_verdict "$(printf 'e%.0s' $(seq 64))" "$(date +%s)"
if rehearsal_gate_check testnet base-sepolia 2>"$WORK/err"; then
  bad "a verdict of other inputs passed"
else
  grep -q "inputDigest: rehearsed" "$WORK/err" && grep -q "local file" "$WORK/err" \
    && ok "a verdict of other inputs is refused, naming the input digest" || bad "refusal unclear: $(cat "$WORK/err")"
fi

# ── an old rehearsal is refused ──
reset; REHEARSAL_GATE_PLAN="$WORK/plan"
write_verdict "$REHEARSAL_GATE_INPUT_DIGEST" "$(( $(date +%s) - 25 * 3600 ))"
if rehearsal_gate_check testnet base-sepolia 2>"$WORK/err"; then bad "a 25-hour-old rehearsal passed"
else grep -q "hours old" "$WORK/err" && ok "a rehearsal forked 25 hours ago is refused" || bad "age refusal unclear"; fi

# ── the override needs a reason, and the reason is recorded ──
reset; REHEARSAL_GATE_OVERRIDE_SET=1; REHEARSAL_GATE_OVERRIDE_REASON=""
if rehearsal_gate_check testnet base-sepolia 2>"$WORK/err"; then bad "an override with no reason passed"
else ok "--without-rehearsal with no reason is refused"; fi
reset; REHEARSAL_GATE_OVERRIDE_SET=1; REHEARSAL_GATE_OVERRIDE_REASON="incident fix, forks unavailable"
rm -rf "$WORK/m" "$WORK/h"
if rehearsal_gate_check testnet base-sepolia 2>"$WORK/err"; then
  rehearsal_gate_record "$WORK/m" "$WORK/h"
  echo stamp > "$WORK/m/phase-contracts.done"
  rehearsal_gate_mark_phase "$WORK/m/phase-contracts.done"
  grep -q '"gate":"overridden"' "$WORK/m/rehearsal-gate.json" && grep -q '"reason":"incident fix, forks unavailable"' "$WORK/h"/rehearsal-gate-*.json \
    && grep -qx "without-rehearsal: incident fix, forks unavailable" "$WORK/m/phase-contracts.done" \
    && ok "an override's reason goes into the phase marker and the history record" || bad "override not recorded"
else
  bad "an override with a reason was refused: $(cat "$WORK/err")"
fi

# ── no input digest, no gate ──
reset; REHEARSAL_GATE_PLAN="$WORK/plan"; saved="$REHEARSAL_GATE_INPUT_DIGEST"; REHEARSAL_GATE_INPUT_DIGEST=""
if rehearsal_gate_check testnet base-sepolia 2>"$WORK/err"; then bad "the gate passed with no input digest"
else ok "with no input digest the gate refuses"; fi
REHEARSAL_GATE_INPUT_DIGEST="$saved"

echo
if [ "$fails" -gt 0 ]; then echo "$fails rehearsal gate case(s) failed." >&2; exit 1; fi
echo "All rehearsal gate cases pass."
