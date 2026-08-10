#!/usr/bin/env bash
#
# rehearse-partial-refresh.sh — #1649 upgrade rehearsal on a local chain.
#
# WHY THIS EXISTS
#
# #1503 gave both lender-exit sale paths a cross-facet call to
# `RiskPreviewFacet.saleAdmission`. The two CURATED partial-refresh scripts
# each reinstall one of the facets that makes that call:
#
#   RedeployFacets      -> EarlyWithdrawalFacet (direct sale + listing creation)
#   ReplaceStaleFacets  -> OfferAcceptFacet     (the binding listing accept)
#
# Run either against an existing Diamond that predates #1503 and, before the
# fix, you got the worst outcome available: the new sale bytecode live, calling
# a selector nothing routes, so every sale reverted `FunctionDoesNotExist`
# through the Diamond fallback. A `forge build` cannot see this — the call is
# assembled from a selector at runtime — which is exactly why the fix is
# rehearsed against a real chain rather than signed off on a clean compile.
#
# `test/deploy/PartialRefreshRoutingTest` pins the same property inside
# `forge test` and is the CI gate. This script is the belt to that suspenders:
# it exercises the scripts the way an operator actually invokes them —
# `forge script --broadcast` against a live node, reading the Diamond address
# from `deployments/anvil/addresses.json`, with real transactions and real
# nonces — and then drives an actual sale to completion.
#
# WHAT IT DOES
#
#   1. Fresh anvil (chain-id 31337) + full `anvil-bootstrap.sh` playground.
#   2. Reduces that Diamond to the pre-#1503 shape by REMOVING `saleAdmission`.
#   3. Asserts the break: the script's mapped sale scenario must fail there,
#      and the failure
#      must be the routing one. Without this step the rehearsal could "pass"
#      against a fixture that was never broken.
#   4. Runs the refresh script under test with `--broadcast`.
#   5. Asserts every `RiskPreviewFacet` selector routes, and all to ONE host —
#      a partition bug that split them across old and new addresses would leave
#      the Diamond routed but running two builds of the same facet.
#   6. Drives that same scenario with `--broadcast`: a real sale refused under its
#      floor, then the SAME sale settling once the price recovers.
#
# USAGE
#
#   bash contracts/script/rehearse-partial-refresh.sh                  # both scripts
#   bash contracts/script/rehearse-partial-refresh.sh RedeployFacets   # just one
#
# Each script gets its own fresh anvil, because step 2 mutates the Diamond and
# step 4 spends nonces; sharing one chain between two refresh runs would test
# the second against a Diamond the first already fixed.
#
# The keys below are Foundry's default mnemonic accounts — public knowledge,
# never usable on a real network. This script refuses any chain but 31337.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$CONTRACTS_DIR"

RPC="${ANVIL_RPC_URL:-http://localhost:8545}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null || true' EXIT

# Anvil's standard prefunded accounts.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ADMIN_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
ADMIN_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# `saleAdmission(uint256)`. Hard-coded rather than derived so a rename shows up
# here as a loud failure instead of silently rehearsing a selector that is no
# longer the one the sale paths call.
SALE_ADMISSION_SEL=0x2c87c1a3

# The full RiskPreviewFacet surface, in `FacetSelectors.riskPreview()` order.
# `RedeploySelectorParityTest` pins that list against the compiled ABI, so this
# is the same set the refresh scripts cut.
RISK_PREVIEW_SELECTORS=(
  0x52138660  # previewOfferAcceptBlock
  0x5744d07f  # assertMatchAllowed
  0x7b198f9a  # previewMatchRiskBlock
  0x012c433a  # assertObligationTransferAllowed
  0x978e1471  # acceptMidTierAckPair
  0x314efc12  # previewCreatorBlock
  0xa7aaae7f  # previewIntent
  0x2c87c1a3  # saleAdmission
)

