# #687-B — remove the VPFI 5% staking yield (scout / execution checklist)

Second step of #687 (after #687-A fixed-rate sale, PR #711 merged). REMOVE the
5% APR staking yield (securities surface); KEEP the balance-based fee-discount
tiers AND interaction rewards.

**KEY FINDING — ZERO ENTANGLEMENT.** Discount tiers are 100% balance-based
(`LibVPFIDiscount.tierOf(vaultBalance)` / `rollupUserDiscount`), staking yield is
separate accrual bookkeeping (`userStakedVpfi` / `stakingRewardPerTokenStored` /
`userStaking*`). Every vault-mutation site dual-stamps `rollupUserDiscount` AND
`LibStakingRewards.updateUser` on independent storage — deleting the staking call
leaves the discount rollup intact. Interaction rewards (`InteractionRewardsFacet`)
are separate and KEPT. Pre-live → delete storage fields outright (fresh redeploy).

## Whole-file deletes
- `contracts/src/facets/StakingRewardsFacet.sol` (9 selectors: claimStakingRewards,
  previewStakingRewards, getUserStakedVPFI, getTotalStakedVPFI, getStakingPoolRemaining,
  getStakingPoolPaidOut, getStakingAPRBps, getStakingSnapshot,
  getStakingRewardPerTokenStored; event StakingRewardsClaimed)
- `contracts/src/libraries/LibStakingRewards.sol` (currentRewardPerToken,
  checkpointGlobal, updateUser, pendingOf, debitClaim, poolRemaining)
- `contracts/test/StakingRewardsCoverageTest.t.sol`
- `contracts/test/invariants/StakingRewardMonotonicity.invariant.t.sol`
- `contracts/test/invariants/StakingBalances.invariant.t.sol`  (VERIFY exact names)
- `apps/defi/src/components/app/StakingRewardsClaim.tsx`
- `apps/defi/src/hooks/useStakingRewards.ts`, `apps/defi/src/hooks/useStakingApr.ts`
- `packages/contracts/src/abis/StakingRewardsFacet.json`

## Delete the 6 `LibStakingRewards.updateUser` / checkpoint call sites (all SAFE)
- `LibVPFIDiscount.sol` L576 (tryApplyBorrowerLif), L784 (tryApplyYieldFee) — keep the
  adjacent `rollupUserDiscount`.
- `VPFIDiscountFacet.sol` L304 (depositVPFIToVault), L387 (withdrawVPFIFromVault) — keep rollup.
- `LenderIntentFacet.sol` L410 — keep rollup.
- `LibConsolidation.sol` L417/L418/L441 — keep rollups.
- `ConfigFacet.sol` L932 `checkpointGlobal()` inside `setStakingApr()` — delete the whole setter.
(Line numbers pre-#687-B; re-grep `LibStakingRewards` before editing.)

## LibVaipakam.sol storage (staking-yield-only, delete)
`stakingRewardPerTokenStored`, `stakingLastUpdateTime`, `totalStakedVpfi`,
`stakingPoolPaidOut`, `userStakedVpfi`, `userStakingRewardPerTokenPaid`,
`userStakingPendingReward` (~L2467-2473), `stakingPoolBuybackBudget` (~L3758),
+ the `cfgVpfiStakingAprBps()` helper + staking APR constant/default. KEEP all
`vpfiDiscount*` + interaction-reward + accumulator storage.

## ConfigFacet.sol
Delete `setStakingApr()`, `getStakingAprBps()`, the `vpfiStakingAprBps` field from
`getProtocolConfigBundle()` tuple (+ its assignment), error `InvalidStakingAprBps`,
event `StakingAprSet`. Decide on `getProtocolConstants()` `vpfiStakingPoolCap` —
scout suggested KEEP as informational, but for a clean excision prefer REMOVE
(no dormant staking surface). VERIFY callers of the bundle tuple shape.

## Other contracts
- `MetricsDashboardFacet.sol`: remove the `previewStakingRewards` try-read +
  `stakingRewardsPending` struct field.
- `TestMutatorFacet.sol`: remove staking setters/getters (setStakingPoolPaidOut,
  getStakingRPTStored, getStakingLastUpdateTime, getUserStakingPaid, getUserStakingPending).
- `IVaipakamErrors.sol`: delete `NoStakingRewardsToClaim`, `StakingPoolExhausted`
  (keep VPFITokenNotSet — shared).

## Deploy-sanity (lockstep)
- `DeployDiamond.s.sol`: drop import, instantiation, `cuts[24]` assignment (renumber!),
  log line, `_getStakingRewardsSelectors()`.
- `DiamondFacetNames.sol`: drop `"StakingRewardsFacet"`.
- `HelperTest.sol`: drop import + `getStakingRewardsFacetSelectors()`.
- `SetupTest.t.sol`: drop the StakingRewardsFacet cut if present.
- SelectorCoverageTest auto-checks.

## Tests
- `StakingAndInteractionRewardsTest.t.sol`: MIXED — delete the staking-yield cases
  (testStakingAccrues…/Claim…/Withdraw…), KEEP the interaction cases. Consider
  renaming to InteractionRewardsTest.
- `ConfigFacetTest.t.sol`: drop setStakingApr/getStakingAprBps cases.

## ABI re-export + frontend (the #687-A coupling applies again)
- Re-run `exportFrontendAbis.sh` (drops StakingRewardsFacet.json + every facet's
  staking errors from its ABI). predeploy-check [4/4] will FAIL until the orphan
  StakingRewardsFacet.json is deleted + barrel pruned (`index.ts` import/export/spread).
- `BuyVPFI.tsx`: remove `useStakingApr`/`StakingRewardsClaim` import + render + the
  `{{apr}}` interpolations; KEEP deposit/withdraw/discount-tier UI.
- `RewardsSummaryCard.tsx`: remove staking fields, keep interaction.
- i18n en.json: delete the `stakingRewards` object + neutralize `{{apr}}` staking
  mentions in buyVpfiOverview/DiscountStatus/rewards* keys; delete those keys from
  the 9 non-en locales (fallbackLng:en). Watch for RENDERED vs orphan (the #687-A
  lesson — grep rendered t() keys, do a comprehensive sweep to avoid the Codex
  copy-treadmill).
- keeper-bot: ConfigFacet ABI changes → sync sibling repo (warnings-only).

## Verify
`forge build` + SelectorCoverage/FacetSizeLimit + targeted suites; predeploy-check
[4/4] green; `pnpm tsc` for @vaipakam/{defi,agent,www,keeper,indexer}; grep zero for
staking-yield symbols (claimStakingRewards/previewStakingRewards/getStakingAPRBps/
useStakingApr/StakingRewardsClaim/LibStakingRewards/updateUser).
