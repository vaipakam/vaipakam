#!/usr/bin/env bash
# rehearse.test.sh — the deploy rehearsal driver's plan and stages, with stub
# commands (#3891, deploy rehearsal design §20 tests 6 and 11). No node, no
# network, no key: forge, the pre-deploy check, the layout guard and the deploy
# script are stubs, and the forks are fake URLs (RH_SKIP_FORKS=1).
# Run (from anywhere): bash contracts/script/rehearse.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
RUNS=()
PROBE="$CONTRACTS_DIR/deployments/base-sepolia/.markers/rehearse-test-probe-$$"
cleanup() {
  rm -rf "$WORK" "$PROBE"
  local r
  for r in "${RUNS[@]+"${RUNS[@]}"}"; do rm -rf "$CONTRACTS_DIR/deployments/.forge-test/rehearsal/$r"; done
}
trap cleanup EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/stub-ok" <<'S'
#!/usr/bin/env bash
exit 0
S
# The deploy-script stub records its arguments and the rehearsal env it saw,
# writes a record inside the scratch folder, and obeys STUB_* switches.
cat > "$WORK/deploy" <<'S'
#!/usr/bin/env bash
echo "ARGS $*"
echo "ROOT $VAIPAKAM_REHEARSAL_ROOT"
echo "RPC $VAIPAKAM_REHEARSAL_RPC_URL"
echo "KEY ${DEPLOYER_PRIVATE_KEY:-unset}"
mkdir -p "contracts/$VAIPAKAM_REHEARSAL_ROOT/$1"
echo "{}" > "contracts/$VAIPAKAM_REHEARSAL_ROOT/$1/$3.json"
[ -n "${STUB_FAIL_PHASE:-}" ] && [ "$3" = "$STUB_FAIL_PHASE" ] && { echo "phase failed"; exit 7; }
[ -n "${STUB_WRITE_OUTSIDE:-}" ] && echo x > "$STUB_WRITE_OUTSIDE"
exit 0
S
chmod +x "$WORK/bin/stub-ok" "$WORK/deploy"
printf 'DEPLOYER_ADDRESS=0x3333333333333333333333333333333333333333\nADMIN_ADDRESS=0x4444444444444444444444444444444444444444\nDEPLOYER_PRIVATE_KEY=0xnotloaded\nBASE_SEPOLIA_RPC_URL=https://p.example/v2/SECRETKEY\n' > "$WORK/.env"

fails=0
ok() { echo "ok    $1"; }
bad() { fails=$((fails + 1)); echo "FAIL  $1"; }

# drive NAME PLAN_TEXT [ENV...] — runs the driver; sets RC, OUT and RUNDIR.
drive() {
  local name="$1" plan="$2"
  shift 2
  printf '%s\n' "$plan" > "$WORK/plan-$name"
  RUNS+=("t-$name-$$")
  RUNDIR="$CONTRACTS_DIR/deployments/.forge-test/rehearsal/t-$name-$$"
  OUT=$(env "$@" RH_SKIP_FORKS=1 RH_FAKE_FORKS="base-sepolia=http://127.0.0.1:1 arb-sepolia=http://127.0.0.1:2" \
    RH_FORGE="$WORK/bin/stub-ok" RH_PREDEPLOY="$WORK/bin/stub-ok" RH_LAYOUT_GUARD="$WORK/bin/stub-ok.mjs" \
    RH_NODE=node RH_DEPLOY_SCRIPT="$WORK/deploy" RH_ENV_FILE="$WORK/.env" \
    bash "$HERE/rehearse.sh" --plan "$WORK/plan-$name" --run "t-$name-$$" 2>&1)
  RC=$?
}
echo 'process.exit(0)' > "$WORK/bin/stub-ok.mjs"

GOOD='chains base-sepolia arb-sepolia
step base-sepolia preflight
step base-sepolia contracts --confirm-i-have-multisig-ready
step arb-sepolia contracts --confirm-i-have-multisig-ready
step base-sepolia ccip-wire'

drive good "$GOOD"
[ "$RC" -eq 0 ] && ok "a good plan passes" || { bad "a good plan failed (rc $RC)"; echo "$OUT" | tail -20; }
[ -f "$RUNDIR/verdict.json" ] && ok "a verdict is written" || bad "no verdict"
if node -e '
  const v = require(process.argv[1]);
  const ok = v.result === "pass" && /^[0-9a-f]{64}$/.test(v.treeDigest) && /^[0-9a-f]{64}$/.test(v.inputDigest)
    && /^[0-9a-f]{64}$/.test(v.planDigest) && /^[0-9a-f]{40}$/.test(v.commit) && v.chains.join() === "base-sepolia,arb-sepolia";
  process.exit(ok ? 0 : 1);' "$RUNDIR/verdict.json"; then
  ok "the verdict carries the commit, the three digests and the chain set"
