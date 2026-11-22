#!/usr/bin/env bash
# FIRST statement, before ANY assignment (lib/load-env.sh compares against it).
__lenv_baseline="$(declare -p $(compgen -v) 2>/dev/null)"
#
# rehearse.sh — the deploy rehearsal driver (#3891, deploy rehearsal design
# §4, §11-§14, §18).
#
# Runs the REAL deploy plan, step by step, against local forks of the target
# chains, with no key, and writes a report and a verdict. It contains no deploy
# logic: every on-chain step is the deploy script's own phase, run with
# `--rehearse`.
#
# Usage (from contracts/):
#   bash script/rehearse.sh --plan <plan-file> [--network testnet|mainnet]
#                           [--run <name>] [--port-base <n>]
#
# The plan is a text file, one step per line (`#` starts a comment):
#
#   chains base-sepolia arb-sepolia       the chains to fork (first line)
#   step <chain> <phase> [flags...]       a deploy-script phase on that chain
#   clock +<seconds> | clock @<unix>      move every fork to one time
#   cmd <chain> -- <command...>           a hand step, as its exact command
#                                         text, run in the chain's rehearsal
#                                         environment
#   manual <chain> -- <what>              a step with no command yet: reported
#                                         as not covered; the run stops there
#                                         and the verdict is never green
#   relay <from> <to>                     deliver pending cross-chain messages
#                                         (RH_RELAY; not covered without it)
#
# The plan comes from the desired-state file (#3111), never typed by hand:
#   node script/deploy-plan.mjs plan deployments/testnets.desired.json \
#     --anchor today --env-file .env > /tmp/plan.txt
# The plan's digest is part of the verdict, and the plan's first line carries
# the desired file's hash, so the digest covers the file too.
#
# Stages, in order. Any failure stops the run, writes the report and a
# failing verdict, and stops the forks:
#   1. plan      parse and check the plan; its digest
#   2. build     the one build every step reuses (same profile and flags), the
#                storage-layout guard's build, and the pre-deploy check, once
#                for this tree
#   3. snapshot  every file in the working tree by path and content hash
#   4. forks     one fork per chain (lib/rehearsal-forks.sh), marker placed,
#                role addresses impersonated, one clock
#   5. records   the committed records copied into the run's scratch folder
#   6. steps     the plan, each step's output redacted into the run's logs
#   7. compare   nothing outside the scratch folder changed
#   8. verdict   commit, tree digest, input digest, plan digest, chain set,
#                fork blocks and time; the report lists the limits
#
# The relay between forks (#3892), the readback (#3893) and the off-chain
# runners (#3894, #3895) join as stages when they land; until then the report
# names each as not run.
#
# Testable with stubs (rehearse.test.sh): every external command is reached
# through a variable (RH_FORGE, RH_NODE, RH_DEPLOY_SCRIPT, RH_PREDEPLOY, …),
# and RH_SKIP_FORKS=1 replaces the forks with the URLs in RH_FAKE_FORKS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CONTRACTS_DIR/.." && pwd)"
# shellcheck source=lib/load-env.sh
source "$SCRIPT_DIR/lib/load-env.sh"
# shellcheck source=lib/rehearsal-forks.sh
source "$SCRIPT_DIR/lib/rehearsal-forks.sh"

RH_FORGE="${RH_FORGE:-forge}"
RH_NODE="${RH_NODE:-node}"
RH_PREDEPLOY="${RH_PREDEPLOY:-$SCRIPT_DIR/predeploy-check.sh}"
RH_LAYOUT_GUARD="${RH_LAYOUT_GUARD:-$SCRIPT_DIR/storage-layout-guard.mjs}"
RH_ENV_FILE="${RH_ENV_FILE:-$CONTRACTS_DIR/.env}"
RH_MAX_VERDICT_AGE_HOURS="${RH_MAX_VERDICT_AGE_HOURS:-24}"

PLAN=""
NETWORK="testnet"
RUN_NAME="run-$(date -u +%Y%m%dT%H%M%SZ)"
PORT_BASE=18645
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) PLAN="$2"; shift ;;
    --network) NETWORK="$2"; shift ;;
    --run) RUN_NAME="$2"; shift ;;
    --port-base) PORT_BASE="$2"; shift ;;
    -h | --help) sed -n '5,50p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$PLAN" ] || { echo "Error: --plan <file> is required" >&2; exit 2; }
