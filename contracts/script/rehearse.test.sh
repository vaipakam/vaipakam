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
printf 'DEPLOYER_ADDRESS=0x3333333333333333333333333333333333333333\nADMIN_ADDRESS=0x4444444444444444444444444444444444444444\nDEPLOYER_PRIVATE_KEY=0xnotloaded\nBASE_SEPOLIA_RPC_URL=https://p.example/v2/SECRETKEY\nCCIP_ROUTER_BASE_SEPOLIA="0x00000000000000000000000000000000000000a0" # the router\n' > "$WORK/.env"

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
    RH_NODE=node RH_DEPLOY_SCRIPT="$WORK/deploy" RH_ENV_FILE="$WORK/.env" RH_READBACK="$WORK/bin/readback.mjs" \
    bash "$HERE/rehearse.sh" --plan "$WORK/plan-$name" --run "t-$name-$$" 2>&1)
  RC=$?
}
echo 'process.exit(0)' > "$WORK/bin/stub-ok.mjs"
# The readback stub records its arguments and fails on STUB_READBACK_FAIL.
cat > "$WORK/bin/readback.mjs" <<'S'
console.log(`ARGS ${process.argv.slice(2).join(' ')}`);
if (process.env.STUB_READBACK_FAIL) {
  console.log('not met    base-sepolia  launch.paused  expected false | found true');
  console.log('\n  2 rows: 1 met or info, 1 not met or unreadable');
  process.exit(1);
}
console.log('\n  2 rows: 2 met or info, 0 not met or unreadable');
S
echo '{"network":"testnet"}' > "$WORK/desired.json"
DESIRED_LINE="# desired $WORK/desired.json sha256 $(sha256sum "$WORK/desired.json" | cut -d' ' -f1)"

GOOD="$DESIRED_LINE"'
chains base-sepolia arb-sepolia
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
rb="$RUNDIR/logs/readback.log"
grep -q "ARGS $WORK/desired.json --records deployments/.forge-test/rehearsal/t-good-$$ --json $RUNDIR/readback.json --env-file $WORK/.env --rpc base-sepolia=http://127.0.0.1:1 --rpc arb-sepolia=http://127.0.0.1:2" "$rb" \
  && ok "the readback reads the plan's desired file, the scratch records and every fork" || bad "readback arguments: $(head -1 "$rb" 2>/dev/null)"
grep -q "2 rows: 2 met or info" "$RUNDIR/report.md" && ok "the report carries the readback's summary" || bad "no readback summary in the report"

drive rbfail "$GOOD" STUB_READBACK_FAIL=1
[ "$RC" -ne 0 ] && grep -q '"failedStage": "readback' "$RUNDIR/verdict.json" \
  && ok "a readback row not met fails the run" || bad "a failing readback passed: rc $RC"
echo "$OUT" | grep -q "launch.paused" && ok "the failing rows are shown" || bad "failing rows not shown"

drive nodesired $'chains base-sepolia\nstep base-sepolia preflight'
[ "$RC" -ne 0 ] && grep -q "the plan names no desired file" "$RUNDIR/verdict.json" "$RUNDIR/report.md" \
  && ok "a plan naming no desired file is not covered, never green" || bad "a plan without a desired file passed: rc $RC"

printf '%s\n' "$GOOD" > "$WORK/plan-moved"
echo '{"network":"testnet","changed":1}' > "$WORK/desired.json"
drive moved "$GOOD"
[ "$RC" -ne 0 ] && grep -q "changed since the plan was made" "$RUNDIR/verdict.json" \
  && ok "a desired file changed after the plan is refused" || bad "a changed desired file was read: rc $RC"
echo '{"network":"testnet"}' > "$WORK/desired.json"

drive fail "$GOOD" STUB_FAIL_PHASE=contracts
[ "$RC" -ne 0 ] && ok "a failing step fails the run" || bad "a failing step passed"
grep -q '"result": "fail"' "$RUNDIR/verdict.json" && ok "the verdict records the failure" || bad "no failing verdict"
grep -q "plan:4 base-sepolia contracts" "$RUNDIR/verdict.json" && ok "the failure names the plan line" || bad "failure not located: $(grep failedStage "$RUNDIR/verdict.json")"
[ ! -f "$RUNDIR/logs/004-arb-sepolia-contracts.log" ] && ok "no step runs after a failure" || bad "a later step ran"

