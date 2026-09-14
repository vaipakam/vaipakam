#!/usr/bin/env bash
#
# redeploy-testnet-inplace.sh — one-command in-place testnet redeploy orchestrator
# ==============================================================================
#
# Sequences the EXISTING deploy tools in the required order for an in-place
# (NON-fresh) testnet redeploy — facet diamond-cuts + the UUPS vault-template
# upgrade — behind a single fail-fast gate. It does NOT reimplement any of them;
# it only composes:
#
#   1. forge build                         (compile src+script; needed by 2-4)
#   2. predeploy-check.sh                  (deploy-sanity: facet sizes, selector
#                                           coverage/collisions, shell lint, ABI-
#                                           in-sync) — the same [1b] gate
#                                           deploy-testnet.sh runs
#   3. run-regression.sh --invariants      (the CHUNKED full regression — never
#                                           one monolithic run, so it can't trip
#                                           the viaIR stack ceiling; coverage is
#                                           find-derived so no suite is missed)
#   ── per chain (default: base-sepolia arb-sepolia) ──
#   4. RefreshAllFacetsInPlace.s.sol       (redeploy every facet + diamond-cut
#                                           the whole selector set onto the LIVE
#                                           diamond; pauses across the cuts,
#                                           verifies routing, reverts on mismatch)
#   5. UpgradeVaultImplementation.s.sol    (deploy a fresh VaipakamVault impl +
#                                           retarget the shared UUPS template)
#   ── once, at the end (optional --export) ──
#   6. exportFrontendDeployments.sh + exportFrontendAbis.sh
#
# WHY THIS ORDER
#   - The regression + sanity gate is chain-INDEPENDENT (local tests + static
#     checks), so it runs ONCE, FIRST, and a failure aborts before ANY gas is
#     spent on ANY chain. Fail-fast is the whole point.
#   - Within a chain, Refresh runs BEFORE the vault upgrade: Refresh can Replace
#     VaultFactoryFacet's bytecode, and the vault upgrade calls
#     VaultFactoryFacet.upgradeVaultImplementation — so it must execute against
#     the FRESH facet, and after Refresh has unpaused the diamond.
#
# SAFETY / MODES
#   - DEFAULT = GATE-ONLY (dry): runs steps 1-3, then PRINTS the exact per-chain
#     broadcast commands and stops. Nothing is sent. Use this to validate the
#     source that will be deployed.
#   - --broadcast : after the gate passes, actually broadcasts steps 4-5 per
#     chain with `--slow` (the admin owner is EIP-7702-delegated on Base Sepolia
#     and may have only one in-flight tx). This is the "run them all" path.
#   - A gate failure (build / sanity / regression) ALWAYS aborts before any
#     broadcast — `set -euo pipefail` + explicit checks.
#
# RE-RUN / SKIP FLAGS
#   --broadcast            Actually send the per-chain txs (else gate-only).
#   --skip-regression      Skip step 3 (already ran the chunked regression).
#   --skip-sanity          Skip step 2 (predeploy-check).
#   --skip-build           Skip step 1 (warm build already done).
#   --skip-vault           Cuts only — skip step 5 (vault template unchanged).
#   --chains "a b"         Override the chain-slug list (default: the two below).
#   --export               After a successful --broadcast, run step 6.
#   -h | --help            Show usage.
#
# ENV
#   Sources ./.env (or ../.env) if present, then requires — per chain — the
#   matching <PREFIX>_RPC_URL, plus DEPLOYER_PRIVATE_KEY and ADMIN_PRIVATE_KEY
#   (the forge scripts read these via vm.envUint). Chain->RPC-var mapping mirrors
#   Deployments.sol's envPrefix(): base-sepolia -> BASE_SEPOLIA_RPC_URL, etc.
#
#   P1-b SEED (#1434) — required ONCE per chain, and only on a chain that has
#   not been seeded yet. RefreshAllFacetsInPlace performs a ONE-SHOT,
#   IRREVERSIBLE accounting migration inside its paused block: it seeds how much
#   ARMED fresh that chain had already paid out before P1-b. The correct value is
#   per chain (a fresh post-P1-b deploy owes 0; a pre-P1-b mirror owes its real
#   indexed payout history), so the variables are per chain too, following the
#   same <PREFIX> convention as the RPC URLs:
#
#     ARMED_FRESH_PAID_SEED_<PREFIX>        e.g. ARMED_FRESH_PAID_SEED_ARB_SEPOLIA=1234...
#     ARMED_FRESH_PAID_NO_HISTORY_<PREFIX>  e.g. ARMED_FRESH_PAID_NO_HISTORY_BASE_SEPOLIA=true
#
#   Exactly one of the two must be set for each UNSEEDED selected chain; the
#   pre-flight refuses the run otherwise, BEFORE any broadcast. An already-seeded
#   chain needs neither (the script skips the migration block by reading the
#   on-chain `armedFreshPaidSeeded()` flag). The orchestrator exports the
#   resolved pair as the process-global ARMED_FRESH_PAID_SEED /
#   ARMED_FRESH_PAID_NO_HISTORY the forge script reads — per chain, inside the
#   loop, so a multi-chain run can never apply one chain's answer to another.
#
#   REWARD ROLE BACKFILL (#1566 closure 3) — required for EVERY selected chain.
#   The four-state reward-role resolver records the role in a field that did
#   not exist before this upgrade; a chain that was configured and then
#   DETACHED under the old setters would otherwise read as never-configured
#   (fail-OPEN: unbounded delivered allowance). State cannot tell the two
#   apart, so the operator declares each chain's role from the recorded
#   topology, in the same refuse-to-default posture as the P1-b seed:
#
#     REWARD_ROLE_EXPECTED_<PREFIX>   one of canonical | mirror | unconfigured | detached
#                                     e.g. REWARD_ROLE_EXPECTED_BASE_SEPOLIA=canonical
#
#   RefreshAllFacetsInPlace reads the role back (getRewardRole) while paused and
#   compares it to the declaration; the ONLY transition it applies is the
#   backfill case itself (a pre-field detached chain reading Unconfigured is
#   recorded Detached). A declared canonical/mirror role the Diamond does not
#   record is refused — run ConfigureRewardReporter for those. The orchestrator
#   exports the resolved value as the process-global REWARD_ROLE_EXPECTED, per
#   chain, inside the loop.
#
#   PAID-SIDE REBASE (#1566 slice 4 PR A) — required for every selected chain
#   that has not run it. Closure 2 (#2151) widened what the paid side charges
#   to every vintage, so a pre-existing mirror with ordinary-schedule history
#   reads UNDER-counted after the refresh unless its paid counter is rebased to
#   the reconstructed absolute total. RefreshAllFacetsInPlace runs the
#   one-shot rebase itself, paused, after the role backfill — and, like the
#   P1-b seed, refuses to default the figure. Per chain, same <PREFIX>:
#
#     ARMED_FRESH_PAID_TOTAL_<PREFIX>        the reconstructed ABSOLUTE fresh-paid total
#                                            (every vintage; existing counter / retirement
#                                            watermark are a FLOOR the call applies itself)
#     ARMED_FRESH_REBASE_NO_HISTORY_<PREFIX> =true to declare there is nothing to import
#
#   Exactly one of the two must be set for each NOT-YET-REBASED selected chain
#   (the pre-flight reads the on-chain `armedFreshPaidRebased()` flag and
#   skips an already-rebased chain). On a chain whose reward role is inactive
#   (unconfigured / detached) the facet accepts only a history-free chain; a
#   detached chain with history is DEFERRED by the refresh with the stated
#   total logged for its re-attachment ceremony. The orchestrator exports the
#   resolved pair as the process-global ARMED_FRESH_PAID_TOTAL /
#   ARMED_FRESH_REBASE_NO_HISTORY, per chain, inside the loop — never one
#   chain's irreversible total for another.
#
#   The pre-flight also reads the EXISTING paid counter of every not-yet-
#   rebased chain (the lens getter `getDeliveredFreshBound()`, first word) and
#   refuses one above the 69M pool cap before any broadcast, since the rebase
#   refuses to floor on it. A chain that reports the P1-b seed as run must
#   expose that counter; on one that never routed the seeder the read is
#   best-effort, because nothing but the pre-cap seeder could exceed the cap.
#   Where the counter reads, the seeder's own predicate — the RESULTING
#   counter, existing plus seed, within the cap — is checked as well.
#
#   EVERY answer to a due migration — a stated seed or total, or a
#   NO_HISTORY declaration — must have been established from a chain that
#   could not move, and be BOUND to that pause: pause the Diamond manually,
#   establish the answer from the paused chain, and state the pause EPOCH
#   you established it at:
#
#     ARMED_FRESH_PAUSE_EPOCH_<PREFIX>       the pause library's transition count at
#                                            that moment (bytes 17..24 of its storage
#                                            slot; the pre-flight reports the live one)
#
#   The pre-flight refuses a chain with a migration due unless it is under
#   the MANUAL pause (read directly from the pause slot, so a manual pause
#   beside a watcher window counts) AND the stated epoch is the live one;
#   the refresh refuses again before its first transaction (forge re-checks
#   immediately before each broadcast); and the rebase refuses ON CHAIN. A
#   lift-and-reapply moves the count even inside one block, so a stale
#   answer can never be paired with a fresh pause. The refresh itself also
#   pauses as its first transaction, before the implementation deploys, and
#   leaves a chain it found paused PAUSED — reported as such, not as
#   ordinary completion.
#
#   FIRST ROLLOUT = TWO RUNS. Until this refresh has cut the new pause code
#   in, the live Diamond counts no transitions (the count reads zero), so a
#   pause made under the old code cannot be pinned. On such a chain the run
#   performs every refresh step EXCEPT the two paid-side migrations (the
#   cuts, the retired-selector removal, the proxy upgrades and the
#   reward-role backfill DO run) — and demands NO migration answer for that
#   chain on that run; then pause again (counted now),
#   establish the answer under that pause, state its epoch, and run again
#   for that chain — the facets are current and the migrations run. The
#   refresh always sends pause() as its first transaction (protecting the
#   cuts by transaction order; the irreversible migrations are gated on
#   chain), and both migrations — the older seed as well as the rebase —
#   carry the epoch and are refused on chain if it is stale.
#
#   And before the first broadcast, EVERY selected chain's refresh is
#   simulated end to end against a fork of its live state (step [3b], never
#   skipped): each refusal the forge script can raise is exercised at that
#   chain's head AT SIMULATION TIME, with nothing sent, and a dry run writes
#   no artifact (one gate inside `Deployments` covers every write). What the
#   pass cannot cover is state that changes between the simulation and a
#   later chain's broadcast — an ownership handover, a role, a holder, a
#   proxy generation. Forge re-simulates each chain immediately before
#   sending on it, so a change caught THERE refuses before that chain sends
#   anything; but a failure DURING a broadcast — a transient RPC error, a
#   state change between two of the sequential `--slow` transactions — can
#   leave earlier transactions mined and that chain PARTIALLY refreshed and
#   paused (Codex #2158 r23 P2). The [4] failure therefore never claims that
#   nothing was sent: it names the broadcast journal to inspect, the chains
#   already complete, and the `--chains` rerun for the rest. It is a
#   per-chain validation at a point in time, not a cross-chain guarantee.
#   The bound-holder /
#   artifact relation is classified in the pre-flight too, by the same rule
#   [4b] applies after the refresh: a divergence refuses before any broadcast,
#   a pending bind record is validated by the ceremony script's own check()
#   (what record() will require) before it is accepted as the explanation,
#   and a bind record over a chain that reports NO holder — a staged or
#   direct bind that never executed, which the one-shot bind refuses to run
#   over — refuses before any broadcast as well.
#
# USAGE
#   # gate only (safe default) — validate, print broadcast commands:
#   bash script/redeploy-testnet-inplace.sh
#   # full run — gate, then broadcast both chains, then re-export artifacts:
#   bash script/redeploy-testnet-inplace.sh --broadcast --export
#   # gate already green earlier; just broadcast base-sepolia:
#   bash script/redeploy-testnet-inplace.sh --broadcast --skip-regression \
#       --skip-sanity --chains "base-sepolia"
#
# NOTE: high-priority scheduling (ionice) is applied to the forge steps to match
#       the repo convention for long viaIR runs.