[ -f "$PLAN" ] || { echo "Error: plan $PLAN not found" >&2; exit 2; }
case "$NETWORK" in
  testnet) RH_DEPLOY_SCRIPT="${RH_DEPLOY_SCRIPT:-$SCRIPT_DIR/deploy-testnet.sh}" ;;
  mainnet) RH_DEPLOY_SCRIPT="${RH_DEPLOY_SCRIPT:-$SCRIPT_DIR/deploy-mainnet.sh}" ;;
  *) echo "Error: --network is testnet or mainnet" >&2; exit 2 ;;
esac
case "$RUN_NAME" in '' | *[!A-Za-z0-9._-]*) echo "Error: --run takes letters, digits, '.', '_' and '-'" >&2; exit 2 ;; esac

export VAIPAKAM_REHEARSAL_ROOT="deployments/.forge-test/rehearsal/$RUN_NAME"
SCRATCH="$CONTRACTS_DIR/$VAIPAKAM_REHEARSAL_ROOT"
LOGS="$SCRATCH/logs"
if [ -e "$SCRATCH" ]; then
  echo "Error: $VAIPAKAM_REHEARSAL_ROOT already exists; choose another --run" >&2
  exit 2
fi
mkdir -p "$LOGS"

# ── The chain registry: slug → chain id and the RPC variable to fork from.
# The same table as the deploy scripts' (deploy-testnet.sh, deploy-mainnet.sh).
chain_of() {
  case "$1" in
    base-sepolia) echo "84532 BASE_SEPOLIA_RPC_URL testnet" ;;
    sepolia) echo "11155111 SEPOLIA_RPC_URL testnet" ;;
    arb-sepolia) echo "421614 ARB_SEPOLIA_RPC_URL testnet" ;;
    op-sepolia) echo "11155420 OP_SEPOLIA_RPC_URL testnet" ;;
    bnb-testnet) echo "97 BNB_TESTNET_RPC_URL testnet" ;;
    polygon-amoy) echo "80002 POLYGON_AMOY_RPC_URL testnet" ;;
    ethereum) echo "1 ETHEREUM_RPC_URL mainnet" ;;
    base) echo "8453 BASE_RPC_URL mainnet" ;;
    arbitrum) echo "42161 ARBITRUM_RPC_URL mainnet" ;;
    optimism) echo "10 OPTIMISM_RPC_URL mainnet" ;;
    polygon) echo "137 POLYGON_RPC_URL mainnet" ;;
    *) return 1 ;;
  esac
}

RESULT="fail"
FAILED_STAGE=""
STAGES_RUN=()
declare -A FORK_URL FORK_BLOCK
CHAINS=()
STEP_LINES=()
UNCOVERED=()

log() { printf '%s\n' "$*" | rh_redact | tee -a "$LOGS/driver.log"; }

finish() {
  local rc=$?
  set +e
  [ "$rc" -ne 0 ] && [ -z "$FAILED_STAGE" ] && FAILED_STAGE="${CURRENT_STAGE:-unknown}"
  write_report_and_verdict
  rh_fork_stop_all
  if [ "$RESULT" = pass ]; then
    log "✓ rehearsal passed — verdict at $VAIPAKAM_REHEARSAL_ROOT/verdict.json"
  else
    log "✗ rehearsal FAILED at stage: ${FAILED_STAGE:-unknown} — report at $VAIPAKAM_REHEARSAL_ROOT/report.md"
  fi
  exit "$([ "$RESULT" = pass ] && echo 0 || echo 1)"
}
trap finish EXIT

stage() {
  CURRENT_STAGE="$1"
  STAGES_RUN+=("$1")
  log ""
  log "── stage: $1"
}

