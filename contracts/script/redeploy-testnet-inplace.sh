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
    echo "  FOUNDRY_PROFILE=default forge script script/RefreshAllFacetsInPlace.s.sol --sig \"refresh()\" --rpc-url \$$var --broadcast --slow"
    [ "$SKIP_VAULT" -eq 0 ] && \
    echo "  FOUNDRY_PROFILE=default forge script script/UpgradeVaultImplementation.s.sol --sig \"run()\" --rpc-url \$$var --broadcast --slow"
    echo
  done
  exit 0
fi

# ── [4-5] Per-chain broadcast: Refresh (cuts) THEN vault upgrade ──────────────
for slug in $CHAINS; do
  var="$(rpc_var_for "$slug")"
  rpc="${!var}"
  banner "[4] $slug — RefreshAllFacetsInPlace (diamond cuts)"
  "${NICE[@]}" forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" \
    --rpc-url "$rpc" --broadcast --slow \
    || fail "$slug: RefreshAllFacetsInPlace broadcast failed"

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

banner "DONE"