set -euo pipefail

# ── Resolve paths: this script lives in contracts/script/ ─────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$CONTRACTS_DIR"

# Force the default Foundry profile for the WHOLE flow (Codex #1182). The forge
# scripts we broadcast must compile with production-parity settings (viaIR +
# optimizer=200); a stray FOUNDRY_PROFILE=quick/cifast in the caller's env would
# otherwise deploy non-parity bytecode. run-regression.sh already forces this
# internally, but the [1] build + the forge-script broadcasts inherit it here.
export FOUNDRY_PROFILE=default

# ── Defaults ──────────────────────────────────────────────────────────────────
BROADCAST=0
SKIP_REGRESSION=0
SKIP_SANITY=0
SKIP_BUILD=0
SKIP_VAULT=0
RUN_EXPORT=0
CHAINS="base-sepolia arb-sepolia"
NICE=(ionice -c 2 -n 0)

usage() { sed -n '2,60p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --broadcast)       BROADCAST=1 ;;
    --skip-regression) SKIP_REGRESSION=1 ;;
    --skip-sanity)     SKIP_SANITY=1 ;;
    --skip-build)      SKIP_BUILD=1 ;;
    --skip-vault)      SKIP_VAULT=1 ;;
    --export)          RUN_EXPORT=1 ;;
    --chains)          CHAINS="$2"; shift ;;
    -h|--help)         usage 0 ;;
    *) echo "ERROR: unknown arg '$1'" >&2; usage 1 ;;
  esac
  shift
done

banner() { printf '\n\033[1;36m═══ %s ═══\033[0m\n' "$*"; }

# Decimal-string arithmetic for figures past bash's 64-bit range (wei amounts
# near 1e26), with no external dependency. Every pre-flight comparison of
# such a figure goes through `dec_gt`, and the on-chain seeder validates a
# SUM (Codex #2158 r16 P2), so the pre-flight needs `dec_add` too.
dec_norm() { local v; v="$(printf '%s' "$1" | sed 's/^0*//')"; printf '%s' "${v:-0}"; }
# TRUE when digit-only $1 > digit-only $2.
dec_gt() {
  local a b; a="$(dec_norm "$1")"; b="$(dec_norm "$2")"
  [ "${#a}" -gt "${#b}" ] || { [ "${#a}" -eq "${#b}" ] && [ "$a" \> "$b" ]; }
}
# Prints digit-only $1 + digit-only $2.
dec_add() {
  local a b carry=0 out="" i j da db s
  a="$(dec_norm "$1")"; b="$(dec_norm "$2")"
  i=$(( ${#a} - 1 )); j=$(( ${#b} - 1 ))
  while [ "$i" -ge 0 ] || [ "$j" -ge 0 ] || [ "$carry" -ne 0 ]; do
    da=0; db=0
    [ "$i" -ge 0 ] && da="${a:$i:1}"
    [ "$j" -ge 0 ] && db="${b:$j:1}"
    s=$(( da + db + carry ))
    out="$(( s % 10 ))$out"; carry=$(( s / 10 ))
    i=$(( i - 1 )); j=$(( j - 1 ))
  done
  printf '%s' "$out"
}

# The bound-holder / artifact relation of ONE chain (Codex #2158 r12, r16 P2)
# — a single classification, consumed by the all-chain pre-flight (which
# refuses a divergence BEFORE any broadcast) and by step [4b] (which acts on
# the rest after the refresh). Prints "<state> <holder>":
#   unrouted  the LOUPE says the getter is not routed — a pre-slice-4
#             Diamond, expected before the refresh and an error after it
#   unreadable the loupe, or a routed getter, could not be read — an RPC or
#             transport failure, never "not routed"; both consumers FAIL
#             CLOSED on it (Codex #2158 r18 P2: a transient error must not
#             read as "unrouted" and wave a divergent holder past the
#             pre-flight)
#   unbound   routed and zero, and no bind record exists: the one-shot bind
#             is owed
#   unexecuted no holder on chain (unrouted or zero) but a bind ceremony
#             record exists — a staged or direct bind that never executed.
#             DeployRewardCustodyHolder refuses to bind over it, so both
#             consumers refuse: execute the staged bind (then record()) or
#             remove the record deliberately (Codex #2158 r20 P2)
#   recorded  bound, and the artifact names the same holder
#   pending   bound, artifact differs, a bind ceremony record file exists —
#             the pre-flight then VALIDATES it through the ceremony script's
#             own check() (the same _readRecord record() runs: parseable,
#             names this Diamond) before accepting it as the explanation
#             (Codex #2158 r17 P2); a file alone explains nothing
#   diverged  bound, artifact differs, and no record explains it
#   malformed the getter answered something that is not an address
holder_state() {
  local slug="$1" diamond="$2" rpc="$3" sel routed bound recorded has_record=0
  [ -f "deployments/$slug/reward-custody-bind.json" ] && has_record=1
  # Routed or not is the LOUPE's answer (every Diamond routes it), so a
  # failed read anywhere below is a transport failure, never "not routed".
  sel="$(cast sig 'rewardCustodyHolder()')"
  routed="$(cast call "$diamond" 'facetAddress(bytes4)(address)' "$sel" --rpc-url "$rpc" 2>/dev/null)" \
    || { echo "unreadable loupe"; return 0; }
  case "$routed" in
    0x0000000000000000000000000000000000000000)
      # No holder can be bound on an unrouted Diamond; a record here is one
      # that never executed (or was copied in by hand) and run() refuses it.
      [ "$has_record" -eq 1 ] && { echo "unexecuted"; return 0; }
      echo "unrouted"; return 0 ;;
    0x[0-9a-fA-F]*) [ "${#routed}" -eq 42 ] || { echo "malformed $routed"; return 0; } ;;
    *) echo "malformed $routed"; return 0 ;;
  esac
  bound="$(cast call "$diamond" 'rewardCustodyHolder()(address)' --rpc-url "$rpc" 2>/dev/null)" \
    || { echo "unreadable getter"; return 0; }
  case "$bound" in
    0x0000000000000000000000000000000000000000)
      # Unbound WITH a bind record is a bind that never executed (Codex
      # #2158 r20 P2): run() refuses over the record, so it must be executed
      # or deliberately removed before anything is broadcast.
      [ "$has_record" -eq 1 ] && { echo "unexecuted $bound"; return 0; }
      echo "unbound $bound"; return 0 ;;
    0x[0-9a-fA-F]*) [ "${#bound}" -eq 42 ] || { echo "malformed $bound"; return 0; } ;;
    *) echo "malformed $bound"; return 0 ;;
  esac
  recorded="$(grep -oE '"rewardCustodyHolder"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "deployments/$slug/addresses.json" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' || true)"
  if [ "$(printf '%s' "$recorded" | tr 'A-F' 'a-f')" = "$(printf '%s' "$bound" | tr 'A-F' 'a-f')" ]; then
    echo "recorded $bound"
  elif [ -f "deployments/$slug/reward-custody-bind.json" ]; then
    echo "pending $bound"
  else
    echo "diverged $bound"
  fi
}