made_markers=0
[ -d "$(dirname "$PROBE")" ] || { mkdir -p "$(dirname "$PROBE")"; made_markers=1; }
drive outside "$GOOD" STUB_WRITE_OUTSIDE="$PROBE"
[ "$RC" -ne 0 ] && ok "test 6: a write outside the scratch folder fails the run" || bad "a write outside the scratch passed"
echo "$OUT" | grep -q "added outside the scratch folder: contracts/deployments/base-sepolia/.markers/rehearse-test-probe" \
  && ok "the write is listed" || bad "the write was not listed"
rm -f "$PROBE"
[ "$made_markers" = 1 ] && rmdir "$(dirname "$PROBE")"

drive manual $'chains base-sepolia\nstep base-sepolia preflight\nmanual base-sepolia -- close the first reward day by hand'
[ "$RC" -ne 0 ] && ok "a manual step with no command fails the run" || bad "a manual step passed"
grep -q "not covered" "$RUNDIR/verdict.json" && ok "the verdict says the step is not covered" || bad "verdict: $(grep failedStage "$RUNDIR/verdict.json")"
grep -q "close the first reward day by hand" "$RUNDIR/report.md" && ok "the report lists the uncovered step" || bad "report misses the uncovered step"
[ -f "$RUNDIR/logs/001-base-sepolia-preflight.log" ] && ok "the steps before it still run" || bad "earlier steps did not run"

# The relay stub records each call; `report` prints a section, and
# STUB_RELAY_FAIL=<command> makes that command fail.
cat > "$WORK/bin/relay" <<'S'
#!/usr/bin/env bash
echo "RELAY $*"
[ "$1" = install ] && echo "ROUTER ${CCIP_ROUTER_BASE_SEPOLIA:-unset}"
[ "${STUB_RELAY_FAIL:-}" = "$1" ] && { echo "relay: $1 refused"; exit 1; }
[ "$1" = report ] && printf '## Cross-chain relay\n\nstub lanes\n'
exit 0
S
chmod +x "$WORK/bin/relay"
RELAY_PLAN="$DESIRED_LINE"$'\nchains base-sepolia arb-sepolia\nrelay base-sepolia arb-sepolia'
drive relay "$RELAY_PLAN" RH_RELAY="$WORK/bin/relay"
[ "$RC" -eq 0 ] && grep -q "RELAY install --state $RUNDIR/relay base-sepolia=http://127.0.0.1:1@0 arb-sepolia=http://127.0.0.1:2@0" "$RUNDIR/logs/relay-install.log" \
  && ok "the relay is installed once across every fork before the steps" || { bad "relay install: rc $RC $(head -1 "$RUNDIR/logs/relay-install.log" 2>/dev/null)"; echo "$OUT" | tail -5; }
grep -qx "ROUTER 0x00000000000000000000000000000000000000a0" "$RUNDIR/logs/relay-install.log" \
  && ok "the relay reads each router as the deploy's env reader set it (quoted, trailing comment)" || bad "router seen by the relay: $(grep ROUTER "$RUNDIR/logs/relay-install.log")"
grep -q "RELAY deliver --state $RUNDIR/relay base-sepolia arb-sepolia" "$RUNDIR/logs/001-relay-base-sepolia-arb-sepolia.log" \
  && ok "a relay step delivers from the saved relay" || bad "relay deliver: $(head -1 "$RUNDIR/logs/001-relay-base-sepolia-arb-sepolia.log" 2>/dev/null)"
grep -q "## Cross-chain relay" "$RUNDIR/report.md" && ! grep -q "the plan has no relay step" "$RUNDIR/report.md" \
  && ok "the report carries the relay's section" || bad "no relay section in the report"

