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
#   REWARD ROLE BACKFILL (#1566 closure 3) — required for EVERY selected chain.
#   The four-state reward-role resolver records the role in a field that did
#   not exist before this upgrade; a chain that was configured and then
#   DETACHED under the old setters would otherwise read as never-configured
#   (fail-OPEN: unbounded delivered allowance). State cannot tell the two
#   apart, so the operator declares each chain's role from the recorded
#   topology, and the refresh refuses to default it:
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
#   The refresh pauses as its first transaction, before the implementation
#   deploys, and leaves a chain it found paused PAUSED — reported as such,
#   not as ordinary completion.
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
#   REWARD CUSTODY ACTIVATION (#1566 slice 4 PR B) is a SEPARATE ceremony,
#   never a refresh step: `ActivateRewardCustody.s.sol` switches a chain's
#   reward reads and debits onto the bound holder once every position the
#   holder must back has been reconciled by an explicit per-row answer
#   established under the manual pause (REWARD_CUSTODY_FUND_<ROW> /
#   REWARD_CUSTODY_RELOCATE_<ROW> with REWARD_CUSTODY_PROVENANCE, and on a
#   Mirror REWARD_CUSTODY_FUND_LIVE_FRESH or
#   REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP; REWARD_CUSTODY_PAUSE_EPOCH pins
#   them — every one of them PER CHAIN, suffixed _<PREFIX>, resolved for the
#   current slug only right before the ceremony, exactly like the migration
#   answers). Step [4c] reads each refreshed chain's activation state after the
#   refresh: it runs the ceremony only for a chain opted in with
#   REWARD_CUSTODY_ACTIVATE_<PREFIX>=true, and otherwise REPORTS the chain as
#   not activated — on a Canonical chain that means reward claims and
#   remittances are refused (the delivered bound is received − paid, zero
#   until funded) until the ceremony runs. An Unconfigured deployment keeps
#   Diamond custody by design and is not owed one. After activation the
#   chain stays paused; fund forward with `fundRewardPool` after the unpause.
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
# near 1e26), with no external dependency: every comparison of such a figure
# goes through `dec_gt`.
dec_norm() { local v; v="$(printf '%s' "$1" | sed 's/^0*//')"; printf '%s' "${v:-0}"; }
# TRUE when digit-only $1 > digit-only $2.
dec_gt() {
  local a b; a="$(dec_norm "$1")"; b="$(dec_norm "$2")"
  [ "${#a}" -gt "${#b}" ] || { [ "${#a}" -eq "${#b}" ] && [ "$a" \> "$b" ]; }
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
  local slug="$1" pfx role_var
  pfx="$(prefix_for "$slug")"
  role_var="REWARD_ROLE_EXPECTED_${pfx}"
  unset REWARD_ROLE_EXPECTED
  export REWARD_ROLE_EXPECTED="${!role_var}"
  return 0
}
# #1566 slice 4 PR B (Codex #2186 r1 P2) — the activation ceremony's answers
# are PER CHAIN too: every unprefixed name the forge script reads is unset,
# then set from `<NAME>_<PREFIX>` for the current slug only, right before the
# invocation, so a multi-chain run can never pair one chain's pause epoch,
# funding, relocation, write-down or provenance with another chain's
# ceremony.
export_custody_answers() {
  local slug="$1" pfx name v
  pfx="$(prefix_for "$slug")"
  for name in REWARD_CUSTODY_PAUSE_EPOCH REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP \
      REWARD_CUSTODY_FUND_LIVE_FRESH REWARD_CUSTODY_FUND_RECYCLED REWARD_CUSTODY_RELOCATE_RECYCLED \
      REWARD_CUSTODY_FUND_RECOVERY REWARD_CUSTODY_RELOCATE_RECOVERY \
      REWARD_CUSTODY_FUND_OVERAGE REWARD_CUSTODY_RELOCATE_OVERAGE REWARD_CUSTODY_FUND_SANCTIONS_HELD REWARD_CUSTODY_RELOCATE_SANCTIONS_HELD REWARD_CUSTODY_PROVENANCE; do
    unset "$name"
    v="${name}_${pfx}"
    [ -n "${!v:-}" ] && export "$name=${!v}"
  done
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
# Used by the per-chain answers so their variables follow the same convention.
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

  pfx="$(prefix_for "$slug")" || fail "chain '$slug': no env-prefix mapping"
  # #1566 slice 4 PR A (Codex #2158 r10 P2) — `cast` is REQUIRED by the
  # post-refresh holder step ([4b] reads rewardCustodyHolder() and fails
  # closed). Demand it HERE, before any broadcast: discovering its absence
  # after RefreshAllFacetsInPlace has already cut and migrated would leave a
  # partially completed rollout, which is exactly what an all-chain
  # preflight exists to prevent.
  command -v cast >/dev/null 2>&1 || fail "'cast' is required for this workflow (the post-refresh holder step reads rewardCustodyHolder() with it) -- install foundry's cast before broadcasting"
  # Reward-role declaration (#1566 closure 3) — required for every selected
  # chain, validated BEFORE any broadcast. There is no on-chain "already
  # done" flag to skip on: the forge script compares the live role to this
  # declaration every run and refuses on mismatch.
  role_var="REWARD_ROLE_EXPECTED_${pfx}"
  role_val="${!role_var:-}"
  case "$role_val" in
    canonical|mirror|unconfigured|detached) ;;
    "") fail "chain '$slug': set ${role_var}=canonical|mirror|unconfigured|detached (this Diamond's reward-mesh role per the recorded topology). Refusing to default an irreversible role record." ;;
    *)  fail "chain '$slug': ${role_var}='${role_val}' is not one of canonical|mirror|unconfigured|detached" ;;
  esac
  diamond2=""
  if command -v cast >/dev/null 2>&1; then
    dfile2="deployments/$slug/addresses.json"
    diamond2="$(grep -oE '"diamond"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40}"' "$dfile2" 2>/dev/null | grep -oE '0x[0-9a-fA-F]{40}')"
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
# the role declaration, the owner key,
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
  "${NICE[@]}" forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" --ffi \
    --rpc-url "${!var}" \
    || fail "$slug: RefreshAllFacetsInPlace would REVERT on this chain (see the trace above) -- nothing has been broadcast on any chain"