# Resolve ONE chain's per-chain answers into the process-global names the
# forge script reads (all validated in the pre-flight). Called per chain,
# right before each forge invocation, so a multi-chain run can never apply
# one chain's irreversible answer to another — the whole reason these
# variables are per chain.
export_chain_answers() {
  local slug="$1" pfx seed_var nohist_var role_var total_var rnohist_var
  pfx="$(prefix_for "$slug")"
  seed_var="ARMED_FRESH_PAID_SEED_${pfx}"; nohist_var="ARMED_FRESH_PAID_NO_HISTORY_${pfx}"
  unset ARMED_FRESH_PAID_SEED ARMED_FRESH_PAID_NO_HISTORY
  [ -n "${!seed_var:-}" ] && export ARMED_FRESH_PAID_SEED="${!seed_var}"
  [ "${!nohist_var:-}" = "true" ] && export ARMED_FRESH_PAID_NO_HISTORY=true
  role_var="REWARD_ROLE_EXPECTED_${pfx}"
  unset REWARD_ROLE_EXPECTED
  export REWARD_ROLE_EXPECTED="${!role_var}"
  total_var="ARMED_FRESH_PAID_TOTAL_${pfx}"; rnohist_var="ARMED_FRESH_REBASE_NO_HISTORY_${pfx}"
  unset ARMED_FRESH_PAID_TOTAL ARMED_FRESH_REBASE_NO_HISTORY
  [ -n "${!total_var:-}" ] && export ARMED_FRESH_PAID_TOTAL="${!total_var}"
  [ "${!rnohist_var:-}" = "true" ] && export ARMED_FRESH_REBASE_NO_HISTORY=true
  # The pause epoch the pre-flight pinned for this chain (set only where a
  # migration is due); the refresh refuses a due migration without it.
  local epoch_var="ARMED_FRESH_PAUSE_EPOCH_${pfx}"
  unset ARMED_FRESH_PAUSE_EPOCH
  [ -n "${!epoch_var:-}" ] && export ARMED_FRESH_PAUSE_EPOCH="${!epoch_var}"
  return 0
}
info()   { printf '  · %s\n' "$*"; }
fail()   { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Load .env (RPC URLs + keys) WITHOUT clobbering already-exported vars ──────
# Explicit environment WINS (Codex #1182): a var the caller already exported is
# kept; .env only fills the gaps. Split on the FIRST '=' so RPC URLs with query
# params (…?key=…) survive; tolerate `export FOO=…`; strip surrounding quotes.
for envf in ./.env ../.env; do
  [ -f "$envf" ] || continue
  info "loading $envf (only vars not already set)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    val="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"   # ltrim
    key="${key%"${key##*[![:space:]]}"}"   # rtrim
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac  # valid var name only
    [ -n "${!key:-}" ] && continue                        # already set -> keep
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    export "$key=$val"
  done < "$envf"
  break
done

# Map a chain slug -> its RPC-URL env-var NAME (mirrors Deployments.envPrefix()).
rpc_var_for() {
  case "$1" in
    base-sepolia) echo BASE_SEPOLIA_RPC_URL ;;
    arb-sepolia)  echo ARB_SEPOLIA_RPC_URL ;;
    sepolia)      echo SEPOLIA_RPC_URL ;;
    op-sepolia)   echo OP_SEPOLIA_RPC_URL ;;
    bnb-testnet)  echo BNB_TESTNET_RPC_URL ;;
    *) return 1 ;;
  esac
}

# Map a chain slug -> its env-var PREFIX (the RPC var minus the _RPC_URL tail).
# Used by the P1-b seed pre-flight so its variables follow the same convention.
prefix_for() {
  local v
  v="$(rpc_var_for "$1")" || return 1
  echo "${v%_RPC_URL}"
}

# Map a chain slug -> its expected EVM chain-id (mirrors Deployments.chainSlug()).
chainid_for() {
  case "$1" in
    base-sepolia) echo 84532 ;;
    arb-sepolia)  echo 421614 ;;
    sepolia)      echo 11155111 ;;
    op-sepolia)   echo 11155420 ;;
    bnb-testnet)  echo 97 ;;
    *) return 1 ;;
  esac
}

# ── Pre-flight: every requested chain must have an RPC URL + the right keys ───
banner "Pre-flight: env + chain RPCs"
# ADMIN signs the diamond-cut AND the vault retarget, so it is ALWAYS required.
: "${ADMIN_PRIVATE_KEY:?ADMIN_PRIVATE_KEY not set (signs the diamond-cut + vault retarget)}"
# DEPLOYER is only used by the vault-upgrade step (deploys the impl + funds admin
# gas). RefreshAllFacetsInPlace signs everything with ADMIN, so a cuts-only
# (--skip-vault) run does NOT need a deployer key (Codex #1182).
if [ "$SKIP_VAULT" -eq 0 ]; then
  : "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY not set (needed by the vault-upgrade step; omit it only with --skip-vault)}"