else
  bad "the verdict is incomplete: $(cat "$RUNDIR/verdict.json" 2>/dev/null)"
fi
log1="$RUNDIR/logs/002-base-sepolia-contracts.log"
grep -q "ARGS base-sepolia --phase contracts --confirm-i-have-multisig-ready --rehearse" "$log1" && ok "each step runs the deploy phase with --rehearse" || bad "step arguments: $(head -2 "$log1")"
grep -q "RPC http://127.0.0.1:1" "$log1" && ok "each step reaches its own chain's fork" || bad "wrong fork"
grep -q "KEY unset" "$log1" && ok "no key reaches a step" || bad "a key reached the step"
grep -q "ROOT deployments/.forge-test/rehearsal/t-good-$$" "$log1" && ok "each step gets the run's scratch root" || bad "wrong root"
[ -f "$RUNDIR/base-sepolia/contracts.json" ] && ok "a step writes inside the scratch folder" || bad "no scratch write"
if grep -rq SECRETKEY "$RUNDIR" 2>/dev/null; then bad "an RPC value reached the run folder"; else ok "no RPC value reaches the logs, report or verdict"; fi
d1=$(node -e 'console.log(require(process.argv[1]).planDigest)' "$RUNDIR/verdict.json")

drive fail "$GOOD" STUB_FAIL_PHASE=contracts
[ "$RC" -ne 0 ] && ok "a failing step fails the run" || bad "a failing step passed"
grep -q '"result": "fail"' "$RUNDIR/verdict.json" && ok "the verdict records the failure" || bad "no failing verdict"
grep -q "plan:3 base-sepolia contracts" "$RUNDIR/verdict.json" && ok "the failure names the plan line" || bad "failure not located: $(grep failedStage "$RUNDIR/verdict.json")"
[ ! -f "$RUNDIR/logs/004-arb-sepolia-contracts.log" ] && ok "no step runs after a failure" || bad "a later step ran"

made_markers=0
[ -d "$(dirname "$PROBE")" ] || { mkdir -p "$(dirname "$PROBE")"; made_markers=1; }
drive outside "$GOOD" STUB_WRITE_OUTSIDE="$PROBE"
[ "$RC" -ne 0 ] && ok "test 6: a write outside the scratch folder fails the run" || bad "a write outside the scratch passed"
echo "$OUT" | grep -q "added outside the scratch folder: contracts/deployments/base-sepolia/.markers/rehearse-test-probe" \
  && ok "the write is listed" || bad "the write was not listed"
rm -f "$PROBE"
[ "$made_markers" = 1 ] && rmdir "$(dirname "$PROBE")"

for bad_plan in 'step base-sepolia preflight' \
  $'chains base-sepolia\nstep arb-sepolia preflight' \
  $'chains base-sepolia\nstep base-sepolia cf-app' \
  $'chains base-sepolia\nstep base-sepolia contracts --rehearse' \
  $'chains base-sepolia\nclock soon' \
  $'chains base-sepolia\nwhatever x' \
  $'chains base'; do
  drive plan "$bad_plan"
  if [ "$RC" -ne 0 ] && grep -q '"failedStage": "plan"' "$RUNDIR/verdict.json" 2>/dev/null; then
    ok "plan refused: $(printf '%s' "$bad_plan" | tr '\n' ';')"
  else
    bad "plan accepted: $(printf '%s' "$bad_plan" | tr '\n' ';') (rc $RC)"
  fi
done

drive good2 "$GOOD"
d2=$(node -e 'console.log(require(process.argv[1]).planDigest)' "$RUNDIR/verdict.json")
[ "$d1" = "$d2" ] && ok "one plan, one digest" || bad "the plan digest moved"
drive other $'chains base-sepolia\nstep base-sepolia preflight'
d3=$(node -e 'console.log(require(process.argv[1]).planDigest)' "$RUNDIR/verdict.json")
[ "$d1" != "$d3" ] && ok "another plan, another digest" || bad "two plans share a digest"

echo
if [ "$fails" -gt 0 ]; then echo "$fails driver case(s) failed." >&2; exit 1; fi
echo "All driver cases pass."