# ── The report and the verdict, written on every exit ─────────────────
# The verdict is what the real deploy's gate (#3896) compares: the commit and
# tree digest, the input digest, the plan digest, the chain set, and when the
# forks were taken. The report is for a person, redacted like every log.
write_report_and_verdict() {
  local commit tree_digest input_digest chains_json forks_json created
  created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  commit=$(printf '%s' "${TREE_JSON:-}" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
  tree_digest=$(printf '%s' "${TREE_JSON:-}" | sed -n 's/.*"treeDigest":"\([0-9a-f]*\)".*/\1/p')
  input_digest=$(printf '%s' "${INPUT_JSON:-}" | sed -n 's/.*"inputDigest":"\([0-9a-f]*\)".*/\1/p')
  chains_json=$(printf '"%s",' "${CHAINS[@]+"${CHAINS[@]}"}"); chains_json="[${chains_json%,}]"
  [ "$chains_json" = '[""]' ] && chains_json='[]'
  forks_json=""
  local c
  for c in "${CHAINS[@]+"${CHAINS[@]}"}"; do
    forks_json+=$(printf '{"chain":"%s","forkBlock":%s},' "$c" "${FORK_BLOCK[$c]:-null}")
  done
  forks_json="[${forks_json%,}]"
  cat > "$SCRATCH/verdict.json" <<JSON
{
  "kind": "vaipakam-deploy-rehearsal-verdict",
  "version": 1,
  "result": "$RESULT",
  "failedStage": "${FAILED_STAGE}",
  "network": "$NETWORK",
  "commit": "${commit}",
  "treeDigest": "${tree_digest}",
  "inputDigest": "${input_digest}",
  "planDigest": "${PLAN_DIGEST:-}",
  "chains": $chains_json,
  "forks": $forks_json,
  "forkTakenAt": ${FORK_TIME:-null},
  "maxAgeHours": $RH_MAX_VERDICT_AGE_HOURS,
  "createdAt": "$created"
}
JSON
  {
    echo "# Deploy rehearsal report"
    echo
    echo "- Result: **$RESULT**${FAILED_STAGE:+ (failed at: $FAILED_STAGE)}"
    echo "- Run: \`$VAIPAKAM_REHEARSAL_ROOT\`, $created"
    echo "- Network: $NETWORK; chains: ${CHAINS[*]+"${CHAINS[*]}"}"
    echo "- Commit: ${commit:-not reached}; tree digest: ${tree_digest:-not reached}"
    echo "- Input digest: ${input_digest:-not reached}; plan digest: ${PLAN_DIGEST:-not reached}"
    echo "- Stages run: ${STAGES_RUN[*]+"${STAGES_RUN[*]}"}"
    echo
    echo "## Forks"
    for c in "${CHAINS[@]+"${CHAINS[@]}"}"; do echo "- $c: forked at block ${FORK_BLOCK[$c]:-not started}"; done
    echo
    if [ "${#UNCOVERED[@]}" -gt 0 ]; then
      echo "## Not covered (the verdict cannot be green while any remain)"
      for u in "${UNCOVERED[@]}"; do echo "- $u"; done
      echo
    fi
    echo "## Not run in this rehearsal"
    [ -n "${RH_RELAY:-}" ] || echo "- The relay between forks (#3892): cross-chain messages are not delivered."
    echo "- The readback against the desired state (#3893)."
    echo "- The indexer, keeper and app against the forks, and the smoke flows (#3894, #3895, #3896)."
    echo
    echo "## Limits (design section 10)"
    echo "- A fork is one chain's state at one block: real sequencers, mempools, gas markets and outside actors are absent."
    echo "- Arbitrum's block.number on a fork follows the fork, not the L1 block number the real chain reports."
    echo "- Price feeds are not re-stamped after a clock step yet (open item 4): a step past a feed's maximum age reads it as stale."
    echo "- Role addresses are impersonated: the rehearsal proves the deploy as those addresses, and the real run proves its keys give them."
    echo
    echo "## Logs"
    echo "\`$VAIPAKAM_REHEARSAL_ROOT/logs/\`"
  } > "$SCRATCH/report.md"
}

# ── 1. plan ────────────────────────────────────────────────────────────
stage plan
PLAN_DIGEST=$(sha256sum "$PLAN" | cut -d' ' -f1)
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "$line" ] || continue
  read -r -a words <<<"$line"
  case "${words[0]}" in
    chains)
      [ "${#CHAINS[@]}" -eq 0 ] || { log "✗ plan:$lineno: a second chains line"; exit 1; }
      for c in "${words[@]:1}"; do
        info=$(chain_of "$c") || { log "✗ plan:$lineno: unknown chain $c"; exit 1; }
        [ "${info##* }" = "$NETWORK" ] || { log "✗ plan:$lineno: $c is not a $NETWORK chain"; exit 1; }
        CHAINS+=("$c")
      done
      ;;
    step)
      [ "${#words[@]}" -ge 3 ] || { log "✗ plan:$lineno: step needs a chain and a phase"; exit 1; }
      case "${words[2]}" in cf-*) log "✗ plan:$lineno: ${words[2]} publishes to Cloudflare and is never rehearsed"; exit 1 ;; esac
      for w in "${words[@]:3}"; do [ "$w" = "--rehearse" ] && { log "✗ plan:$lineno: the driver adds --rehearse itself"; exit 1; }; done
      STEP_LINES+=("$lineno|$line")
      ;;
    clock)
      [[ "${words[1]:-}" =~ ^[+@][0-9]+$ ]] || { log "✗ plan:$lineno: clock takes +<seconds> or @<unix>"; exit 1; }
      STEP_LINES+=("$lineno|$line")
      ;;
    cmd)
      [ "${words[2]:-}" = "--" ] && [ "${#words[@]}" -ge 4 ] || { log "✗ plan:$lineno: cmd <chain> -- <command...>"; exit 1; }
      STEP_LINES+=("$lineno|$line")
      ;;
    manual)
      # A step the plan knows but has no command for yet (design section 3):
      # reported as not covered, and the verdict is never green.
      [ "${words[2]:-}" = "--" ] && [ "${#words[@]}" -ge 4 ] || { log "✗ plan:$lineno: manual <chain> -- <what the step does>"; exit 1; }
      STEP_LINES+=("$lineno|$line")
      UNCOVERED+=("plan:$lineno ${words[1]}: ${line#*-- }")
      ;;
    relay)
      # Deliver every pending cross-chain message from one fork to another.
      [ "${#words[@]}" -eq 3 ] || { log "✗ plan:$lineno: relay <from-chain> <to-chain>"; exit 1; }
      STEP_LINES+=("$lineno|$line")
      [ -n "${RH_RELAY:-}" ] || UNCOVERED+=("plan:$lineno relay ${words[1]} to ${words[2]}: the relay between forks is not wired into the driver yet (#3892)")
      ;;
    *) log "✗ plan:$lineno: unknown step kind ${words[0]}"; exit 1 ;;
  esac