fi
for slug in $CHAINS; do
  var="$(rpc_var_for "$slug")" || fail "unknown chain slug '$slug' (no RPC-var mapping)"
  val="${!var:-}"
  [ -n "$val" ] || fail "chain '$slug' selected but \$$var is empty — set it in .env"
  # Verify the RPC actually serves the chain we think it does (Codex #1182): a
  # BASE_SEPOLIA_RPC_URL secretly pointing at another chain would pass the
  # forge script's testnet-only guard yet cut the WRONG diamond and read the
  # wrong deployments/<slug>/addresses.json. Skip only if `cast` is absent.
  want="$(chainid_for "$slug")"
  if command -v cast >/dev/null 2>&1; then
    got="$(cast chain-id --rpc-url "$val" 2>/dev/null || echo '')"
    [ -n "$got" ] || fail "chain '$slug': RPC \$$var did not answer eth_chainId (bad URL / down?)"
    [ "$got" = "$want" ] || fail "chain '$slug': RPC \$$var is chain-id $got, expected $want — wrong RPC URL"
    info "$slug -> \$$var (chain-id $got ✓)"
  else
    info "$slug -> \$$var ✓ (cast not found — chain-id verify skipped)"
  fi

  # When the vault step will run, pre-flight VAULT_ADMIN_ROLE UP FRONT (Codex
  # #1182). The orchestrator broadcasts Refresh (cuts) before the vault step, so
  # a role divergence (rotation / revocation) would otherwise fail only AFTER
  # the cuts already landed — a partial redeploy. Verifying here fails before
  # any broadcast. Needs cast; skipped (with a warning) if absent.
  admin_addr="$(cast wallet address --private-key "$ADMIN_PRIVATE_KEY" 2>/dev/null)" \
    || fail "could not derive admin address from ADMIN_PRIVATE_KEY"
  if [ "$SKIP_VAULT" -eq 0 ] && command -v cast >/dev/null 2>&1; then
    role="$(cast keccak 'VAULT_ADMIN_ROLE')"
    dfile="deployments/$slug/addresses.json"
    diamond="$(grep -oE '"diamond"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$dfile" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}')"
    [ -n "$diamond" ] || fail "chain '$slug': no .diamond in $dfile (needed for the VAULT_ADMIN_ROLE pre-flight)"
    has="$(cast call "$diamond" 'hasRole(bytes32,address)(bool)' "$role" "$admin_addr" --rpc-url "$val" 2>/dev/null || echo '')"
    [ "$has" = "true" ] \
      || fail "chain '$slug': admin $admin_addr lacks VAULT_ADMIN_ROLE on $diamond — the cuts would land but the vault step would revert (use --skip-vault or grant the role first)"
    info "$slug: admin holds VAULT_ADMIN_ROLE ✓"
  fi

  # P1-b seed pre-flight (#1434). RefreshAllFacetsInPlace runs a ONE-SHOT,
  # IRREVERSIBLE accounting migration inside its paused block, and its inputs
  # are per CHAIN — a fresh post-P1-b deploy owes 0, a pre-P1-b mirror owes its
  # real payout history. A single process-global answer applied across the
  # default two-chain loop is therefore wrong for at least one of them, with no
  # repair path (`seedArmedFreshPaid` refuses a second call). Validate here, so
  # a missing or ambiguous answer fails BEFORE any broadcast — the same reason
  # the VAULT_ADMIN_ROLE check moved up front.
  #
  # An ALREADY-SEEDED chain needs no answer: the script reads the on-chain flag
  # and skips the block entirely, so demanding an obsolete value would just
  # re-create the wedge that gating fixed.
  pfx="$(prefix_for "$slug")" || fail "chain '$slug': no env-prefix mapping"
  # #1566 slice 4 PR A (Codex #2158 r10 P2) — `cast` is REQUIRED by the
  # post-refresh holder step ([4b] reads rewardCustodyHolder() and fails
  # closed). Demand it HERE, before any broadcast: discovering its absence
  # after RefreshAllFacetsInPlace has already cut and migrated would leave a
  # partially completed rollout, which is exactly what an all-chain
  # preflight exists to prevent.
  command -v cast >/dev/null 2>&1 || fail "'cast' is required for this workflow (the post-refresh holder step reads rewardCustodyHolder() with it) -- install foundry's cast before broadcasting"
  # Reward-role declaration (#1566 closure 3) — required for every selected
  # chain, validated BEFORE any broadcast. Unlike the P1-b seed there is no
  # on-chain "already done" flag to skip on: the forge script compares the
  # live role to this declaration every run and refuses on mismatch.
  role_var="REWARD_ROLE_EXPECTED_${pfx}"
  role_val="${!role_var:-}"
  case "$role_val" in
    canonical|mirror|unconfigured|detached) ;;
    "") fail "chain '$slug': set ${role_var}=canonical|mirror|unconfigured|detached (this Diamond's reward-mesh role per the recorded topology). Refusing to default an irreversible role record." ;;
    *)  fail "chain '$slug': ${role_var}='${role_val}' is not one of canonical|mirror|unconfigured|detached" ;;
  esac
  # LibVaipakam.VPFI_INTERACTION_POOL_CAP = 69_000_000 * 1e18 — the lifetime
  # cap every paid-side figure below is checked against, stated once.
  pool_cap="69000000000000000000000000"
  seed_var="ARMED_FRESH_PAID_SEED_${pfx}"
  nohist_var="ARMED_FRESH_PAID_NO_HISTORY_${pfx}"
  seed_val="${!seed_var:-}"
  nohist_val="${!nohist_var:-}"
  already_seeded=""
  if command -v cast >/dev/null 2>&1; then
    dfile2="deployments/$slug/addresses.json"
    diamond2="$(grep -oE '"diamond"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$dfile2" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}')"
    if [ -n "$diamond2" ]; then
      # A pre-P1-b diamond does not route this selector yet; a revert here is
      # simply "not seeded", never a failure.
      already_seeded="$(cast call "$diamond2" 'armedFreshPaidSeeded()(bool)' --rpc-url "$val" 2>/dev/null || echo '')"
    fi
  fi
  # The slice-4 "already rebased" flag and the EXISTING paid counter are read
  # here, once, because BOTH decisions below consult them: the seeder
  # validates `existing + seed` (Codex #2158 r16 P2) and the rebase refuses to
  # floor on a counter above the pool cap (r13 P1, pre-flighted since r15 P2)
  # — refusals that must land HERE, before any chain has broadcast, not at a
  # later chain's paused refresh. A pre-slice-4 Diamond does not route the
  # flag (a revert reads as "not rebased"); the counter is the first word of
  # the lens getter every seeded Diamond routes. Only the pre-cap seeder could
  # have pushed the counter over the cap (ordinary payouts are charged out of
  # the 69M pool), so a chain that reports the P1-b seed as run MUST expose
  # its counter, while on a chain that never routed the seeder the read is
  # best-effort.
  already_rebased=""; live_paid=""
  if [ -n "${diamond2:-}" ]; then
    already_rebased="$(cast call "$diamond2" 'armedFreshPaidRebased()(bool)' --rpc-url "$val" 2>/dev/null || echo '')"
    live_paid="$(cast call "$diamond2" 'getDeliveredFreshBound()(uint256,uint256)' --rpc-url "$val" 2>/dev/null | head -n 1 | cut -d' ' -f1 | tr -d '[:space:]' || echo '')"
    case "$live_paid" in ''|*[!0-9]*) live_paid="" ;; esac
  fi
  if [ -z "$live_paid" ]; then
    [ "$already_seeded" = "true" ] && fail "chain '$slug': the P1-b seed has run on this Diamond but its existing armed-fresh paid counter could not be read (getDeliveredFreshBound() via cast) -- the slice-4 rebase refuses a counter above the interaction pool cap, and that must be known BEFORE any chain broadcasts; fix the read and re-run"
    info "$slug: existing armed-fresh paid counter not readable here (the seeder never ran on this Diamond, so the counter is bounded by the pool schedule)"
  elif [ "$already_rebased" != "true" ] && dec_gt "$live_paid" "$pool_cap"; then
    fail "chain '$slug': the EXISTING armed-fresh paid counter (${live_paid} wei) already exceeds the interaction pool cap (69,000,000 VPFI = ${pool_cap} wei) -- rebaseArmedFreshPaid refuses to floor on it, so this chain's refresh would abort paused after earlier chains had already broadcast. Only a seed placed before the seeder was capped can have produced it and this refresh carries no in-place correction for it; decide this chain's disposition before re-running (nothing has been broadcast)"
  else
    info "$slug: existing armed-fresh paid counter = ${live_paid} wei (within the pool cap) ✓"
  fi
  # An ANSWER to a one-shot migration — a stated seed, a stated total, OR a
  # no-history declaration — is only as good as the moment it was
  # established (Codex #2158 r25 P1, r26 P1 ×2, r27 P1 ×2): a payout between
  # then and the refresh's pause is charged to the old counter under the old
  # rules, never reaches the seeded or rebased figure, and falsifies "no
  # history" just as surely. The refresh pauses as its FIRST transaction,
  # closing the window inside the run; the window before it is closed here:
  # every chain on which a migration is still DUE (not yet seeded, or not yet
  # rebased) must already be under the MANUAL pause when this pre-flight
  # runs, and the OPERATOR states the pause EPOCH at which the answer was
  # established — the pause library's strictly monotonic transition count,
  # which a lift-and-reapply moves even inside one block — which must equal
  # the live epoch here, again in the refresh before its first transaction
  # (forge re-runs that immediately before each broadcast), and once more ON
  # CHAIN in the rebase itself. An answer is thereby bound to the pause it
  # was taken under, never paired with whatever pause is in force. The state
  # comes from the pause library's ONE storage slot
  # (LibPausable.PAUSABLE_STORAGE_POSITION: `paused` at byte 0, the
  # auto-pause deadline in the next 8 bytes, the last boundary timestamp in
  # the 8 after that, the transition count in the 8 after those), read raw
  # because a pre-refresh Diamond routes no newer getter; the manual flag is
  # read DIRECTLY, so a manual pause that coexists with a watcher window
  # counts (r26 P2). The decode mirrors LibPausable.decodePausableSlot.
  pause_slot="0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400"
  manual_paused=""; pause_epoch=""
  if [ -n "${diamond2:-}" ]; then
    raw="$(cast storage "$diamond2" "$pause_slot" --rpc-url "$val" 2>/dev/null || echo '')"
    case "$raw" in
      0x[0-9a-fA-F]*)
        if [ "${#raw}" -eq 66 ]; then
          hex="${raw#0x}"
          # Big-endian word: byte 0 (`paused`) is the LAST two hex digits;
          # bytes 1..8 (the auto-pause deadline) the 16 before them; bytes
          # 9..16 (`lastPauseBoundaryAt`) the 16 before those; bytes 17..24
          # (`pauseTransitions`, the epoch) the 16 before those — hex[14:30].
          [ "${hex:62:2}" != "00" ] && manual_paused=true
          pause_epoch="$(cast to-dec "0x${hex:14:16}")"
        fi ;;
    esac
  fi
  bootstrap=0
  if [ "$already_seeded" != "true" ] || [ "$already_rebased" != "true" ]; then
    [ "$manual_paused" = "true" ] || fail "chain '$slug': a paid-side migration is DUE on this Diamond (seeded=${already_seeded:-no}, rebased=${already_rebased:-no}) but it is not under the MANUAL pause (pause slot ${raw:-unreadable}) -- the seed, total, or no-history answer for it must be established from a chain that cannot move, and a payout before the refresh pauses never reaches the counter the one-shot guard seals. Pause the Diamond (AdminFacet.pause(); a watcher auto-pause window alone does not count), establish the answer from the paused chain, note the pause epoch this pre-flight then reports, and re-run. Nothing has been sent"
    [ -n "$pause_epoch" ] || fail "chain '$slug': the pause epoch could not be read from the pause slot -- refusing to consume a migration answer whose pause cannot be pinned"
    if [ "$(dec_norm "$pause_epoch")" = "0" ]; then
      # BOOTSTRAP (Codex #2158 r28 P1): a zero count under a manual pause
      # means the pause was made by the OLD pause code, which never counted —
      # nothing can pin it. This run cuts facets only on this chain and the
      # refresh defers the migrations; a second run, after re-pausing on the
      # new code, carries the answer and its epoch.
      info "$slug: BOOTSTRAP — pause transitions are not counted on this Diamond yet (old pause code): this run performs every step of the refresh EXCEPT the two paid-side migrations (facet cuts, retired-selector removal, proxy upgrades, reward-role backfill, tariff migration where due) and leaves it paused; then pause again (counted now), establish the seed / total / no-history answer under that pause, set \$ARMED_FRESH_PAUSE_EPOCH_${pfx}, and run again for the migrations"
      bootstrap_chains="${bootstrap_chains:+$bootstrap_chains }$slug"
      bootstrap=1
    else
      epoch_var="ARMED_FRESH_PAUSE_EPOCH_${pfx}"; epoch_val="${!epoch_var:-}"
      [ -n "$epoch_val" ] || fail "chain '$slug': a paid-side migration is DUE -- set \$$epoch_var to the pause EPOCH at which you established the seed / total / no-history answer under the manual pause (the live epoch right now is $pause_epoch; it is the pause library's transition count, bytes 17..24 of its storage slot). Refusing to pair an answer with a pause it was not taken under. Nothing has been sent"
      case "$epoch_val" in ''|*[!0-9]*) fail "chain '$slug': \$$epoch_var='${epoch_val}' is not a non-negative integer" ;; esac
      [ "$(dec_norm "$epoch_val")" = "$(dec_norm "$pause_epoch")" ] || fail "chain '$slug': \$$epoch_var=$epoch_val but the live pause epoch is $pause_epoch -- the pause was lifted or re-applied since the answer was established, so the answer may omit a payout; re-establish it under the current pause and state that epoch. Nothing has been sent"
      info "$slug: manually paused ✓ at the stated pause epoch $epoch_val (the refresh and the rebase re-check it)"
    fi
  fi
  if [ "$bootstrap" -eq 1 ]; then
    # No migration runs on a bootstrap chain, so no answer is consumed and
    # none is demanded (Codex #2158 r29 P1): the real answers are required
    # on the second run, established under the counted pause.
    info "$slug: P1-b seed answer not needed on this bootstrap run (the migration is deferred; establish it under the counted pause for the second run)"
  elif [ "$already_seeded" = "true" ]; then
    info "$slug: P1-b armed-fresh history already seeded ✓ (migration will be skipped)"
  elif [ -n "$seed_val" ] && [ "$nohist_val" = "true" ]; then
    fail "chain '$slug': both \$$seed_var and \$$nohist_var are set — they are mutually exclusive; state ONE answer for this chain"
  elif [ -n "$seed_val" ]; then
    # Same shape and cap checks as the slice-4 total below (Codex #2158 r14
    # P2): the seed is now capped on chain too, and that refusal must land
    # here, before any chain has broadcast.
    case "$seed_val" in
      ''|*[!0-9]*) fail "chain '$slug': \$$seed_var='${seed_val}' is not a non-negative integer (wei)" ;;
    esac
    if dec_gt "$seed_val" "$pool_cap"; then
      fail "chain '$slug': \$$seed_var='${seed_val}' exceeds the interaction pool cap (69,000,000 VPFI = ${pool_cap} wei) -- seedArmedFreshPaid would refuse it on chain; correct the figure"
    fi
    # The seeder's actual predicate is the SUM (Codex #2158 r16 P2): it refuses
    # `existing + seed` above the cap, so two figures that pass on their own
    # can still abort a later chain's refresh. Checked whenever the counter
    # reads; the simulation in [3b] covers the rest.
    if [ -n "$live_paid" ]; then
      seed_resulting="$(dec_add "$live_paid" "$seed_val")"
      if dec_gt "$seed_resulting" "$pool_cap"; then
        fail "chain '$slug': the existing armed-fresh paid counter (${live_paid} wei) plus \$$seed_var (${seed_val}) = ${seed_resulting} wei exceeds the interaction pool cap (69,000,000 VPFI = ${pool_cap} wei) -- seedArmedFreshPaid refuses the RESULTING counter on chain, and that would land after earlier chains had already broadcast; correct the figure"
      fi
    fi
    info "$slug: P1-b seed = \$$seed_var ($seed_val)"
  elif [ "$nohist_val" = "true" ]; then
    info "$slug: P1-b seed = 0 (\$$nohist_var declares no pre-P1-b history)"
  else
    fail "chain '$slug': the P1-b armed-fresh migration is UNSEEDED and irreversible. Set \$$seed_var to the armed fresh already paid out on this chain before the P1-b upgrade (from the indexed payout history), or \$$nohist_var=true to declare there is none. Refusing to broadcast an accounting migration this run cannot state an answer for."
  fi
  # #1566 slice 4 PR A — the paid-side REBASE answer, same posture as the
  # seed: per chain, validated before any broadcast, skipped only on the
  # on-chain "already rebased" flag (a pre-slice-4 Diamond does not route the
  # getter yet; a revert reads as "not rebased", never as a failure).
  total_var="ARMED_FRESH_PAID_TOTAL_${pfx}"
  rnohist_var="ARMED_FRESH_REBASE_NO_HISTORY_${pfx}"
  total_val="${!total_var:-}"
  rnohist_val="${!rnohist_var:-}"
  if [ "$bootstrap" -eq 1 ]; then
    info "$slug: slice-4 rebase answer not needed on this bootstrap run (the migration is deferred; establish it under the counted pause for the second run)"
  elif [ "$already_rebased" = "true" ]; then
    info "$slug: slice-4 paid-side rebase already run ✓ (migration will be skipped)"
  elif [ -n "$total_val" ] && [ "$rnohist_val" = "true" ]; then
    fail "chain '$slug': both \$$total_var and \$$rnohist_var are set — they are mutually exclusive; state ONE answer for this chain"
  elif [ -n "$total_val" ]; then
    case "$total_val" in
      ''|*[!0-9]*) fail "chain '$slug': \$$total_var='${total_val}' is not a non-negative integer (wei)" ;;
    esac
    # Must fit uint256 (Codex #2158 r8 P2): a digit-only value past the
    # maximum passes the shape check but cannot be decoded by the forge
    # script, and in a multi-chain run that abort would land AFTER earlier
    # chains had already completed their irreversible refreshes.
    uint_max="115792089237316195423570985008687907853269984665640564039457584007913129639935"
    if dec_gt "$total_val" "$uint_max"; then
      fail "chain '$slug': \$$total_var='${total_val}' exceeds uint256 -- the forge script could not decode it, after earlier chains had already broadcast"
    fi
    # And within the interaction pool's lifetime cap (Codex #2158 r12 P2):
    # the facet refuses a larger total (nothing honest can have paid out
    # more than can ever be rewarded), and that refusal must land HERE,
    # before any chain has broadcast, not at a later chain's rebase.
    if dec_gt "$total_val" "$pool_cap"; then
      fail "chain '$slug': \$$total_var='${total_val}' exceeds the interaction pool cap (69,000,000 VPFI = ${pool_cap} wei) -- the rebase would refuse it on chain; correct the reconstruction"
    fi
    info "$slug: slice-4 rebase total = \$$total_var ($total_val)"
  elif [ "$rnohist_val" = "true" ]; then
    info "$slug: slice-4 rebase total = 0 (\$$rnohist_var declares nothing to import)"
  else
    fail "chain '$slug': the slice-4 paid-side rebase has NOT run and is irreversible. Set \$$total_var to the reconstructed absolute fresh-paid total for this chain (every vintage; the deduplicated sum of payouts, expiry/forfeit absorptions and the fresh portions of non-recovery remittance and compensation dispatches), or \$$rnohist_var=true to declare there is nothing to import. Refusing to broadcast an accounting migration this run cannot state an answer for."
  fi
  # #1566 slice 4 PR A (Codex #2158 r16 P2) — the bound-holder / artifact
  # relation is classified HERE, before any broadcast, by the same rule step
  # [4b] applies after the refresh: a chain whose Diamond already names a
  # holder the artifact does not record, with no bind ceremony record to
  # explain it (a staged bind executed from another checkout, say), would
  # otherwise be refused only after this chain's cuts and migrations — and
  # earlier chains' — had already landed.
  if [ -n "${diamond2:-}" ]; then
    read -r holder_st holder_addr <<<"$(holder_state "$slug" "$diamond2" "$val")"
    case "$holder_st" in
      diverged)  fail "chain '$slug': the Diamond reports reward custody holder $holder_addr but the artifact records a different (or no) address and no bind ceremony record is pending -- reconcile deployments/$slug/addresses.json (.rewardCustodyHolder) by hand BEFORE any broadcast; nothing has been sent" ;;
      malformed) fail "chain '$slug': rewardCustodyHolder() returned a malformed answer '$holder_addr' -- refusing to proceed" ;;
      unreadable) fail "chain '$slug': the reward custody holder state could not be read (the $holder_addr call failed -- an RPC or transport error, not a revert) -- refusing to treat an unreadable holder as absent; retry when the RPC answers; nothing has been sent" ;;
      pending)
        # The record explains the divergence only if record() will accept it
        # (Codex #2158 r17 P2): validated NOW, by the ceremony script's own
        # check() — the one _readRecord that record() runs — never by a shell
        # re-reading of the JSON. A stale or foreign record refuses here,
        # with nothing sent, instead of at record() after the refresh.
        "${NICE[@]}" forge script script/DeployRewardCustodyHolder.s.sol --sig "check()" --rpc-url "$val" \
          || fail "chain '$slug': the Diamond reports reward custody holder $holder_addr, the artifact does not, and the pending bind ceremony record deployments/$slug/reward-custody-bind.json does NOT validate (malformed, or names a different Diamond) -- record() would refuse it after the refresh; fix or remove the record deliberately BEFORE any broadcast; nothing has been sent"
        info "$slug: reward custody holder $holder_addr is bound and a VALID bind ceremony record is pending; [4b] reconciles the artifact after the refresh" ;;
      recorded)  info "$slug: reward custody holder $holder_addr bound and recorded ✓" ;;
      unbound)   info "$slug: reward custody holder unbound; [4b] binds it after the refresh" ;;
      unexecuted) fail "chain '$slug': no reward custody holder is bound but a bind ceremony record exists at deployments/$slug/reward-custody-bind.json -- a staged or direct bind that never executed. DeployRewardCustodyHolder refuses to bind over it, so [4b] would fail after this chain's refresh had already broadcast; execute the staged bind and run record(), or remove the record deliberately, BEFORE any broadcast; nothing has been sent" ;;
      unrouted)  info "$slug: the loupe reports the reward custody getter not routed yet (pre-slice-4 Diamond); [4b] binds after the refresh" ;;
    esac
    # [4b] will BIND on an unrouted or unbound chain through
    # DeployRewardCustodyHolder.run(), which refuses unless the signer holds
    # ADMIN_ROLE — a refusal that would otherwise land only after this
    # chain's refresh and migrations had broadcast (Codex #2158 r27 P2).
    # Check it here; a handed-over Diamond takes the staged path instead.
    case "$holder_st" in
      unrouted|unbound)
        admin_role="$(cast keccak 'ADMIN_ROLE')"
        has_admin="$(cast call "$diamond2" 'hasRole(bytes32,address)(bool)' "$admin_role" "$admin_addr" --rpc-url "$val" 2>/dev/null || echo '')"
        [ "$has_admin" = "true" ] || fail "chain '$slug': the post-refresh bind ([4b]) runs DeployRewardCustodyHolder.run(), which requires ADMIN_ROLE on the signer $admin_addr, and this Diamond reports hasRole=${has_admin:-unreadable} -- it would refuse AFTER this chain's refresh had broadcast. Grant the role, or bind this chain through the staged path (--sig \"stage()\" then \"record()\") and select it out of this run. Nothing has been sent"
        info "$slug: signer holds ADMIN_ROLE for the post-refresh bind ✓" ;;
    esac
  fi