drive relayinstall "$RELAY_PLAN" RH_RELAY="$WORK/bin/relay" STUB_RELAY_FAIL=install
[ "$RC" -ne 0 ] && grep -q '"failedStage": "steps (relay install)"' "$RUNDIR/verdict.json" \
  && ok "a relay install that fails stops the run" || bad "a failed relay install passed: rc $RC"
[ ! -f "$RUNDIR/logs/001-relay-base-sepolia-arb-sepolia.log" ] && ok "no relay step runs without the install" || bad "a relay step ran after a failed install"

drive relaydeliver "$RELAY_PLAN" RH_RELAY="$WORK/bin/relay" STUB_RELAY_FAIL=deliver
[ "$RC" -ne 0 ] && grep -q '"failedStage": "steps (plan:3 relay base-sepolia to arb-sepolia)"' "$RUNDIR/verdict.json" \
  && ok "a delivery that fails fails the step" || bad "a failed delivery passed: rc $RC $(grep failedStage "$RUNDIR/verdict.json")"

drive relayreport "$RELAY_PLAN" RH_RELAY="$WORK/bin/relay" STUB_RELAY_FAIL=report
[ "$RC" -ne 0 ] && grep -q '"failedStage": "steps (relay report)"' "$RUNDIR/verdict.json" \
  && ok "a relay report that cannot be written fails the run" || bad "a failed relay report passed: rc $RC"
grep -q "The relay report could not be written" "$RUNDIR/report.md" && ! grep -q "stub lanes" "$RUNDIR/report.md" \
  && ok "the report says the relay section is unavailable, never an older one" || bad "relay report failure not disclosed"

drive norelay "$GOOD" RH_RELAY="$WORK/bin/relay"
[ ! -f "$RUNDIR/logs/relay-install.log" ] && grep -q "the plan has no relay step" "$RUNDIR/report.md" \
  && ok "a plan with no relay step installs nothing and says so" || bad "relay installed for a plan without relay steps"

drive armed $'chains base-sepolia\nclock armed base-sepolia'
# The fake fork answers nothing, so the armed day cannot be read: the run
# stops at that line rather than moving the clock a guessed distance.
[ "$RC" -ne 0 ] && grep -q "plan:2 clock armed: base-sepolia has no launch timestamp or armed day\|plan:2 clock armed: no Diamond recorded on base-sepolia" "$RUNDIR/verdict.json" \
  && ok "clock armed reads the armed day from the chain; unreadable, the run stops there" || bad "clock armed unreadable: rc $RC $(grep failedStage "$RUNDIR/verdict.json")"

drive grace $'chains base-sepolia\nclock grace base-sepolia'
[ "$RC" -ne 0 ] && grep -q "plan:2 clock grace: base-sepolia's reward grace is unreadable\|plan:2 clock grace: no Diamond recorded on base-sepolia" "$RUNDIR/verdict.json" \
  && ok "clock grace reads the grace from the chain; unreadable, the run stops there" || bad "clock grace unreadable: rc $RC $(grep failedStage "$RUNDIR/verdict.json")"

drive cmdmark $'chains base-sepolia\ncmd base-sepolia -- echo reached'
[ "$RC" -ne 0 ] && ! grep -q "^reached" "$RUNDIR/logs/001-base-sepolia-cmd.log" \
  && ok "a hand step enters rehearsal mode first (a node without the marker is refused)" || bad "a hand step ran against a node without the marker"

for bad_plan in 'step base-sepolia preflight' \
  $'chains base-sepolia\nstep arb-sepolia preflight' \
  $'chains base-sepolia\nstep base-sepolia cf-app' \
  $'chains base-sepolia\nstep base-sepolia contracts --rehearse' \
  $'chains base-sepolia\nclock soon' \
  $'chains base-sepolia\nclock armed' \
  $'chains base-sepolia\nclock armed arb-sepolia' \
  $'chains base-sepolia\nclock armed base-sepolia extra' \
  $'chains base-sepolia\nclock grace' \
  $'chains base-sepolia\nclock grace arb-sepolia' \
  $'chains base-sepolia\nwhatever x' \
  $'chains base-sepolia\nrelay base-sepolia arb-sepolia' \
  $'chains base-sepolia\nmanual base-sepolia' \
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
