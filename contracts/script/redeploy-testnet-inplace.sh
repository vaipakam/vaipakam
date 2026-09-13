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
  if [ "$SKIP_VAULT" -eq 0 ] && command -v cast >/dev/null 2>&1; then
    admin_addr="$(cast wallet address --private-key "$ADMIN_PRIVATE_KEY" 2>/dev/null)" \
      || fail "could not derive admin address from ADMIN_PRIVATE_KEY"
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
  if [ "$already_seeded" = "true" ]; then
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
    seed_norm="$(printf '%s' "$seed_val" | sed 's/^0*//')"; [ -z "$seed_norm" ] && seed_norm="0"
    seed_cap="69000000000000000000000000"   # LibVaipakam.VPFI_INTERACTION_POOL_CAP
    if [ "${#seed_norm}" -gt "${#seed_cap}" ] || { [ "${#seed_norm}" -eq "${#seed_cap}" ] && [ "$seed_norm" \> "$seed_cap" ]; }; then
      fail "chain '$slug': \$$seed_var='${seed_val}' exceeds the interaction pool cap (69,000,000 VPFI = ${seed_cap} wei) -- seedArmedFreshPaid would refuse it on chain; correct the figure"
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
  already_rebased=""
  if command -v cast >/dev/null 2>&1 && [ -n "${diamond2:-}" ]; then
    already_rebased="$(cast call "$diamond2" 'armedFreshPaidRebased()(bool)' --rpc-url "$val" 2>/dev/null || echo '')"
  fi
  if [ "$already_rebased" = "true" ]; then
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
    total_norm="$(printf '%s' "$total_val" | sed 's/^0*//')"; [ -z "$total_norm" ] && total_norm="0"
    uint_max="115792089237316195423570985008687907853269984665640564039457584007913129639935"
    if [ "${#total_norm}" -gt 78 ] || { [ "${#total_norm}" -eq 78 ] && [ "$total_norm" \> "$uint_max" ]; }; then
      fail "chain '$slug': \$$total_var='${total_val}' exceeds uint256 -- the forge script could not decode it, after earlier chains had already broadcast"
    fi
    # And within the interaction pool's lifetime cap (Codex #2158 r12 P2):
    # the facet refuses a larger total (nothing honest can have paid out
    # more than can ever be rewarded), and that refusal must land HERE,
    # before any chain has broadcast, not at a later chain's rebase.
    pool_cap="69000000000000000000000000"   # LibVaipakam.VPFI_INTERACTION_POOL_CAP = 69_000_000 * 1e18
    if [ "${#total_norm}" -gt "${#pool_cap}" ] || { [ "${#total_norm}" -eq "${#pool_cap}" ] && [ "$total_norm" \> "$pool_cap" ]; }; then
      fail "chain '$slug': \$$total_var='${total_val}' exceeds the interaction pool cap (69,000,000 VPFI = ${pool_cap} wei) -- the rebase would refuse it on chain; correct the reconstruction"
    fi
    info "$slug: slice-4 rebase total = \$$total_var ($total_val)"
  elif [ "$rnohist_val" = "true" ]; then
    info "$slug: slice-4 rebase total = 0 (\$$rnohist_var declares nothing to import)"
  else
    fail "chain '$slug': the slice-4 paid-side rebase has NOT run and is irreversible. Set \$$total_var to the reconstructed absolute fresh-paid total for this chain (every vintage; the deduplicated sum of payouts, expiry/forfeit absorptions and the fresh portions of non-recovery remittance and compensation dispatches), or \$$rnohist_var=true to declare there is nothing to import. Refusing to broadcast an accounting migration this run cannot state an answer for."
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
  # Resolve THIS chain's P1-b answer into the process-global names the forge
  # script reads (validated in the pre-flight above). Scoped inside the loop so
  # a multi-chain run can never apply one chain's answer to another — the whole
  # reason these variables are per chain.
  pfx="$(prefix_for "$slug")"
  seed_var="ARMED_FRESH_PAID_SEED_${pfx}"
  nohist_var="ARMED_FRESH_PAID_NO_HISTORY_${pfx}"
  unset ARMED_FRESH_PAID_SEED ARMED_FRESH_PAID_NO_HISTORY
  [ -n "${!seed_var:-}" ] && export ARMED_FRESH_PAID_SEED="${!seed_var}"
  [ "${!nohist_var:-}" = "true" ] && export ARMED_FRESH_PAID_NO_HISTORY=true
  # Same per-chain scoping for the reward-role declaration (validated above).
  role_var="REWARD_ROLE_EXPECTED_${pfx}"
  unset REWARD_ROLE_EXPECTED
  export REWARD_ROLE_EXPECTED="${!role_var}"
  # Same per-chain scoping for the slice-4 paid-side rebase (validated above).
  total_var="ARMED_FRESH_PAID_TOTAL_${pfx}"
  rnohist_var="ARMED_FRESH_REBASE_NO_HISTORY_${pfx}"
  unset ARMED_FRESH_PAID_TOTAL ARMED_FRESH_REBASE_NO_HISTORY
  [ -n "${!total_var:-}" ] && export ARMED_FRESH_PAID_TOTAL="${!total_var}"
  [ "${!rnohist_var:-}" = "true" ] && export ARMED_FRESH_REBASE_NO_HISTORY=true
  banner "[4] $slug — RefreshAllFacetsInPlace (diamond cuts)"
  "${NICE[@]}" forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" \
    --rpc-url "$rpc" --broadcast --slow \
    || fail "$slug: RefreshAllFacetsInPlace broadcast failed"

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
  bound_holder="$(cast call "$diamond3" 'rewardCustodyHolder()(address)' --rpc-url "$rpc" 2>/dev/null)" \
    || fail "$slug: rewardCustodyHolder() could not be read after the refresh (is RewardCustodyFacet routed? is the RPC up?) -- refusing to guess whether a holder is bound"
  case "$bound_holder" in
    0x0000000000000000000000000000000000000000)
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
    0x[0-9a-fA-F]*)
      [ "${#bound_holder}" -eq 42 ] || fail "$slug: rewardCustodyHolder() returned a malformed address '$bound_holder' -- refusing to proceed"
      # Already bound on chain — but is the ARTIFACT in step (Codex #2158 r12
      # P2)? An earlier run interrupted between the mined bind and record()
      # leaves a pending ceremony record and a stale or missing
      # .rewardCustodyHolder; continuing would let [6] export the stale
      # artifact and every later ceremony fail its agreement check.
      recorded_holder="$(grep -oE '"rewardCustodyHolder"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$dfile3" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}' || true)"
      if [ "$(printf '%s' "$recorded_holder" | tr 'A-F' 'a-f')" = "$(printf '%s' "$bound_holder" | tr 'A-F' 'a-f')" ]; then
        info "[4b] $slug — reward custody holder already bound and recorded ($bound_holder) ✓"
      elif [ -f "deployments/$slug/reward-custody-bind.json" ]; then
        info "[4b] $slug — holder bound on chain but a bind ceremony record is still pending; reconciling the artifact now"
        "${NICE[@]}" forge script script/DeployRewardCustodyHolder.s.sol --sig "record()" \
          --rpc-url "$rpc" \
          || fail "$slug: DeployRewardCustodyHolder record() failed -- .rewardCustodyHolder is NOT reconciled with the chain; fix before exporting"
        info "[4b] $slug — reward custody holder recorded ✓"
      else
        fail "$slug: the Diamond reports holder $bound_holder but the artifact records '${recorded_holder:-<unset>}' and no bind ceremony record is pending -- reconcile .rewardCustodyHolder by hand before continuing"
      fi
      ;;
    *)
      fail "$slug: rewardCustodyHolder() returned an unexpected answer '$bound_holder' -- refusing to proceed"
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
  info "$slug: in-place redeploy complete."
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

banner "DONE"