# KNOWN FAILURE — ReplaceStaleFacets currently fails at step 6, and the failure
# is REAL, not a flaw in this script. Once the rehearsal was pointed at the
# listing-accept branch this script actually refreshes (N26, per the mapping
# below), the post-refresh sale reverted `ERC721InsufficientApproval` from inside
# `completeLoanSaleInternal`. The same scenario passes on a chain that has NOT
# been partially refreshed, and it fails identically against the pre-#1649
# version of the refresh script, so it predates the routing work and is not
# caused by it. Tracked as #1659 with the full trace. Do not "fix" this by
# pointing the rehearsal back at N25 — that is precisely the blind spot that hid
# the defect (Codex #1635 r5).
fail() { echo "REHEARSAL FAILED: $*" >&2; exit 1; }
step() { echo; echo "--- $*"; }

# The scenario-driver env. ONLY_SCENARIO skips the earlier scenarios, which
# matters because the flow script cannot currently reach its broadcast pass from
# the top (#1646, pre-existing).
#
# WHICH scenario is chosen per refresh script, and that is load-bearing (Codex
# #1635 r5). Each script reinstalls a DIFFERENT guarded sale path, and a
# scenario that does not traverse the path a given script refreshes would stay
# green with that script's guard broken or dropped:
#
#   RedeployFacets     -> EarlyWithdrawalFacet -> N25 (direct sellLoanViaBuyOffer)
#   ReplaceStaleFacets -> OfferAcceptFacet     -> N26 (resting-listing accept)
#
# Rehearsing ReplaceStaleFacets against N25 was exactly that mistake: N25's only
# acceptOffer call originates an ordinary loan and never reaches the sale branch.
export DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY"
export ADMIN_PRIVATE_KEY="$ADMIN_KEY"
export ADMIN_ADDRESS="$ADMIN_ADDR"
export LENDER_PRIVATE_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
export LENDER_ADDRESS=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
export BORROWER_PRIVATE_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
export BORROWER_ADDRESS=0x90F79bf6EB2c4f870365E785982E1f101E93b906
export NEW_LENDER_PRIVATE_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
export NEW_LENDER_ADDRESS=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
export NEW_BORROWER_PRIVATE_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
export NEW_BORROWER_ADDRESS=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc

start_anvil() {
  pkill -f 'anvil --chain-id 31337' 2>/dev/null || true
  # Give the OS a moment to release the port before rebinding it.
  until ! curl -s -X POST -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" >/dev/null 2>&1; do
    sleep 1
  done
  anvil --chain-id 31337 --silent > "$WORKDIR/anvil.log" 2>&1 &
  ANVIL_PID=$!
  until curl -s -X POST -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "$RPC" >/dev/null 2>&1; do
    sleep 1
  done
  local chain
  chain=$(cast chain-id --rpc-url "$RPC")
  [ "$chain" = "31337" ] || fail "expected chain-id 31337, got $chain"
}

# Every RiskPreviewFacet selector routed, and all to the same host.
assert_risk_preview_routed() {
  local diamond="$1" host="" addr
  for sel in "${RISK_PREVIEW_SELECTORS[@]}"; do
    addr=$(cast call "$diamond" "facetAddress(bytes4)(address)" "$sel" --rpc-url "$RPC")
    [ "$addr" != "0x0000000000000000000000000000000000000000" ] \
      || fail "$sel unrouted after refresh"
    if [ -z "$host" ]; then
      host="$addr"
    elif [ "$addr" != "$host" ]; then
      fail "RiskPreviewFacet split across hosts: $sel -> $addr, expected $host"
    fi
  done
  echo "    all ${#RISK_PREVIEW_SELECTORS[@]} selectors -> $host"
}

# Which scenario exercises the sale path each script refreshes.
scenario_for() {
  case "$1" in
    RedeployFacets) echo N25 ;;
    ReplaceStaleFacets) echo N26 ;;
    *) fail "no sale scenario mapped for $1 - add one rather than reusing another script's" ;;
  esac
}