done
if [ "$BROADCAST" -eq 1 ]; then
  info "MODE: --broadcast (steps 4-5 will send real txs with --slow)"
else
  info "MODE: gate-only (no --broadcast) — will validate then print broadcast commands"
fi

# ── [1] Build ─────────────────────────────────────────────────────────────────
# Sparse `--skip test` (Codex #1182): the broadcast forge scripts only need
# src/ + script/, and this is a fast compile-fail signal. The test-inclusive
# compile is done by predeploy-check ([2]) and the chunked regression ([3]),
# so a bare `forge build` here would be redundant (and slower).
if [ "$SKIP_BUILD" -eq 0 ]; then
  banner "[1] forge build --skip test (src + script)"
  "${NICE[@]}" forge build --skip test || fail "forge build failed"
else
  info "[1] build skipped (--skip-build)"
fi

# ── [2] Deploy-sanity gate ────────────────────────────────────────────────────
if [ "$SKIP_SANITY" -eq 0 ]; then
  banner "[2] predeploy-check.sh (facet sizes + selector coverage + ABI-in-sync)"
  bash "$SCRIPT_DIR/predeploy-check.sh" || fail "predeploy-check failed — see output above"
else
  info "[2] deploy-sanity skipped (--skip-sanity)"
fi

# ── [3] Chunked full regression (+ invariants) ────────────────────────────────
if [ "$SKIP_REGRESSION" -eq 0 ]; then
  banner "[3] run-regression.sh --invariants (chunked; no stack-too-deep)"
  "${NICE[@]}" bash "$SCRIPT_DIR/run-regression.sh" --invariants \
    || fail "regression failed — aborting BEFORE any broadcast"
