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
(`LibVPFIDiscount.sol`): the tier derives from the user's vault VPFI **balance**,
not from staking. The *raw* getter `tierOf(vaultBal)` reads
`vaultVpfiBalance = IERC20(vpfiToken).balanceOf(vault)`; the **effective** fee
eligibility actually used at fee time is `effectiveTierAndBps`, which goes through
the **discount accumulator/cache** and is stamped from **protocol-tracked /
clamped** balances (`trackedVpfiBalance`, so direct-transfer dust is excluded).
Neither path reads `userStakedVpfi`, `totalStakedVpfi`, or any staking
accumulator. The flash-stake-gaming guard (3-day gate + min-tier-over-history
clamp) lives in the **discount accumulator** (`VPFIDiscountAccumulatorFacet` ring
buffer), **not** in staking. **Kept surface = the deposit/withdraw + the FULL
discount path: `tierOf`, `effectiveTierAndBps`, the accumulator/cache readers, and
the tracked-balance stamping** — an implementation that preserves only the raw
getter while dropping the accumulator/cache path would break real discounts.

There are **two distinct couplings B must handle** (the scout's "only 2 calls in
`LibVPFIDiscount`" was incomplete — see §3.B for the full caller list):

1. **Staking notify-calls (removed with B, no tier impact).**
   `LibStakingRewards.updateUser(...)` is called from **6 sites across the tree**
   (not 2) — they maintain staking state on a VPFI-balance change and do **not**
   feed the discount tier; all are deleted alongside `LibStakingRewards`.
2. **⚠️ P1 — the VPFI *price anchor* is SHARED with the kept discount quoting.**
   `LibVPFIDiscount._feeAssetWeiToVpfi` reads `s.vpfiFixedRateWeiPerVpfi` to
   convert a fee (in the principal asset) into a VPFI amount for the
   borrower/lender discount. That field is part of the **sale (A)** cluster — so
   **A must NOT delete `vpfiFixedRateWeiPerVpfi` / `setVPFIBuyRate` outright.** It
   must **split** the price anchor out of the buy surface: keep an admin-set VPFI
   price config (rename e.g. `vpfiDiscountWeiPerVpfi` + a `setVPFIDiscountRate`
   setter) and remove only the buy counters/caps/enable. Deleting it with the
   sale would make discounts un-quotable (`canQuote=false`).

**⇒ B's tier logic is a clean removal (discount machinery fully retained), but A
must split the shared price anchor — it is not a pure sale-only deletion.**

---

## 3. Per-feature blast radius

> **The per-feature lists below are ILLUSTRATIVE, not an exhaustive symbol
> inventory.** The removal is **grep-driven and tool-verified**: for every removed
> symbol / storage field / mapping / selector / route / ABI / copy string, the
> implementer runs `rg` across `contracts/`, `apps/`, `packages/`, `docs/` to find
> **all** references and removes/retargets each. The backstops that make
> "no consumer missed" guaranteed-by-construction (not by list-completeness):
> `forge build` (compile), the **deploy-sanity suite** (`SelectorCoverageTest` +
> `DiamondFacetNames`), and the frontend/agent **`tsc` typecheck** (after ABI
> re-export). A green run across all three ⇒ no dangling consumer.
>
> **Non-obvious consumers surfaced in review (fold into the sweep — still not a
> closed set):** `ConfigFacet.getStakingAprBps` (+ `ReplaceStaleFacets.s.sol`,
> `ConfigBounds.invariant`, `protocolConsoleKnobs.ts`); the `cfgVpfiFixedGlobalCap()`/
> `cfgVpfiFixedWalletCap()` helper readers + their constants; the separate
> `setVPFIDiscountETHPriceAsset` selector + `vpfiDiscountEthPriceAsset` (the
> renamed discount-config flow MUST still set it, else `canQuote=false`);
> `setVPFIBuyRate` used by KEPT discount tests (`CrossChainTierPropagationIntegrationTest`,
> `VPFIDiscountTimeWeightedTest`) → repoint to `setVPFIDiscountRate`; the buy keys
> in `@vaipakam/contracts` `deployments.json`/`chain-config.ts` +
> `apps/defi/src/contracts/config.ts` (`vpfiBuyAdapter`/`vpfiBuyPaymentToken`) +
> `script/lib/Deployments.sol`; `apps/agent/src/index.ts` scheduling
> `runBuyWatchdog` every cron tick (+ wrangler comments); the buyback dormancy
> assertion must include **`commitBuybackIntentValidated`** (a second commit
> selector) alongside `commitBuybackIntent`; `test/mocks/TestMutatorFacet.sol`
> (shared mock) reads/writes the staking slots; the `/buy-vpfi` + `#staking-rewards`
> **deep-links** across nav/CTA/consent/create-offer/reward anchors/PWA manifests;
> and the **localized i18n + Basic/Advanced user-guide copy** (`apps/www/src/content`,
> `apps/defi/src/i18n`) still carrying "5% APR" / staking-claim / fixed-rate-buy
> language.

### A. Fixed-rate sale — REMOVE
- **Whole-file removals:** `crosschain/VpfiBuyAdapter.sol`,
  `crosschain/VpfiBuyReceiver.sol`, `crosschain/IVpfiBuyCcipMessages.sol`,
  `script/ConfigureVPFIBuy.s.sol`, `test/VpfiBuyFlowTest.t.sol`.
- **Partial-facet edit — `VPFIDiscountFacet.sol`:** remove the buy surface
  (`buyVPFIWithETH`, `processBridgedBuy`, `quoteFixedRateBuy`,
  `getVPFISoldToByChainId`, **`getVPFISoldTo(address)`** (also reads the
  `vpfiFixedRateSoldToByChainId` mapping — drop with it), `setVPFIBuyRate`,
  `setVPFIBuyCaps`, `setVPFIBuyEnabled`, `setBridgedBuyReceiver`,
  `getBridgedBuyReceiver`, `getVPFIBuyConfig`) + their internal
  `_computeBuyAndDebitCaps`. **Keep** deposit/withdraw + all discount-tier code.
  **Add a discount-config READER** to replace `getVPFIBuyConfig`'s role: today it
  is the only public reader of the VPFI price anchor + `vpfiDiscountEthPriceAsset`,
  which operators/frontends need to verify (unset ⇒ `_feeAssetWeiToVpfi`
  `canQuote=false` ⇒ discounts silently fall back to full fees). So the split
  keeps a `getVPFIDiscountConfig` getter (carried through selectors/ABI/consumers)
  alongside the `setVPFIDiscountRate` setter.
- **Storage (`LibVaipakam.sol`):** remove the buy *counters/caps/enable*
  (`…GlobalCap`, `…PerWalletCap`, `…TotalSold`, `…BuyEnabled`, the
  `…SoldToByChainId` mapping + the legacy mapping) + `bridgedBuyReceiver`.
  **⚠️ DO NOT delete `vpfiFixedRateWeiPerVpfi`** — the kept discount quoting
  (`_feeAssetWeiToVpfi`) reads it (§2 finding). **Split it out**: rename to a
  discount-price config (e.g. `vpfiDiscountWeiPerVpfi`) with a retained
  `setVPFIDiscountRate` admin setter, and repoint `_feeAssetWeiToVpfi` at it.
  (This is the one piece of A that is a *rename/retain*, not a delete.)
- **Deploy/sanity + scripts (wider than first scoped):**
  `DeployDiamond.s.sol` `_getVpfiDiscountSelectors()` (drop the buy selectors,
  keep `setVPFIDiscountRate`, fix the array size), `DeployCrosschain.s.sol`
  (drop the buy-adapter/receiver deploy+wiring), **`DiamondConfigSpell.s.sol`**
  (imports + instantiates `ConfigureVPFIBuy` — remove), **`ConfigureCcip.s.sol`**
  (the `VPFI_BUY_CHANNEL` wiring via `.vpfiBuyAdapter`/`.vpfiBuyReceiver` — remove),
  **`AnvilNewPositiveFlows.s.sol`** (calls `getVPFIBuyConfig`/`setVPFIBuyRate` —
  remove/retarget), `test/deploy/DiamondFacetNames.sol` (drop the 2 crosschain
  buy contracts), `SelectorCoverageTest.t.sol` + `HelperTest.sol` (selector set).
  **Replace `ConfigureVPFIBuy.s.sol` (don't just delete) with a renamed
  discount-config script** — it is today the only deploy/config path that writes
  the VPFI price anchor + `vpfiDiscountEthPriceAsset`; without a replacement, a
  fresh deploy leaves those at 0 and discounts never apply. Wire the renamed step
  into `DiamondConfigSpell` + the deploy runbooks.
- **Test cleanup (wider):** remove/rewrite `test/VpfiBuyFlowTest.t.sol` **and
  `test/CcipDeploymentRehearsalTest.t.sol`** (the latter imports + deploys
  `VpfiBuyAdapter`/`VpfiBuyReceiver`, so it fails at compile if they're deleted
  without it).
- **ABI export + TS consumers (wider than `/buy-vpfi`):**
  `script/exportFrontendAbis.sh` — drop `VpfiBuyAdapter` + `VpfiBuyReceiver`
  (`VPFIDiscountFacet` stays, re-export). Then the bundle's consumers must be
  removed/feature-gated in the SAME PR or the TS build breaks:
  **`apps/agent/src/buyWatchdog.ts`** (imports both buy ABIs) and the **admin
  dashboard hooks** importing `VpfiBuyReceiverABI`.
- **Frontend:** remove `/buy-vpfi` (marketing). **The connected `/app/buy-vpfi`
  page currently OWNS the KEPT `depositVPFIToVault` / `withdrawVPFIFromVault` +
  discount-status flow** — do **not** just delete it; **migrate** the deposit /
  withdraw / consent / discount-status cards to a renamed discount/vault page
  first, or users lose the only app path to the kept fee-discount utility.
- **Docs/allocation:** TokenomicsTechSpec §8/§8a + the §3 "Early Fixed-Rate
  Purchase Program" 1% (2.3M) row (see §6 reallocation).

### B. 5% APR staking yield — REMOVE (discount tiers KEPT)
- **Whole-file removals:** `facets/StakingRewardsFacet.sol`,
  `libraries/LibStakingRewards.sol`, `test/StakingRewardsCoverageTest.t.sol`,
  `test/invariants/StakingBalances.invariant.t.sol` (+ any
  staking-monotonicity invariant). **`test/StakingAndInteractionRewardsTest.t.sol`
  is MIXED — do NOT delete wholesale:** it also covers the **kept**
  `InteractionRewardsFacet` (launch, schedule bands, half-pool formula, snapshot).
  Split: drop the staking cases, **preserve the interaction-reward cases** (move
  to an `InteractionRewards*Test` if cleaner).
- **All 6 `LibStakingRewards.updateUser(...)` caller sites (full list — the scout
  found only 2):** `LibVPFIDiscount.sol` (the LIF/yield-fee notify calls),
  `facets/VPFIDiscountFacet.sol` (`depositVPFIToVault`/`withdrawVPFIFromVault`),
  `facets/LenderIntentFacet.sol` (`withdrawIntentCapital`),
  `libraries/LibConsolidation.sol` (`_restampVpfi`/`restampUserVpfi`),
  `facets/ConfigFacet.sol`, `libraries/LibVaipakam.sol`. Delete each call + each
  `import {LibStakingRewards}` while **retaining the surrounding VPFI movement +
  discount rollups** — these are one-way staking notifications, not tier inputs.
- **Storage/constants (`LibVaipakam.sol`):** remove `VPFI_STAKING_APR_BPS`,
  `VPFI_STAKING_POOL_CAP`, `STAKING_APR_BPS_MAX`, the `vpfiStakingAprBps` config
  field, and the staking storage (`totalStakedVpfi`, `stakingLastUpdateTime`,
  `stakingRewardPerTokenStored`, `userStakedVpfi`,
  `userStakingRewardPerTokenPaid`, `userStakingPendingReward`,
  `stakingPoolPaidOut`). **Also `stakingPoolBuybackBudget`** (the staker-yield
  router sink — see below; it dies with B, not C).
- **`stakingPoolBuybackBudget` full surface (dies with B):** the storage slot +
  `TreasuryFacet.getStakingPoolBuybackBudget` getter (+ its selector in
  `DeployDiamond`/`HelperTest`/`SelectorCoverageTest`) + the `LibTreasuryBuyback`
  `_routePriority` step-3 that increments it + every buyback test asserting it.
  Removing the slot **without** these trips compile/selector failures; leaving
  them strands a dead staker-yield budget.
- **`ConfigFacet.sol` — incl. the ABI tuple surfaces:** remove `setStakingApr` +
  its bound; and **`getProtocolConfigBundle` still returns `vpfiStakingAprBps`**
  and **`getProtocolConstants` still returns `VPFI_STAKING_POOL_CAP`** — drop
  those tuple fields AND update every consumer that reads those tuple positions
  (tests + frontend hooks), or the build breaks / a removed pool stays surfaced.
- **Deploy/sanity:** `DeployDiamond.s.sol` `_getStakingRewardsSelectors()`
  (delete the function + its cut entry), `DiamondFacetNames.sol`
  (drop `StakingRewardsFacet`), `SelectorCoverageTest.t.sol`, `HelperTest.sol`,
  `SetupTest.t.sol` (drop the staking facet import + cut + setup).
- **Other live consumers (compile-breakers if missed):**
  **`MetricsDashboardFacet`** imports `StakingRewardsFacet` and calls
  `previewStakingRewards` for `DashboardScalars.stakingRewardsPending` — drop the
  call + that tuple field (+ update the dashboard ABI/consumers).
  **`AnvilNewPositiveFlows.s.sol`** imports/calls the facet in its N13 flow —
  remove that step.
- **ABI export:** drop `StakingRewardsFacet`; re-export `ConfigFacet`/`TreasuryFacet`/
  `MetricsDashboardFacet` (tuple shapes changed) + their TS consumers.
- **Frontend:** `/staking` pages + staking/yield/APR widgets + claim UI + any
  `getProtocolConfigBundle`/`getProtocolConstants` reader of the dropped fields.
- **Docs/allocation:** TokenomicsTechSpec §7/§12.1 + whitepaper §12.1 + overview
  "5% annual yield" copy + the §3 Staking-Rewards 24% (55.2M) row (see §6).

### C. Treasury buyback — CONFIRM DORMANT (do NOT delete)
- **Dormancy — assert on BOTH chain roles (the mirror-only proof was incomplete):**
  - *Mirror chains:* `remitBuyback` reverts `BuybackTokenNotAllowed` (no allowed
    token) / `InsufficientBuybackBudget` (budget 0) until the operator sets an
    allowed token **and** funds the budget.
  - *Canonical chain (Base) — separate path:* `creditBuybackBudget` **skips the
    allowed-token gate** and credits `baseBuybackBudget`, then
    `commitBuybackIntent` spends that budget **directly, without `remitBuyback`**.
    So a Base-only buyback can activate via budget+intent+Fusion even with no
    allowed token. **The Phase-1 dormancy assertion must check Base
    budget/intent/Fusion activation too**, not just `remitBuyback`'s gates.
  - *Verified:* **no script calls `setBuybackAllowedToken`, `creditBuybackBudget`,
    or `commitBuybackIntent`.** Nuance: `ConfigureCcip.s.sol`
    (`_wireDiamondBuybackConfig`) *does* wire the messenger +
    `setBuybackRemittanceReceiver` (canonical) — wiring the pipe, not opening the
    valve. With no funded budget + no committed intent, nothing flows on either
    chain role.
- **Phase-1 action (minimum):** keep it dormant — a deploy-sanity/test assertion
  that no allowed-token / budget-credit / intent-commit / Fusion activation
  exists in any deploy/config path (both chain roles). **The intent-commit check
  must cover BOTH external selectors — `commitBuybackIntent` AND
  `commitBuybackIntentValidated`** (the validated path can create the same
  Fusion-backed intent on Base without the legacy commit). The staker-yield target
  (`stakingPoolBuybackBudget`) is severed *with B* (§3.B). Optionally drop the
  `ConfigureCcip` receiver-wiring for cleanliness (harmless while the valve is
  shut).
- **Kept budgets — Option 2 (OWNER-DECIDED 2026-06-23): do nothing; they degrade
  gracefully to 0.** Correction to an earlier draft: `rewardEmissionsBudget` +
  `keeperRewardBudget` are **only ever incremented by `LibTreasuryBuyback._routePriority`**
  (consumed in `LibKeeperReward`) — there is **no** direct operator top-up, so
  with buyback dormant they sit at **0**. That is **safe and intentional**:
  - `LibKeeperReward` handles a 0 budget gracefully (`if (budget == 0) { emit
    KeeperRewardSkipped(…,"budget-empty"); return 0; }` — *"housekeeping continues
    regardless"*): the keeper's liquidation/HF-check **still executes**; only the
    optional VPFI bonus is skipped (keepers are incentivized by liquidation
    bonuses + matcher LIF independently).
  - `rewardEmissionsBudget` is only a buyback-burn **offset** to interaction-reward
    inflation — it does **not** gate interaction-reward payouts. (Note:
    interaction rewards are **not** an independent self-funding mint — `claimInteractionRewards`
    caps against `VPFI_INTERACTION_POOL_CAP` but **pays by `safeTransfer` from the
    diamond's VPFI balance**, so the diamond must actually hold VPFI; the required
    treasury funding path is called out in §6, separate from buyback budgets.) At
    0 there's simply no offset (a Phase-2
    buyback-burn concern).
  - **⇒ No Phase-1 funding path is added** (no new admin economic knob — best for
    the minimal-legal/decentralization story). The keeper VPFI bonus + the
    emissions offset return naturally with the Phase-2 buyback-burn. The cascade
    comment in `LibVaipakam.sol` drops from 3-step → 2-step once B removes
    `stakingPoolBuybackBudget`.
- **Shared surface — do NOT remove:** `IntentDispatchFacet` is shared by
  swap-to-repay **and** buyback (`ORDER_KIND_BUYBACK` branch); leave the facet.
  Full buyback code removal (`LibTreasuryBuyback`, `LibBuybackOrderValidation`,
  `BuybackRemittanceReceiver`, TreasuryFacet buyback selectors) is an
  **optional later task**, not Phase-1.

---

## 4. Removal order (ordered sub-PRs) + shared-surface coordination

### ⚠️ 4.0 Storage-layout safety (load-bearing — P1)

Deleting fields from the shared `LibVaipakam.Storage` struct **shifts every later
slot** in the ERC-7201 diamond storage namespace. Applied as an **in-place
diamond cut against a live deployment, that corrupts unrelated state.** Two safe
paths:

- **This deploy (PRE-LIVE): fresh redeploy is the canonical path.** There is no
  live state to corrupt, and the project's deploy policy already says any
  cross-cutting change rolls out via a fresh `DeployDiamond.s.sol` (not an
  in-place `RedeployFacets` cut). So PR-A/PR-B may delete the sale/staking fields
  outright **provided the rollout is a fresh deploy** — which it is. The PRs must
  state this assumption explicitly.
- **If these ever ship as an in-place upgrade over a live diamond** (not the case
  here): do **not** delete slots — replace each removed field with a
  `deprecated_*` placeholder of the same size to preserve the layout, and treat
  any real reclamation as a separate migration. Documented so a future
  in-place-upgrade author can't silently corrupt state.

### 4.1 Sub-PR order

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
(55.2M) staking pool. **Plus the doc-only market-making allocation — reconcile the
source inconsistency FIRST:** `TokenomicsTechSpec` says **12%** while the public
whitepaper table shows **14%** (with 50% of it liquidity). Pick **one
authoritative figure** (recommend the TokenomicsTechSpec **12%**, and correct the
whitepaper to match) before computing any cap delta — otherwise the code cap, the
allocation table, and the whitepaper end up mutually inconsistent. The three
freed buckets are therefore **1% + 24% + (12% MM)**; do **not** double-count the
MM bucket. Three options:

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

**Interaction-reward funding (kept stream — call out separately):** the retained
`claimInteractionRewards` pays via `safeTransfer` from the **diamond's VPFI
balance** (capped against `VPFI_INTERACTION_POOL_CAP`), so it is **not**
self-funding — a claim can pass the pool-cap accounting yet **revert on an
unfunded diamond**. Whatever the cap/reallocation decision, the diamond must be
**funded with the interaction-reward VPFI** (treasury mint/transfer into the
diamond), independent of the (dormant) buyback budgets. Spell this out in the
allocation plan so the kept earn path actually pays out.

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
  the research/roadmap in **#694** + its design doc `VPFITokenomicsRedesignResearch.md`
  (lands on `main` via **PR #695**; until that merges the file is on the
  `docs/vpfi-tokenomics-redesign-research` branch, so this doc intentionally
  links the issue/PR rather than a not-yet-existing path).
- Code: `facets/VPFIDiscountFacet.sol`, `libraries/LibVPFIDiscount.sol`
  (tier=balance, §2 verdict), `facets/StakingRewardsFacet.sol` +
  `libraries/LibStakingRewards.sol`, `crosschain/VpfiBuy{Adapter,Receiver}.sol`,
  `facets/TreasuryFacet.sol` + `libraries/LibTreasuryBuyback.sol`,
  `facets/IntentDispatchFacet.sol` (shared — keep), `libraries/LibVaipakam.sol`
  (storage), `script/DeployDiamond.s.sol` + `test/deploy/*` (selector sanity),
  `test/invariants/VPFISupplyCap.invariant.t.sol`.
