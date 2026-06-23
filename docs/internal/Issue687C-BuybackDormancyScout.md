# #687-C — confirm treasury buyback DORMANT + reconcile stakingPoolBuybackBudget (scout)

Third step of #687 (after #687-A sale, #687-B staking yield). Card #710.
Ratified design = **Option 2**: confirm buyback dormant for Phase 1; NO funding
path, NO new admin knob; kept reward budgets degrade gracefully to 0. PLUS the
#687-B follow-up: reconcile the now-vestigial `stakingPoolBuybackBudget`
buyback-overflow tier.

## Dormancy — CONFIRMED BY DESIGN (assert with tests, no code change needed)
Every buyback entry point is admin-gated + default-off:
- `creditBuybackBudget` (ADMIN_ROLE) — the only funding path; manual, per-token
  allow-list gated. No automated fee-accrual split funds it.
- `commitBuybackIntent` / `commitBuybackIntentValidated` (ADMIN_ROLE) — reserve
  from baseBuybackBudget; dormant until admin commits AND budget funded.
- `remitBuyback` (ADMIN_ROLE, mirror) — needs funded buybackBudget + destToken match.
- `absorbRemittance` — CCIP-receiver-gated (only BuybackRemittanceReceiver).
- `expireBuybackIntent` — permissionless but only releases reservations.
`rewardEmissionsBudget` + `keeperRewardBudget` are incremented ONLY by
`_routePriority` (on a buyback fill); both steps skip when target==0. So with no
admin action they stay 0 → degrade gracefully. `IntentDispatchFacet` is SHARED
with swap-to-repay (ORDER_KIND_SWAP_TO_REPAY) — KEEP it + the LOP allowance
aggregate + live-commit counter untouched.

## Overflow reroute — the concrete change (recommended: HARD-DISABLE/revert)
`LibTreasuryBuyback._routePriority` step 3 currently `s.stakingPoolBuybackBudget
+= remaining` (final overflow after rewards+keeper top-ups). The field is
WRITE-ONLY (only written there, read only by TreasuryFacet.getStakingPoolBuybackBudget;
no spend/decrement anywhere). Fix:
1. `LibTreasuryBuyback._routePriority`: replace step 3 with
   `if (remaining != 0) revert BuybackOverflowNotAllowed(delivered,toRewards,toKeepers,remaining);`
   (a buyback can't deliver more than the two top-up gaps absorb → no strand).
   NOTE: revert is atomic (undoes the LOP fill tx); only triggers on the misconfig
   case (committed buyback + both targets 0 + fill). Dormant config never hits it.
2. Add `error BuybackOverflowNotAllowed(uint256,uint256,uint256,uint256)` (IVaipakamErrors).
3. `LibVaipakam.sol` ~L3737: delete `uint256 stakingPoolBuybackBudget;` (pre-live, drop outright).
4. `TreasuryFacet`: delete `getStakingPoolBuybackBudget()` (~L869-877).
5. `BuybackPrioritySplit` event: drop the `toStaking`/4th param + its emit.
6. Deploy-sanity: DeployDiamond `_getTreasurySelectors` + HelperTest treasury
   selector list — drop `getStakingPoolBuybackBudget` (use move-tail-into-hole +
   shrink size, as in #687-B). SelectorCoverage will verify.
7. ABI re-export (TreasuryFacet.json drops the getter; every facet drops the new
   error? no — new error ADDED to IVaipakamErrors propagates to all facet ABIs).

## Tests (BuybackPriorityRouterTest.t.sol — extend)
- The existing "all to staking" / 3-tier cases reference stakingPoolBuybackBudget
  + getStakingPoolBuybackBudget → REWRITE to the 2-tier model (rewards→keeper) +
  assert overflow reverts BuybackOverflowNotAllowed.
- Add dormancy asserts: Base commit without funding reverts (budget insufficient);
  mirror remit on empty budget reverts.
- Check BuybackEndToEndIntegrationTest / TreasuryBuybackRemittanceTest for
  getStakingPoolBuybackBudget refs.

## Verify
forge build --skip test; targeted: BuybackPriorityRouterTest, BuybackEndToEnd*,
TreasuryBuyback*, SelectorCoverage, FacetSizeLimit, DeployDiamondIntegration.
predeploy-check (ABI). tsc all workspaces (no consumer of the getter — grep clean).