else
  info "[3] regression skipped (--skip-regression)"
fi

# ── [3b] Simulate every selected chain's refresh — no broadcast ──────────────
# The root of a whole family of pre-flight findings (Codex #2158 r8, r12,
# r14, r15, r16): each refusal RefreshAllFacetsInPlace can raise on chain —
# the seed's and rebase's caps and sums, the role declaration, the owner key,
# the facet cuts themselves — is exercised HERE, per chain, against a fork of
# its live state AT SIMULATION TIME, before the first broadcast on any chain.
# The bash checks above stay as early, explicit messages for the common
# mistakes; this pass re-implements no on-chain rule. A dry run writes
# nothing: every artifact write goes through one dry-run gate inside
# `Deployments` (r19 P1). It is never skipped — an irreversible multi-chain
# rollout always simulates first.
#
# What it is NOT (Codex #2158 r19 P2): a cross-chain guarantee. State that
# changes between this pass and a later chain's broadcast — an ownership
# handover, a role, a holder, a proxy generation — can still refuse that
# chain. Forge re-simulates each chain immediately before sending on it, so
# a change caught there refuses before THAT chain sends anything — while a
# failure DURING the broadcast can leave that chain partially refreshed (the
# [4] message says which to check). The chains already broadcast in this run
# are complete by then, and the [4] failure names them and the `--chains`
# rerun for the remaining ones.
banner "[3b] simulate RefreshAllFacetsInPlace on every selected chain (no broadcast)"
for slug in $CHAINS; do
  var="$(rpc_var_for "$slug")"
  export_chain_answers "$slug"
  info "[3b] $slug — simulating refresh()"
  "${NICE[@]}" forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" \
    --rpc-url "${!var}" \
    || fail "$slug: RefreshAllFacetsInPlace would REVERT on this chain (see the trace above) -- nothing has been broadcast on any chain"
done
info "[3b] every selected chain's refresh simulated at its current head; state that changes before a later chain's broadcast is re-checked by forge right before that chain sends (see the header)"

banner "GATE PASSED"

# ── Gate-only default: print the broadcast commands and stop ──────────────────
# #1448 r12 — printed on BOTH exit paths, so the gate-only mode cannot
# hand an operator the manual refresh commands without the migration
# that follows them.
#
# #1448 r14 — takes the chain it applies to, because the ceremony is PER
# DIAMOND: each chain has its own reservation history, so "run it once" is
# once per chain, not once per invocation.
print_seed_ceremony() {
cat <<EOF

POST-REFRESH — recycled accounting${1:+ for $1} (any chain with release history):
EOF
cat <<'EOF'

  Run ONCE if the reservation history holds ANY released (status-3)
  reservation — walk getRemitReservation(i) over 1..getRemitReservationNonce().
  That single condition is the whole rule. Do NOT additionally require the
  published stranded cumulative to be zero: a release landing after the
  refresh makes it non-zero while a historical amount is still unrecovered
  behind it, which is exactly the case this recovers.

  To check whether it already ran, read getReleasedRemitStrandedSeedState()
  — its `applied` flag, never the published figure.

    NONCE=$(cast call $DIAMOND "getRemitReservationNonce()(uint256)" ...)
    cast send $DIAMOND "seedReleasedRemitStranded(uint256)" $NONCE ...

  It scans 1..upTo itself — there is no id list to get wrong — and publishes
  nothing until the cursor reaches the target it pinned from the nonce on the
  first call. On a Diamond with a long reservation history, split it:
  `seedReleasedRemitStranded(500)`, `(1000)`, ... up to the nonce; a single
  transaction could otherwise exceed the block gas limit, and the ceremony is
  one-shot. It reverts if a remittance is released mid-ceremony — restart with
  resetReleasedRemitStrandedSeed() and re-run; a restart is an expected
  outcome on a busy chain, not an incident — or if the result does not
  reconcile both relations. Verify:

    cast call $DIAMOND "getRecycleCompositionPosition()(uint256,uint256,bool,bool)"

  The watcher's two CRITICALs must clear on the next tick, and
  getReleasedRemitStrandedSeedState() must report `applied`. Do not verify by
  asserting the stranded cumulative is non-zero — that check is itself
  defeated in the mixed case above, where it was already non-zero before the
  ceremony ran. On a chain with no released reservation at all this step is a
  no-op and can be skipped.

EOF
}