done < "$PLAN"
[ "${#CHAINS[@]}" -gt 0 ] || { log "✗ plan: no chains line"; exit 1; }
for s in "${STEP_LINES[@]}"; do
  read -r -a words <<<"${s#*|}"
  case "${words[0]}" in step | cmd | manual | relay)
    named=("${words[1]}")
    [ "${words[0]}" = relay ] && named+=("${words[2]}")
    for want in "${named[@]}"; do
      in_set=0
      for c in "${CHAINS[@]}"; do [ "$c" = "$want" ] && in_set=1; done
      [ "$in_set" = 1 ] || { log "✗ plan:${s%%|*}: chain $want is not in the chains line"; exit 1; }
    done
  esac
done
log "  ✓ plan: ${#STEP_LINES[@]} steps over ${CHAINS[*]} (digest $PLAN_DIGEST)"
for u in "${UNCOVERED[@]+"${UNCOVERED[@]}"}"; do log "  ! not covered: $u"; done

# The operator's .env, read as data and with every key variable left out:
# the driver never holds a key. It needs the RPC URLs to fork from and the
# role addresses to impersonate.
if [ -f "$RH_ENV_FILE" ]; then
  load_env_file "$RH_ENV_FILE" --drop-key-vars
fi
for v in DEPLOYER_ADDRESS ADMIN_ADDRESS; do
  [ -n "${!v:-}" ] || { log "✗ $v is required: a rehearsal signs as the role's stated address"; exit 1; }
done