rehearse() {
  local refresh_script="$1"
  local scen
  scen="$(scenario_for "$refresh_script")"
  echo
  echo "================================================================"
  echo "  Rehearsing: $refresh_script"
  echo "================================================================"

  step "1/6  fresh anvil + bootstrap"
  start_anvil
  # forge's per-script broadcast cache keys on chain id, so a previous run's
  # nonces would be replayed against this brand-new chain.
  rm -rf "broadcast/$refresh_script.s.sol/31337" \
         "cache/$refresh_script.s.sol/31337" \
         broadcast/AnvilNewPositiveFlows.s.sol/31337 \
         cache/AnvilNewPositiveFlows.s.sol/31337
  bash script/anvil-bootstrap.sh > "$WORKDIR/bootstrap.log" 2>&1 \
    || { tail -30 "$WORKDIR/bootstrap.log"; fail "anvil-bootstrap failed"; }

  local diamond
  diamond=$(jq -r .diamond deployments/anvil/addresses.json)
  [ -n "$diamond" ] && [ "$diamond" != "null" ] || fail "no diamond in addresses.json"
  echo "    diamond: $diamond"

  step "2/6  reduce to the pre-#1503 shape (remove saleAdmission)"
  # Post-handover the Diamond owner is the ADMIN account, not the deployer.
  cast send "$diamond" "diamondCut((address,uint8,bytes4[])[],address,bytes)" \
    "[(0x0000000000000000000000000000000000000000,2,[$SALE_ADMISSION_SEL])]" \
    0x0000000000000000000000000000000000000000 0x \
    --private-key "$ADMIN_KEY" --rpc-url "$RPC" > /dev/null
  local routed
  routed=$(cast call "$diamond" "facetAddress(bytes4)(address)" \
    "$SALE_ADMISSION_SEL" --rpc-url "$RPC")
  [ "$routed" = "0x0000000000000000000000000000000000000000" ] \
    || fail "saleAdmission still routed to $routed - fixture did not take"
  echo "    saleAdmission unrouted"

  step "3/6  assert the break: $scen's sale must fail for the ROUTING reason"
  if ONLY_SCENARIO="$scen" forge script script/AnvilNewPositiveFlows.s.sol \
       --rpc-url "$RPC" > "$WORKDIR/pre.log" 2>&1; then
    fail "$scen succeeded on the pre-#1503 fixture - the break was not reproduced"
  fi
  grep -q "FunctionDoesNotExist" "$WORKDIR/pre.log" \
    || { tail -30 "$WORKDIR/pre.log"; fail "$scen failed, but not with FunctionDoesNotExist"; }
  echo "    sale reverted FunctionDoesNotExist, as the finding describes"

  step "4/6  run $refresh_script --broadcast"
  # The script broadcasts the diamondCut, so its signer must be the Diamond
  # owner; post-handover that is the admin key.
  DEPLOYER_PRIVATE_KEY="$ADMIN_KEY" \
    forge script "script/$refresh_script.s.sol" --rpc-url "$RPC" --broadcast \
      > "$WORKDIR/refresh.log" 2>&1 \
    || { tail -30 "$WORKDIR/refresh.log"; fail "$refresh_script broadcast failed"; }
  grep -E "RiskPreview selectors" "$WORKDIR/refresh.log" || true

  step "5/6  assert routing"
  assert_risk_preview_routed "$diamond"

  step "6/6  drive a real sale: $scen --broadcast"
  ONLY_SCENARIO="$scen" forge script script/AnvilNewPositiveFlows.s.sol \
    --rpc-url "$RPC" --broadcast > "$WORKDIR/post.log" 2>&1 \
    || { tail -30 "$WORKDIR/post.log"; fail "$scen broadcast failed after refresh"; }
  grep -q "$scen PASSED" "$WORKDIR/post.log" \
    || { tail -30 "$WORKDIR/post.log"; fail "$scen did not report PASSED"; }
  grep -q "ONCHAIN EXECUTION COMPLETE" "$WORKDIR/post.log" \
    || { tail -30 "$WORKDIR/post.log"; fail "$scen simulated but did not execute on chain"; }
  echo "    sale refused under its floor, then settled once recovered - on chain"

  kill "$ANVIL_PID" 2>/dev/null || true
  ANVIL_PID=""
  echo
  echo "  ✅ $refresh_script: rehearsal passed"
}

TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=(RedeployFacets ReplaceStaleFacets)
fi

for t in "${TARGETS[@]}"; do
  rehearse "$t"
done

echo
echo "All rehearsals passed: ${TARGETS[*]}"