if [ "$BROADCAST" -eq 0 ]; then
  # Echo back the SAME scoping the rehearsal used (Codex #1182) so the copy-paste
  # rerun broadcasts exactly what was just gated — not the full default set.
  rerun="bash script/redeploy-testnet-inplace.sh --broadcast --skip-regression --skip-sanity"
  [ "$SKIP_VAULT" -eq 1 ] && rerun="$rerun --skip-vault"
  [ "$RUN_EXPORT" -eq 1 ] && rerun="$rerun --export"
  [ "$CHAINS" != "base-sepolia arb-sepolia" ] && rerun="$rerun --chains \"$CHAINS\""

  cat <<EOF

The pre-broadcast gate is green. Nothing was sent (gate-only default).
To broadcast the in-place redeploy for [$CHAINS], re-run with --broadcast:

  $rerun

(the --skip-* flags avoid re-running the gate you just passed). Or broadcast a
single chain/step manually:

EOF
  # The manual fall-back commands carry the FOUNDRY_PROFILE=default prefix
  # (Codex #1182): unlike the orchestrator entry point (which exports it), a raw
  # `forge script` inherits the operator's shell profile, and a stray
  # quick/cifast there would broadcast non-parity bytecode.
  for slug in $CHAINS; do
    var="$(rpc_var_for "$slug")"
    echo "  # $slug"
    pfx="$(prefix_for "$slug")"
    # The P1-b seed is per chain and one-shot; a manual rerun must carry the
    # SAME answer the orchestrator would have resolved, or it migrates blind.
    echo "  #   (P1-b, only if this chain is not yet seeded: prefix the command with"
    echo "  #    ARMED_FRESH_PAID_SEED=\$ARMED_FRESH_PAID_SEED_${pfx}  or  ARMED_FRESH_PAID_NO_HISTORY=true)"
    echo "  #   (#1566 role backfill, ALWAYS: prefix with REWARD_ROLE_EXPECTED=\$REWARD_ROLE_EXPECTED_${pfx})"
    echo "  #   (#1566 slice-4 rebase, if not yet rebased: prefix with"
    echo "  #    ARMED_FRESH_PAID_TOTAL=\$ARMED_FRESH_PAID_TOTAL_${pfx}  or  ARMED_FRESH_REBASE_NO_HISTORY=true)"
    echo "  #   (#1566 slice-4, while a seed or rebase is still due: the Diamond must ALREADY be under the MANUAL pause, and the"
    echo "  #    answer's pause epoch must be stated -- prefix with ARMED_FRESH_PAUSE_EPOCH=\$ARMED_FRESH_PAUSE_EPOCH_${pfx}; the"
    echo "  #    refresh refuses the migration unless that is still the live epoch)"
    echo "  FOUNDRY_PROFILE=default forge script script/RefreshAllFacetsInPlace.s.sol --sig \"refresh()\" --rpc-url \$$var --broadcast --slow"
    echo "  #   (#1566 slice-4, only while rewardCustodyHolder() is unbound; after handover: --sig \"stage()\" then --sig \"record()\";"
    echo "  #    in every mode the artifact is reconciled by --sig \"record()\" once the bind has confirmed)"
    echo "  FOUNDRY_PROFILE=default forge script script/DeployRewardCustodyHolder.s.sol --sig \"run()\" --rpc-url \$$var --broadcast --slow"
    echo "  FOUNDRY_PROFILE=default forge script script/DeployRewardCustodyHolder.s.sol --sig \"record()\" --rpc-url \$$var   # after the bind is mined; BEFORE any export"
    [ "$SKIP_VAULT" -eq 0 ] && \
    echo "  FOUNDRY_PROFILE=default forge script script/UpgradeVaultImplementation.s.sol --sig \"run()\" --rpc-url \$$var --broadcast --slow"
    echo
  done
  echo
  print_seed_ceremony
  exit 0
fi