# ── 2. build ───────────────────────────────────────────────────────────
stage build
(cd "$CONTRACTS_DIR" && FOUNDRY_PROFILE=default "$RH_FORGE" build --skip test) 2>&1 | rh_redact >> "$LOGS/build.log"
(cd "$CONTRACTS_DIR" && "$RH_NODE" "$RH_LAYOUT_GUARD" check) 2>&1 | rh_redact >> "$LOGS/build.log"
(cd "$CONTRACTS_DIR" && bash "$RH_PREDEPLOY") 2>&1 | rh_redact >> "$LOGS/build.log"
log "  ✓ built once; storage-layout guard and pre-deploy check passed for this tree"

# ── 3. snapshot ────────────────────────────────────────────────────────
stage snapshot
"$RH_NODE" "$SCRIPT_DIR/rehearsal-tree.mjs" snapshot "$SCRATCH/tree.before.json" --scratch "contracts/$VAIPAKAM_REHEARSAL_ROOT"
TREE_JSON=$("$RH_NODE" "$SCRIPT_DIR/rehearsal-tree.mjs" digest)
INPUT_JSON=$("$RH_NODE" "$SCRIPT_DIR/rehearsal-inputs.mjs" digest "$RH_ENV_FILE")
log "  ✓ tree recorded"

# ── 4. forks ───────────────────────────────────────────────────────────
stage forks
roles=("$DEPLOYER_ADDRESS" "$ADMIN_ADDRESS")
# Other signing roles a plan step names by address (the treasury wallet
# moving the reward funding, for one) are impersonated too.
for v in TREASURY_ADDRESS VPFI_SOURCE_ADDRESS MOCK_OWNER_ADDRESS; do
  [ -n "${!v:-}" ] && roles+=("${!v}")
done
i=0
for c in "${CHAINS[@]}"; do
  read -r cid rpc_var _ <<<"$(chain_of "$c")"
  if [ "${RH_SKIP_FORKS:-0}" = 1 ]; then
    FORK_URL[$c]=$(printf '%s\n' "${RH_FAKE_FORKS:-}" | tr ' ' '\n' | sed -n "s|^$c=||p")
    FORK_BLOCK[$c]=0
  else
    rh_fork_start "$c" "$cid" "$rpc_var" "$((PORT_BASE + i))" "$LOGS" "${roles[@]}"
    FORK_URL[$c]="$RH_LAST_URL"
    FORK_BLOCK[$c]=$(awk -F'\t' -v s="$c" '$1 == s { print $3 }' "$LOGS/forks.tsv" | tail -1)
  fi
  [ -n "${FORK_URL[$c]}" ] || { log "✗ no fork for $c"; exit 1; }
  log "  ✓ $c forked at block ${FORK_BLOCK[$c]} (chain id $cid)"
  i=$((i + 1))
done
fork_urls() { local c; for c in "${CHAINS[@]}"; do printf '%s ' "${FORK_URL[$c]}"; done; }
if [ "${RH_SKIP_FORKS:-0}" != 1 ]; then
  # shellcheck disable=SC2046 # loopback URLs, no spaces
  rh_clock_align $(fork_urls)
fi
FORK_TIME=$(date -u +%s)

# ── 5. records ─────────────────────────────────────────────────────────
stage records
for c in "${CHAINS[@]}"; do
  if [ -d "$CONTRACTS_DIR/deployments/$c" ]; then
    cp -R "$CONTRACTS_DIR/deployments/$c" "$SCRATCH/$c"
  fi
