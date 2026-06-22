# VPFI Securities-Feature Excision — Plan (#687)

**Status:** Plan — pending Codex review + owner ack on the supply-reallocation
question. Implementation follows as ordered sub-PRs once ratified.
**Cards:** #687 (code work-list) · #694 (research/roadmap) · #695
(`VPFITokenomicsRedesignResearch.md`).
**Author:** Vaipakam Developer Team · 2026-06-23.
**Scope:** the *tactical removal plan* — the **why/which/strategic** lives in
#694/#695; this doc is the **how/order/blast-radius** so the excision can be
executed (and reviewed) safely against the EIP-2535 Diamond.

> Engineering/risk analysis only — **not legal advice.** Securities-law framing
> is in #694; confirm with counsel before mainnet.

---

## 1. Goal

Reduce VPFI's mandatory legal surface to near-zero for an admin-controlled,
bootstrapped Phase-1 by **removing** the two highest securities-exposure features
and **confirming the third is dormant** — keeping VPFI a consumptive
fee-discount *utility* ("digital tools" anchor, #694 §7). Pre-mainnet, so removal
(not "disable + claim immutability") is the honest, cleaner path (#687 rationale).

| Feature | Disposition | Why |
|---|---|---|
| **A.** Issuer fixed-rate VPFI sale | **REMOVE** (permanent) | Issuer primary sale = classic Howey investment contract |
| **B.** 5% APR passive staking yield | **REMOVE** (permanent) | Fixed/passive yield = staking-as-a-service pattern |
| **C.** Treasury buyback-and-redistribute | **CONFIRM DORMANT** (don't delete) | Operator-activated; Phase-1 compliance = "don't configure/run it"; clean buyback-**burn** is a separate Phase-2 want (#694 child A) |

**Keep:** vault deposit/withdraw + the time-weighted fee-discount tiers
(`LibVPFIDiscount`), CCT bridging, future governance. **Distribution becomes**
earn (interaction rewards) + no-consideration airdrop + organic secondary market
(#694).

---

## 2. The load-bearing entanglement verdict (B)

**The fee-discount tier is independent of staking.** Verified
(`LibVPFIDiscount.sol`): `tierOf(vaultBal)` derives the tier purely from
`vaultVpfiBalance(user)` = `IERC20(vpfiToken).balanceOf(vault)` — it never reads
`userStakedVpfi`, `totalStakedVpfi`, or any staking accumulator. The
flash-stake-gaming guard (3-day gate + min-tier-over-history clamp) lives in the
**discount accumulator** (`VPFIDiscountAccumulatorFacet` ring buffer), **not** in
staking, so it is KEPT.

The **only** code coupling is two one-way notify-calls,
`LibStakingRewards.updateUser(borrower|lender, newStakedBal)` at
`LibVPFIDiscount.sol:576` and `:784` (inside `tryApplyBorrowerLif` /
`tryApplyYieldFee`), plus the `import {LibStakingRewards}`. These maintain
staking state on a VPFI-balance change; they do **not** feed the discount tier.
Removing them (with the `import`) alongside B is safe — the VPFI movement they
accompany still happens; only the staking notification disappears.

**⇒ B is a clean removal with the discount machinery fully retained.**

---

## 3. Per-feature blast radius

### A. Fixed-rate sale — REMOVE
- **Whole-file removals:** `crosschain/VpfiBuyAdapter.sol`,
  `crosschain/VpfiBuyReceiver.sol`, `crosschain/IVpfiBuyCcipMessages.sol`,
  `script/ConfigureVPFIBuy.s.sol`, `test/VpfiBuyFlowTest.t.sol`.
- **Partial-facet edit — `VPFIDiscountFacet.sol`:** remove the buy surface
  (`buyVPFIWithETH`, `processBridgedBuy`, `quoteFixedRateBuy`,
  `getVPFISoldToByChainId`, `setVPFIBuyRate`, `setVPFIBuyCaps`,
  `setVPFIBuyEnabled`, `setBridgedBuyReceiver`, `getBridgedBuyReceiver`,
  `getVPFIBuyConfig`) + their internal `_computeBuyAndDebitCaps`. **Keep**
  deposit/withdraw + all discount-tier code.
- **Storage (`LibVaipakam.sol`):** remove the `vpfiFixedRate*` cluster
  (`…WeiPerVpfi`, `…GlobalCap`, `…PerWalletCap`, `…TotalSold`, `…BuyEnabled`,
  the `…SoldToByChainId` mapping + the legacy mapping) + `bridgedBuyReceiver`.
  Confirm no other facet reads them (scout: none — purely transactional).
- **Deploy/sanity:** `DeployDiamond.s.sol` `_getVpfiDiscountSelectors()`
  (drop the buy selectors + fix the array size), `DeployCrosschain.s.sol`
  (drop the buy-adapter/receiver deploy+wiring), `test/deploy/DiamondFacetNames.sol`
  (facet-count: drop the 2 crosschain buy contracts if listed),
  `test/deploy/SelectorCoverageTest.t.sol` + `HelperTest.sol` (selector set).
- **ABI export:** `script/exportFrontendAbis.sh` — drop `VpfiBuyAdapter` +
  `VpfiBuyReceiver`; `VPFIDiscountFacet` stays (re-export, fewer selectors).
- **Frontend:** `/buy-vpfi` (marketing) + `/app/buy-vpfi` (connected) pages.
- **Docs/allocation:** TokenomicsTechSpec §8/§8a + the §3 "Early Fixed-Rate
  Purchase Program" 1% (2.3M) row (see §6 reallocation).

### B. 5% APR staking yield — REMOVE (discount tiers KEPT)
- **Whole-file removals:** `facets/StakingRewardsFacet.sol`,
  `libraries/LibStakingRewards.sol`, `test/StakingAndInteractionRewardsTest.t.sol`,
  `test/StakingRewardsCoverageTest.t.sol`,
  `test/invariants/StakingBalances.invariant.t.sol` (+ any
  staking-monotonicity invariant).
- **`LibVPFIDiscount.sol`:** remove the two `LibStakingRewards.updateUser(...)`
  calls (L576/L784) + the `import` (the §2 verdict — no tier impact).
- **Storage/constants (`LibVaipakam.sol`):** remove `VPFI_STAKING_APR_BPS`,
  `VPFI_STAKING_POOL_CAP`, `STAKING_APR_BPS_MAX`, the `vpfiStakingAprBps` config
  field, and the staking storage (`totalStakedVpfi`, `stakingLastUpdateTime`,
  `stakingRewardPerTokenStored`, `userStakedVpfi`,
  `userStakingRewardPerTokenPaid`, `userStakingPendingReward`,
  `stakingPoolPaidOut`).
- **`ConfigFacet.sol`:** remove `setStakingApr` + its bound + any
  `getStakingAprBps`/`getConfig` staking field.
- **Deploy/sanity:** `DeployDiamond.s.sol` `_getStakingRewardsSelectors()`
  (delete the function + its cut entry), `DiamondFacetNames.sol`
  (drop `StakingRewardsFacet`), `SelectorCoverageTest.t.sol`, `HelperTest.sol`,
  `SetupTest.t.sol` (drop the staking facet import + cut + setup).
- **ABI export:** drop `StakingRewardsFacet`.
- **Frontend:** `/staking` pages + staking/yield/APR widgets + claim UI.
- **Docs/allocation:** TokenomicsTechSpec §7/§12.1 + whitepaper §12.1 + overview
  "5% annual yield" copy + the §3 Staking-Rewards 24% (55.2M) row (see §6).

### C. Treasury buyback — CONFIRM DORMANT (do NOT delete)
- **Dormancy (verified):** `remitBuyback` reverts `BuybackTokenNotAllowed`
  (no allowed token) / `InsufficientBuybackBudget` (budget 0) until the operator
  sets an allowed token **and** funds the budget. **No script calls
  `setBuybackAllowedToken` or `creditBuybackBudget`.** Nuance:
  `ConfigureCcip.s.sol` (`_wireDiamondBuybackConfig`) *does* wire the messenger +
  `setBuybackRemittanceReceiver` (canonical) — wiring the pipe, not opening the
  valve. With no allowed-token + no funded budget, nothing flows.
- **Phase-1 action (minimum):** keep it dormant — assert no
  allowed-token/budget/intent activation in any deploy/config path; the
  staker-yield target (`stakingPoolBuybackBudget`) is severed *with B* (it's the
  3rd priority-router step). Decide whether to also drop the `ConfigureCcip`
  receiver-wiring for Phase-1 cleanliness (optional — harmless while the valve
  is shut).
- **Kept budgets:** `rewardEmissionsBudget` + `keeperRewardBudget` are the
  priority-router steps 1–2 and survive; they're fundable by direct operator
  `creditBuybackBudget`/top-up targets independent of the buyback engine running
  (the cascade comment in `LibVaipakam.sol` drops from 3-step → 2-step once B
  removes `stakingPoolBuybackBudget`).
- **Shared surface — do NOT remove:** `IntentDispatchFacet` is shared by
  swap-to-repay **and** buyback (`ORDER_KIND_BUYBACK` branch); leave the facet.
  Full buyback code removal (`LibTreasuryBuyback`, `LibBuybackOrderValidation`,
  `BuybackRemittanceReceiver`, TreasuryFacet buyback selectors) is an
  **optional later task**, not Phase-1.

---

## 4. Removal order (ordered sub-PRs) + shared-surface coordination

A, B, C touch a few shared files — the single `LibVaipakam.Storage` struct, the
deploy-sanity pair (`DiamondFacetNames.sol` + `SelectorCoverageTest.t.sol`), and
`exportFrontendAbis.sh` — so each sub-PR must update those in lockstep, but the
features are otherwise independent and ship as **separate reviewable PRs**:

1. **PR-A — remove fixed-rate sale.** Self-contained; biggest cross-chain
   surface. Targeted tests: `VPFIDiscountFacetTest` (buy cases removed,
   deposit/withdraw/discount green) + deploy-sanity (`SelectorCoverageTest`,
   `FacetSizeLimit`) + `VPFISupplyCap.invariant`.
2. **PR-B — remove staking yield.** Depends on nothing in PR-A but both edit
   `LibVaipakam` storage + the sanity pair, so **sequence B after A** to avoid a
   storage-struct merge conflict. Targeted tests: discount suites (prove tiers
   intact), deploy-sanity, `VPFISupplyCap.invariant`; delete the staking
   invariants.
3. **PR-C — buyback-dormancy assertion.** Smallest: the 3-step→2-step cascade
   comment + (optional) drop the `ConfigureCcip` receiver-wiring + a
   deploy-sanity/test assertion that buyback is unconfigured. No facet/ABI change
   if kept dormant.

Each PR carries its own ABI re-export (frontend/keeper/indexer per the CLAUDE.md
sync rules), release-note fragment, and FunctionalSpecs update (per-PR
conventions).

---

## 5. Deploy-sanity & invariant impact

- **Selector coverage:** PR-A and PR-B both change the routed selector set →
  update `DeployDiamond.s.sol` selector getters + `SelectorCoverageTest` +
  `DiamondFacetNames` + `HelperTest` together (the per-CLAUDE.md "add/remove a
  facet function" rule, in reverse).
- **Facet size (EIP-170):** strictly shrinks — no risk.
- **Supply-cap invariant (`VPFISupplyCap.invariant.t.sol`):** the 230M hard cap
  is enforced by the token's `ERC20Capped`; removing the sale/staking **mint
  paths** doesn't change the cap assertion logic. The invariant stays valid;
  only the staking-pool-specific invariants (`StakingBalances.invariant`) are
  deleted. **But see §6** — if the cap is *reduced* to reflect the freed pools,
  the invariant's cap constant changes.

---

## 6. Supply reallocation — **OWNER ACK NEEDED**

Removing A frees the **1%** (2.3M) sale pool; removing B frees the **24%**
(55.2M) staking pool; the **12%** market-making allocation is doc-only (no code).
Three options for the freed 37% (and the doc-only 12%):

1. **Reduce the 230M cap** by the freed amounts (cleanest "no idle reserve"
   story; changes the cap constant + the supply-cap invariant + every allocation
   doc).
2. **Reallocate** to the kept earn-based pools (interaction-rewards / airdrop) —
   keeps 230M, shifts the table.
3. **Park** the freed pools unminted (cap stays 230M, allocation table shows them
   as "retired/unallocated").

Recommendation: **(1) reduce the cap** — it most strongly supports the
minimal-legal "no issuer-controlled idle treasury for price support" narrative
(#694 §6 decentralization). This is a tokenomics decision the owner must make
before the docs/allocation rows are finalized; the *code* removals (A/B) don't
block on it (they remove the mint paths regardless).

---

## 7. Frontend / keeper / indexer / docs / marketing sweep

- **Frontend pages:** `/buy-vpfi`, `/app/buy-vpfi`, `/staking` + staking/yield
  widgets, claim UI — remove.
- **ABI consumers:** re-export per CLAUDE.md; drop the 3 removed
  facets/contracts from the frontend bundle, and prune any keeper/indexer
  handlers for removed events (buy-flow + staking-claim).
- **Docs:** TokenomicsTechSpec (§3 allocation, §7 staking, §8 sale, §12.1),
  whitepaper, overview, ToS — strip sale + "5% APR / passive yield" + any
  profit/appreciation/price language (the #694 marketing rule: **no
  yield/APR/profit framing anywhere**).
- **FunctionalSpecs:** update the VPFI/tokenomics domain doc to the
  utility-only intended behaviour.

---

## 8. Acceptance criteria (from #687)

- [ ] Fixed-rate sale removed; build + targeted tests green.
- [ ] 5% APR staking yield removed; fee-discount tiers retained + tested.
- [ ] Buyback confirmed dormant for Phase-1 (no activation path); staker-yield
  target removed with B.
- [ ] ABI bundles re-exported (frontend/keeper/indexer); typechecks pass.
- [ ] Frontend buy + staking pages + all "5% APR / passive yield / fixed-rate
  sale" copy removed.
- [ ] TokenomicsTechSpec / whitepaper / overview / ToS updated; supply allocation
  reconciled per the §6 owner decision.
- [ ] Release-note fragment + FunctionalSpecs update in each PR.
- [ ] Deploy-sanity suite updated (DiamondFacetNames + SelectorCoverage) for the
  removed facets/selectors.

---

## 9. Open owner-acks (parallel; don't block the A/B code removals)

1. **Supply reallocation** (§6) — reduce cap vs reallocate vs park.
2. **Child-card split** (#694 A/B/C/D) — confirm; decide whether to fold the
   interaction-reward "de-APR" hardening (child C) into this work or a follow-up.
3. **Optional frontend US/EEA geoblock** — a one-time business call, NOT a
   dependency of these removals (#687 notes geofencing is moot once sale+yield
   are gone).
4. **One-time bounded legal-classification review** (home jurisdiction + US) —
   counsel, external.

---

## 10. References

- #687 (code work-list, anchors), #694 (research/roadmap + locked decisions),
  #695 / [`VPFITokenomicsRedesignResearch.md`](VPFITokenomicsRedesignResearch.md).
- Code: `facets/VPFIDiscountFacet.sol`, `libraries/LibVPFIDiscount.sol`
  (tier=balance, §2 verdict), `facets/StakingRewardsFacet.sol` +
  `libraries/LibStakingRewards.sol`, `crosschain/VpfiBuy{Adapter,Receiver}.sol`,
  `facets/TreasuryFacet.sol` + `libraries/LibTreasuryBuyback.sol`,
  `facets/IntentDispatchFacet.sol` (shared — keep), `libraries/LibVaipakam.sol`
  (storage), `script/DeployDiamond.s.sol` + `test/deploy/*` (selector sanity),
  `test/invariants/VPFISupplyCap.invariant.t.sol`.