# ── [4-5] Per-chain broadcast: Refresh (cuts) THEN vault upgrade ──────────────
for slug in $CHAINS; do
  var="$(rpc_var_for "$slug")"
  rpc="${!var}"
  # THIS chain's answers (seed, role, rebase — all validated in the pre-flight
  # and exercised by the simulation in [3b]) into the process-global names the
  # forge script reads; scoped per chain inside the loop.
  export_chain_answers "$slug"
  # The chains from this one onward, for the rerun hint below (Codex #2158
  # r19 P2, r23 P2). A failure here is one of two things, and the message
  # does not guess which: forge's pre-send simulation refused (state changed
  # since [3b]; nothing was sent on this chain), or the broadcast itself
  # failed part-way (`--slow` sends the recorded transactions one by one, so
  # the earlier ones are MINED and this chain is partially refreshed and
  # still paused). The broadcast journal and the live loupe tell them apart.
  remaining=""; hit=0
  for c in $CHAINS; do [ "$c" = "$slug" ] && hit=1; [ "$hit" -eq 1 ] && remaining="${remaining:+$remaining }$c"; done
  banner "[4] $slug — RefreshAllFacetsInPlace (diamond cuts)"
  "${NICE[@]}" forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" \
    --rpc-url "$rpc" --broadcast --slow \
    || fail "$slug: RefreshAllFacetsInPlace failed on this chain. EITHER forge's pre-send simulation refused it (the trace above ends before any transaction is sent; state changed since [3b] -- ownership, a role, a holder, a proxy generation) and nothing was sent here, OR the broadcast failed part-way and the transactions already mined are listed in broadcast/RefreshAllFacetsInPlace.s.sol/$(chainid_for "$slug")/run-latest.json -- this chain may then be PARTIALLY refreshed and still PAUSED. Inspect that journal and the live loupe (facetAddresses()) before anything else; resume this chain with 'forge script ... --resume' or a fresh refresh once the cause is fixed. Chains already complete in this run: [${done_chains:-none}]. Rerun for the remaining chains with: --chains \"$remaining\""

  # #1448 r14 — printed HERE, not once at the end. The cut has already
  # landed: this chain's live Diamond now carries the new selector over a
  # zero-valued migration slot, so the seed instructions are owed from this
  # moment on. A later `fail` — the vault upgrade below, or the optional
  # export in [6] — exits under `set -e` before any end-of-run printing, and
  # the operator would be left with a refreshed Diamond, two CRITICALs
  # inbound from the watcher, and no instructions. Owing it per successful
  # refresh is the only placement that cannot be skipped by a downstream
  # failure.
  print_seed_ceremony "$slug"

  # #1566 slice 4 PR A (Codex #2158 r5 P2) — a pre-existing Diamond has no
  # custody holder after the cut; only a fresh DeployDiamond binds one. Bind
  # it here, once, right after the refresh, so the in-place path cannot
  # report "complete" with `rewardCustodyHolder()` unset and the artifact
  # field missing. The script is one-shot on-chain and refuses BEFORE any
  # broadcast when the key lacks ADMIN_ROLE (a handed-over deployment):
  # that refusal names the staged path — `--sig "stage()"` then
  # `--sig "record()"` — which this loop cannot run for it.
  # Fail CLOSED (Codex #2158 r9 P2): an unreadable or malformed holder is
  # not "unbound" — treating it so would re-run the one-shot bind on a
  # chain that already has a holder (which the script refuses, ending the
  # rollout before the vault upgrade) or skip a bind that is genuinely
  # needed. This step therefore requires `cast` and a well-formed answer,
  # and binds only on the exact zero address.
  command -v cast >/dev/null 2>&1 || fail "$slug: 'cast' is required after the refresh to read rewardCustodyHolder() -- install foundry's cast, or run DeployRewardCustodyHolder by hand once you have confirmed the holder is unbound"
  dfile3="deployments/$slug/addresses.json"
  diamond3="$(grep -oE '"diamond"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$dfile3" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}')"
  [ -n "$diamond3" ] || fail "$slug: could not read the Diamond address from $dfile3"
  # One classification for the holder / artifact relation (Codex #2158 r16
  # P2) — the same `holder_state` the pre-flight ran before any broadcast.
  read -r holder_st bound_holder <<<"$(holder_state "$slug" "$diamond3" "$rpc")"
  case "$holder_st" in
    unrouted)
      fail "$slug: the loupe reports rewardCustodyHolder() NOT routed after the refresh -- is RewardCustodyFacet in the cut? refusing to guess whether a holder is bound"
      ;;
    unreadable)
      fail "$slug: the reward custody holder state could not be read after the refresh (the $bound_holder call failed -- an RPC or transport error) -- refusing to guess whether a holder is bound; retry [4b] by hand once the RPC answers"
      ;;
    malformed)
      fail "$slug: rewardCustodyHolder() returned a malformed answer '$bound_holder' -- refusing to proceed"
      ;;
    unexecuted)
      fail "$slug: no holder is bound but a bind ceremony record exists (deployments/$slug/reward-custody-bind.json) -- the one-shot bind refuses over it; execute the staged bind and run record(), or remove the record deliberately, then run [4b] by hand (the all-chain pre-flight refuses this before any broadcast; reaching it here means the record appeared mid-run)"
      ;;
    unbound)
      banner "[4b] $slug — DeployRewardCustodyHolder (one-shot initial bind)"
      "${NICE[@]}" forge script script/DeployRewardCustodyHolder.s.sol --sig "run()" \
        --rpc-url "$rpc" --broadcast --slow \
        || fail "$slug: DeployRewardCustodyHolder failed -- after governance handover run it with --sig \"stage()\" and, once the Timelock executed the bind, --sig \"record()\""
      # `--slow` returned only after the bind was MINED, so the reconciliation
      # can follow at once (Codex #2158 r11 P2): record() reads the live
      # holder and writes .rewardCustodyHolder, so the export in [6] and every
      # later script see the bound holder rather than a stale artifact.
      "${NICE[@]}" forge script script/DeployRewardCustodyHolder.s.sol --sig "record()" \
        --rpc-url "$rpc" \
        || fail "$slug: DeployRewardCustodyHolder record() failed -- the bind broadcast but .rewardCustodyHolder was NOT reconciled; run --sig \"record()\" again before exporting"
      info "[4b] $slug — reward custody holder bound and recorded ✓"
      ;;
    recorded)
      info "[4b] $slug — reward custody holder already bound and recorded ($bound_holder) ✓"
      ;;
    pending)
      # Already bound on chain, but the ARTIFACT is not in step (Codex #2158
      # r12 P2): an earlier run interrupted between the mined bind and
      # record() left a pending ceremony record and a stale or missing
      # .rewardCustodyHolder; continuing would let [6] export the stale
      # artifact and every later ceremony fail its agreement check.
      info "[4b] $slug — holder bound on chain but a bind ceremony record is still pending; reconciling the artifact now"
      "${NICE[@]}" forge script script/DeployRewardCustodyHolder.s.sol --sig "record()" \
        --rpc-url "$rpc" \
        || fail "$slug: DeployRewardCustodyHolder record() failed -- .rewardCustodyHolder is NOT reconciled with the chain; fix before exporting"
      info "[4b] $slug — reward custody holder recorded ✓"
      ;;
    diverged)
      fail "$slug: the Diamond reports holder $bound_holder but the artifact records a different (or no) address and no bind ceremony record is pending -- reconcile .rewardCustodyHolder by hand before continuing (the all-chain pre-flight refuses this before any broadcast; reaching it here means the state changed mid-run)"
      ;;
  esac

  if [ "$SKIP_VAULT" -eq 0 ]; then
    banner "[5] $slug — UpgradeVaultImplementation (UUPS template)"
    "${NICE[@]}" forge script script/UpgradeVaultImplementation.s.sol --sig "run()" \
      --rpc-url "$rpc" --broadcast --slow \
      || fail "$slug: UpgradeVaultImplementation broadcast failed"
  else
    info "[5] $slug — vault upgrade skipped (--skip-vault)"
  fi
  # The refresh restores service only where it found the Diamond live; a
  # chain that had to be paused for a due migration (the normal first
  # rollout) is LEFT PAUSED for a fresh Unpauser decision, and that is not
  # ordinary completion (Codex #2158 r27 P2): say so, here and at the end.
  # Every pause mode is decoded and an unreadable slot is UNKNOWN, never
  # "restored" (Codex #2158 r28 P2): the claim that user operations are
  # enabled is made only when the slot reads and shows neither the manual
  # flag nor a live auto-pause window.
  raw_after="$(cast storage "$diamond3" "$pause_slot" --rpc-url "$rpc" 2>/dev/null || echo '')"
  hex_after="${raw_after#0x}"
  now_ts="$(date -u +%s)"
  if [ "${#hex_after}" -ne 64 ]; then
    info "$slug: in-place redeploy complete -- pause state UNKNOWN (the pause slot could not be read: '${raw_after:-empty}'); verify with 'cast storage <diamond> $pause_slot' before treating this chain as live"
    paused_chains="${paused_chains:+$paused_chains }$slug(unknown)"
  elif [ "${hex_after:62:2}" != "00" ]; then
    info "$slug: in-place redeploy complete -- the Diamond REMAINS PAUSED (manual): user operations stay disabled until a fresh Unpauser decision (AdminFacet.unpause()) once the migrations are verified; this run does not unpause"
    paused_chains="${paused_chains:+$paused_chains }$slug"
  elif dec_gt "$(cast to-dec "0x${hex_after:46:16}")" "$now_ts"; then
    info "$slug: in-place redeploy complete -- the Diamond is under a watcher AUTO-PAUSE window until $(cast to-dec "0x${hex_after:46:16}") (unix): user operations stay disabled until it lapses or an Unpauser clears it; not ordinary completion"
    paused_chains="${paused_chains:+$paused_chains }$slug(auto-pause)"
  else
    info "$slug: in-place redeploy complete (service restored: the pause slot shows neither the manual flag nor a live auto-pause window)."
  fi
  case " ${bootstrap_chains:-} " in *" $slug "*)
    info "$slug: BOOTSTRAP run -- every refresh step ran EXCEPT the paid-side seed and rebase (those are DEFERRED; the role backfill and proxy upgrades DID run). Next for this chain: AdminFacet.pause() once more (counted now), establish the answer under that pause, set \$ARMED_FRESH_PAUSE_EPOCH_$(prefix_for "$slug"), and run again with --chains \"$slug\"" ;;
  esac
  done_chains="${done_chains:+$done_chains }$slug"
done

# ── [6] Optional: re-export deployments + ABIs (once) ─────────────────────────
if [ "$RUN_EXPORT" -eq 1 ]; then
  banner "[6] Re-export deployments + ABIs"
  bash "$SCRIPT_DIR/exportFrontendDeployments.sh" || fail "exportFrontendDeployments failed"
  "${NICE[@]}" forge build --skip test || fail "forge build --skip test (pre-ABI) failed"
  bash "$SCRIPT_DIR/exportFrontendAbis.sh" || fail "exportFrontendAbis failed"
  info "artifacts re-exported — review 'git diff' under packages/contracts/src/ and commit."
else
  cat <<'EOF'

Broadcast complete. Next (artifact sync):
  bash script/exportFrontendDeployments.sh
  forge build --skip test && bash script/exportFrontendAbis.sh
  # review git diff under packages/contracts/src/, then commit + PR.
EOF
fi

# ── [7] Post-refresh accounting ceremonies (operator, evidence-gated) ─────────
#
# #1448 — a facet refresh over a Diamond that RELEASED a remittance before
# `recycleReleasedRemitStrandedCumulative` existed leaves that slot at zero
# while the released state is real. Both externally-checkable recycled
# relations (bucket coverage and bucket composition) then read as violated by
# exactly the historical amount, so `ops/mesh-watcher` pages CRITICAL twice
# from its first tick — on state the supported release path produced.
#
# The seed is NOT run automatically: it is ADMIN-gated, one-shot,
# and it reverts if the derived total does not reconcile both relations. That
# refusal is the point — it must not be able to quiet a real discrepancy — so
# it stays a deliberate operator action.
#
# The instructions themselves were printed above, once per chain, immediately
# after that chain's cut landed (#1448 r14) — deliberately NOT reprinted here,
# because reaching this line is not a precondition for owing them.
cat <<EOF

[7] Post-refresh accounting: the recycled seed ceremony was printed above for
    each refreshed chain [$CHAINS]. It is owed per chain that has any released
    (status-3) reservation, and it is one-shot — check with
    getReleasedRemitStrandedSeedState()'s \`applied\` flag, never the published
    figure.
EOF

if [ -n "${paused_chains:-}" ]; then
  info "NOT LIVE after this run: [$paused_chains] -- a plain slug is under the manual pause it was refreshed under (resume by a fresh Unpauser decision, AdminFacet.unpause(), once its migrations are verified); '(auto-pause)' is under a watcher window; '(unknown)' could not be read and must be verified by hand. Not ordinary completion."
fi
if [ -n "${bootstrap_chains:-}" ]; then
  info "BOOTSTRAP chains (paid-side seed + rebase DEFERRED; every other refresh step ran): [$bootstrap_chains] -- for each: AdminFacet.pause() once more (counted now that the new pause code is live), establish the seed / total / no-history answer under that pause, set ARMED_FRESH_PAUSE_EPOCH_<PREFIX> to the pause library's transition count, and run this script again for that chain."
fi
banner "DONE"