done
[ -f "$CONTRACTS_DIR/deployments/archive-manifest.json" ] && cp "$CONTRACTS_DIR/deployments/archive-manifest.json" "$SCRATCH/"
# Records of chains outside the plan stay readable (ConfigureCcip reads each
# lane's peer); they are copied too, so a step reads the scratch copy and the
# committed file is never opened for writing.
for d in "$CONTRACTS_DIR"/deployments/*/; do
  name=$(basename "$d")
  case "$name" in .forge-test | .*) continue ;; esac
  [ -e "$SCRATCH/$name" ] || cp -R "$d" "$SCRATCH/$name"
done
log "  ✓ records copied into $VAIPAKAM_REHEARSAL_ROOT"

# ── 6. steps ───────────────────────────────────────────────────────────
stage steps
n=0
for s in "${STEP_LINES[@]}"; do
  n=$((n + 1))
  ln="${s%%|*}"
  read -r -a words <<<"${s#*|}"
  case "${words[0]}" in
    step)
      chain="${words[1]}"; phase="${words[2]}"
      log "  → [$n] plan:$ln $chain $phase"
      steplog="$LOGS/$(printf '%03d' "$n")-$chain-$phase.log"
      if ! (cd "$REPO_ROOT" && VAIPAKAM_REHEARSAL_RPC_URL="${FORK_URL[$chain]}" \
            bash "$RH_DEPLOY_SCRIPT" "$chain" --phase "$phase" "${words[@]:3}" --rehearse) 2>&1 \
          | rh_redact > "$steplog"; then
        FAILED_STAGE="steps (plan:$ln $chain $phase)"
        tail -20 "$steplog" | sed 's/^/      /' | tee -a "$LOGS/driver.log"
        exit 1
      fi
      ;;
    clock)
      arg="${words[1]}"
      if [ "${arg:0:1}" = "@" ]; then target="${arg:1}"; else
        first="${CHAINS[0]}"
        now=$(cast block latest --field timestamp --rpc-url "${FORK_URL[$first]}")
        target=$((now + ${arg:1}))
      fi
      log "  → [$n] plan:$ln clock to $target"
      # shellcheck disable=SC2046
      rh_clock_set "$target" $(fork_urls)
      ;;
    manual)
      log "  → [$n] plan:$ln ${words[1]} manual step with no command: ${s#*-- }"
      FAILED_STAGE="steps (plan:$ln not covered: a manual step with no command)"
      exit 1
      ;;
    relay)
      from="${words[1]}"; to="${words[2]}"
      log "  → [$n] plan:$ln relay $from to $to"
      if [ -z "${RH_RELAY:-}" ]; then
        FAILED_STAGE="steps (plan:$ln not covered: the relay between forks, #3892)"
        exit 1
      fi
      steplog="$LOGS/$(printf '%03d' "$n")-relay-$from-$to.log"
      if ! $RH_RELAY "$from" "${FORK_URL[$from]}" "$to" "${FORK_URL[$to]}" 2>&1 | rh_redact > "$steplog"; then
        FAILED_STAGE="steps (plan:$ln relay $from to $to)"
        tail -20 "$steplog" | sed 's/^/      /' | tee -a "$LOGS/driver.log"
        exit 1
      fi
      ;;
    cmd)
      chain="${words[1]}"
      text="${s#*|}"; text="${text#*-- }"
      log "  → [$n] plan:$ln $chain hand step: $text"
      steplog="$LOGS/$(printf '%03d' "$n")-$chain-cmd.log"
      if ! (cd "$CONTRACTS_DIR" && REHEARSE=1 VAIPAKAM_REHEARSAL=1 VAIPAKAM_REHEARSAL_RPC_URL="${FORK_URL[$chain]}" \
            RPC="${FORK_URL[$chain]}" bash -c "source '$SCRIPT_DIR/lib/rehearsal.sh' && rehearsal_enter \"\$RPC\" '$CONTRACTS_DIR' '$RH_ENV_FILE' || exit 1; $text") 2>&1 \
          | rh_redact > "$steplog"; then
        FAILED_STAGE="steps (plan:$ln hand step)"
        tail -20 "$steplog" | sed 's/^/      /' | tee -a "$LOGS/driver.log"
        exit 1
      fi
      ;;
  esac
done
log "  ✓ ${#STEP_LINES[@]} steps ran"

# ── 7. compare ─────────────────────────────────────────────────────────
stage compare
"$RH_NODE" "$SCRIPT_DIR/rehearsal-tree.mjs" snapshot "$SCRATCH/tree.after.json" --scratch "contracts/$VAIPAKAM_REHEARSAL_ROOT"
"$RH_NODE" "$SCRIPT_DIR/rehearsal-tree.mjs" compare "$SCRATCH/tree.before.json" "$SCRATCH/tree.after.json" 2>&1 \
  | tee -a "$LOGS/driver.log"
[ "${PIPESTATUS[0]}" -eq 0 ] || { FAILED_STAGE=compare; exit 1; }

stage verdict
if [ "${#UNCOVERED[@]}" -gt 0 ]; then FAILED_STAGE="verdict (${#UNCOVERED[@]} step(s) not covered)"; exit 1; fi
RESULT="pass"
exit 0