done
info "[3b] every selected chain's refresh simulated at its current head; state that changes before a later chain's broadcast is re-checked by forge right before that chain sends (see the header)"

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
    pfx="$(prefix_for "$slug")"
    # The role declaration is per chain; a manual rerun must carry the SAME
    # answer the orchestrator would have resolved.
    echo "  #   (#1566 role backfill, ALWAYS: prefix with REWARD_ROLE_EXPECTED=\$REWARD_ROLE_EXPECTED_${pfx})"
    echo "  FOUNDRY_PROFILE=default forge script script/RefreshAllFacetsInPlace.s.sol --sig \"refresh()\" --ffi --rpc-url \$$var --broadcast --slow"
    echo "  #   (#1566 slice-4, only while rewardCustodyHolder() is unbound; after handover: --sig \"stage()\" then --sig \"record()\";"
    echo "  #    in every mode the artifact is reconciled by --sig \"record()\" once the bind has confirmed)"
    echo "  FOUNDRY_PROFILE=default forge script script/DeployRewardCustodyHolder.s.sol --sig \"run()\" --rpc-url \$$var --broadcast --slow"
    echo "  FOUNDRY_PROFILE=default forge script script/DeployRewardCustodyHolder.s.sol --sig \"record()\" --rpc-url \$$var   # after the bind is mined; BEFORE any export"
    [ "$SKIP_VAULT" -eq 0 ] && \
    echo "  FOUNDRY_PROFILE=default forge script script/UpgradeVaultImplementation.s.sol --sig \"run()\" --ffi --rpc-url \$$var --broadcast --slow"
    echo
  done
  exit 0
fi

# ── [4-5] Per-chain broadcast: Refresh (cuts) THEN vault upgrade ──────────────
for slug in $CHAINS; do
  var="$(rpc_var_for "$slug")"
  rpc="${!var}"
  # THIS chain's answer (the role, validated in the pre-flight
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
  "${NICE[@]}" forge script script/RefreshAllFacetsInPlace.s.sol --sig "refresh()" --ffi \
    --rpc-url "$rpc" --broadcast --slow \
    || fail "$slug: RefreshAllFacetsInPlace failed on this chain. EITHER forge's pre-send simulation refused it (the trace above ends before any transaction is sent; state changed since [3b] -- ownership, a role, a holder, a proxy generation) and nothing was sent here, OR the broadcast failed part-way and the transactions already mined are listed in broadcast/RefreshAllFacetsInPlace.s.sol/$(chainid_for "$slug")/run-latest.json -- this chain may then be PARTIALLY refreshed and still PAUSED. Inspect that journal and the live loupe (facetAddresses()) before anything else; once the cause is fixed, re-anchor this chain's storage-layout record from this commit (AnchorStorageLayoutRecord.s.sol with ANCHOR_RECORD_DESCRIBES_CHAIN=true, after confirming from that journal that the chain runs only this run's partial change) and run a fresh refresh. Never use 'forge script ... --resume': it sends the saved plan without the storage-layout check. Chains already complete in this run: [${done_chains:-none}]. Rerun for the remaining chains with: --chains \"$remaining\""

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

  # #1566 slice 4 PR B — the custody cutover is a SEPARATE, operator-answered
  # ceremony (ActivateRewardCustody.s.sol), never a refresh step: it needs
  # the reconciliation figures established under the manual pause and one
  # explicit answer per non-zero figure. This step only REPORTS where the
  # chain stands so the run cannot end reading as complete while the
  # chain's reward custody is still on the Diamond path, and runs the
  # ceremony ONLY when the operator opted this chain in with
  # REWARD_CUSTODY_ACTIVATE_<PREFIX>=true and stated its answers. A chain
  # whose role is Unconfigured keeps Diamond custody by design and is not
  # owed an activation.
  banner "[4c] $slug — reward custody activation (design §5d)"
  activated="$(cast call "$diamond3" 'rewardCustodyActivated()(bool)' --rpc-url "$rpc" 2>/dev/null || echo '')"
  role_now="$(cast call "$diamond3" 'getRewardRole()(uint8)' --rpc-url "$rpc" 2>/dev/null | tr -d '[:space:]' || echo '')"
  act_var="REWARD_CUSTODY_ACTIVATE_$(prefix_for "$slug")"
  case "$activated" in
    true)  info "[4c] $slug — reward custody already ACTIVATED (reads and debits go through the holder) ✓" ;;
    false)
      if [ "$role_now" = "2" ]; then
        info "[4c] $slug — reward role is Unconfigured: this deployment keeps Diamond custody by design; no activation is owed"
      elif [ "${!act_var:-}" = "true" ]; then
        info "[4c] $slug — \$$act_var=true: running ActivateRewardCustody.run() with THIS chain's REWARD_CUSTODY_*_$(prefix_for "$slug") answers (pauses again; states the stated pause epoch + 1)"
        export_custody_answers "$slug"
        [ -n "${REWARD_CUSTODY_PAUSE_EPOCH:-}" ] || fail "$slug: \$$act_var=true but \$REWARD_CUSTODY_PAUSE_EPOCH_$(prefix_for "$slug") is unset -- every activation answer is per chain (suffix _$(prefix_for "$slug")); nothing sent for this ceremony"
        "${NICE[@]}" forge script script/ActivateRewardCustody.s.sol --sig "run()" \
          --rpc-url "$rpc" --broadcast --slow \
          || fail "$slug: ActivateRewardCustody failed -- read the refusal above (a figure without an answer, a stale REWARD_CUSTODY_PAUSE_EPOCH, a role precondition); nothing after the refusal was sent; after governance handover use --sig \"stage()\" then \"record()\""
        "${NICE[@]}" forge script script/ActivateRewardCustody.s.sol --sig "record()" \
          --rpc-url "$rpc" \
          || fail "$slug: ActivateRewardCustody record() failed -- the activation broadcast but its record was NOT reconciled; run --sig \"record()\" again"
        info "[4c] $slug — reward custody ACTIVATED and recorded ✓ (the Diamond REMAINS PAUSED; fund forward with fundRewardPool after the unpause)"
      else
        info "[4c] $slug — reward custody NOT ACTIVATED: reward reads and debits stay on the Diamond path, and on a Canonical chain the delivered bound is received - paid (ZERO until funded) so reward claims and remittances are REFUSED until the ceremony runs. To activate: under the manual pause read the figures (recycleBucket, recovered - redispatched, strandedReturnOverage, and on a Mirror received - paid), state one answer per non-zero figure — PER CHAIN, suffixed _$(prefix_for "$slug"): REWARD_CUSTODY_FUND_<ROW>_<PREFIX> / REWARD_CUSTODY_RELOCATE_<ROW>_<PREFIX> with REWARD_CUSTODY_PROVENANCE_<PREFIX>, REWARD_CUSTODY_FUND_LIVE_FRESH_<PREFIX> or REWARD_CUSTODY_WRITE_DOWN_MIRROR_GAP_<PREFIX> on a Mirror — set REWARD_CUSTODY_PAUSE_EPOCH_<PREFIX> to the pause library's transition count under that pause and \$$act_var=true, then run this script again for this chain or ActivateRewardCustody.s.sol by hand (a Detached chain does not activate in this slice)"
        unactivated_chains="${unactivated_chains:+$unactivated_chains }$slug"
      fi ;;
    *) fail "$slug: rewardCustodyActivated() could not be read after the refresh ('${activated:-unreadable}') -- refusing to guess whether this chain's reward custody is activated; retry [4c] by hand once the RPC answers" ;;
  esac

  if [ "$SKIP_VAULT" -eq 0 ]; then
    banner "[5] $slug — UpgradeVaultImplementation (UUPS template)"
    "${NICE[@]}" forge script script/UpgradeVaultImplementation.s.sol --sig "run()" --ffi \
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
  # The auto-pause deadline is compared with CHAIN time — the latest block's
  # timestamp — never the host clock (Codex #2158 post-cap P2): a host ahead
  # of the chain would call a still-active window elapsed. Unreadable chain
  # time is UNKNOWN, not "restored".
  chain_ts="$(cast block latest -f timestamp --rpc-url "$rpc" 2>/dev/null | tr -d '[:space:]' || echo '')"
  case "$chain_ts" in ''|*[!0-9]*) chain_ts="" ;; esac
  if [ "${#hex_after}" -ne 64 ] || [ -z "$chain_ts" ]; then
    info "$slug: in-place redeploy complete -- pause state UNKNOWN (pause slot '${raw_after:-unreadable}', chain time '${chain_ts:-unreadable}'); verify with 'cast storage <diamond> $pause_slot' and the pause views before treating this chain as live"
    paused_chains="${paused_chains:+$paused_chains }$slug(unknown)"
  elif [ "${hex_after:62:2}" != "00" ]; then
    info "$slug: in-place redeploy complete -- the Diamond REMAINS PAUSED (manual): user operations stay disabled until a fresh Unpauser decision (AdminFacet.unpause()) once the migrations are verified; this run does not unpause"
    paused_chains="${paused_chains:+$paused_chains }$slug"
  elif dec_gt "$(cast to-dec "0x${hex_after:46:16}")" "$chain_ts"; then
    info "$slug: in-place redeploy complete -- the Diamond is under a watcher AUTO-PAUSE window until $(cast to-dec "0x${hex_after:46:16}") (unix): user operations stay disabled until it lapses or an Unpauser clears it; not ordinary completion"
    paused_chains="${paused_chains:+$paused_chains }$slug(auto-pause)"
  else
    info "$slug: in-place redeploy complete (service restored: the pause slot shows neither the manual flag nor a live auto-pause window)."
  fi
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

if [ -n "${paused_chains:-}" ]; then
  info "NOT LIVE after this run: [$paused_chains] -- a plain slug is under the manual pause it was refreshed under (resume by a fresh Unpauser decision, AdminFacet.unpause(), once its migrations are verified); '(auto-pause)' is under a watcher window; '(unknown)' could not be read and must be verified by hand. Not ordinary completion."
fi
if [ -n "${unactivated_chains:-}" ]; then
  info "REWARD CUSTODY NOT ACTIVATED on: [$unactivated_chains] -- reward reads and debits stay on the Diamond path there; a Canonical chain among them REFUSES reward claims and remittances until the activation ceremony (ActivateRewardCustody.s.sol, or this script with REWARD_CUSTODY_ACTIVATE_<PREFIX>=true and the per-row answers) has run. Not ordinary completion."
fi
banner "DONE"
