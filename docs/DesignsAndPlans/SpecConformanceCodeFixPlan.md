# Spec-Conformance Code Fixes — Implementation Sequencing Plan (#998)

**Status:** Plan — pending implementation
**Module:** contracts
**Umbrella:** #998 (code-fix decisions from the 2026-07-05 spec-vs-code
conformance review, `docs/FindingsAndFixes/Findings20260705-SpecVsCodeConformanceReview.md`)
**Scope:** the 16 **"code is wrong → fix the code"** findings triaged under #998.
The "keep code / update spec" items already merged in PR #1011; this plan does
not revisit them.

---

## 1. Purpose

#998 tracks 16 independent code-fix cards. Landing them one-card-per-PR in issue
order would repeatedly re-touch the same facets, re-run the same ABI re-exports,
and risk merge conflicts between cards that edit the same function. This plan
**groups the fixes into 5 tranches by shared code surface**, orders the tranches
by live impact + dependency, and records a concrete per-finding approach so each
tranche PR can be authored without re-deriving the design.

The platform is **pre-live** (no production deploy, no real open loans), so ABI
breaks are cheap and the "existing loans keep their snapshot" caveat several
findings carry is moot — the flips below apply cleanly with no migration.

## 2. Ordering principles

1. **Batch by shared surface.** Findings that edit the same facet/library ship
   in one PR — one build, one ABI re-export, one review of that file, no
   intra-file conflicts.
2. **Order by live blast radius, then severity.** A bug live on *every* loan
   today outranks a High-severity bug with a narrow trigger.
3. **Respect dependencies.** One tranche establishes a primitive a later tranche
   consumes; the producer lands first.
4. **Isolated-and-urgent first** to build momentum and de-risk the review
   cadence before the larger clusters.

## 3. The finding → surface map (scouted 2026-07-05)

| Finding | Sev | Primary surface | Card |
|---|---|---|---|
| S1 inverted liq-threshold gradient | High | `LibVaipakam` consts 162-164, `ConfigFacet.setTierLiquidationLtvBps` 1484, `OracleFacet._liquidityTier` 1765-1789 | #999 |
| S11 tier-1 $50k probe ignored | Med | `OracleFacet._liquidityTier` 1785-1788 | #1007 |
| S4 rewards claimable while open | High | `LibInteractionRewards` `_processEntry` 897, `_closeEntry` 1033, `RewardEntry` struct `LibVaipakam` 2120 | #1002 |
| S5 preclose/refinance never close reward entries | High | `LibInteractionRewards.closeLoan` wiring into `PrecloseFacet` + `RefinanceFacet` | #969 |
| S13 per-user cap per-window not per-day | Med | `LibInteractionRewards._processEntry` 945, `_previewEntryReward` 993 | #1008 |
| S3 offset (Opt 3) double-pay | High | `PrecloseFacet._settleOffsetPayments` 1128, `OfferCancelFacet.cancelOffer` 202, `ClaimFacet.claimAsLender` 899 | #1001 |
| S2 fallback repay-cure unreachable | High | `RepayFacet.repayLoan` 254 | #1000 |
| S7 refinance ignores pro-rata election | Med | `RefinanceFacet` 323 | #1003 |
| L-c Opt-2/3 term exceeds original maturity | Low | `PrecloseFacet._remainingDays` 1414 | #1032 |
| S12 forced-close ignores `interestSettled` | Med | `RiskFacet` 770, `RiskSplitLiquidationFacet` 234, `DefaultedFacet` 396, `LibFallback` 151 | #915 |
| S9 empty try-list → forced fallback | Med | `RiskFacet.triggerLiquidation` 754, `DefaultedFacet.triggerDefault` 364 (`LibSwap` 158) | #1005 |
| L-g subordinate 2% treasury fee to lender | Low | `RiskFacet` waterfall 799-855 | #1009 |
| L-h no incentive on time-based-default swap | Low | `DefaultedFacet.triggerDefault` 404-435 | #1010 |
| S8 NFT-rental late fee on daily fee | Med | `LibVaipakam.calculateLateFee` 6036 | #1004 |
| S10 locked-proceeds release fails open | Med | `LibVaipakam.isSanctionedAddress` 6940, `ClaimFacet` release gate 660 | #1006 |
| S15 range-offer bounds not re-checked on mutate | Med | `OfferMutateFacet` (vs `OfferCreateFacet` 906) | #900 |

Doc-only tail: **#1018** (CLAUDE.md staleness sweep) — no contract change.

## 4. Dependency graph

```
Tranche 1 (tier)         ─┐
Tranche 2 (rewards) ──────┼──▶ Tranche 3 (preclose/refinance/repay)   [3 rebases on 2]
Tranche 4 (liquidation)  ─┤
Tranche 5 (standalone)   ─┘   (1, 4, 5 mutually independent)
```

The only hard edge: **Tranche 2 must land before Tranche 3.** S5 (in Tranche 2)
wires `closeLoan(...)` into `PrecloseFacet`/`RefinanceFacet`; Tranche 3 then
edits the offset/refinance/rounding logic in those same files. Landing rewards
first means Tranche 3 rebases onto an already-wired file instead of colliding.
Everything else is independent and could even run in parallel branches.

## 5. Recommended order

| # | Tranche | Findings | Why here |
|---|---|---|---|
| **1** | **Tier-threshold semantics** | S1, S11 | S1 is the single highest **live** impact — the inverted gradient is snapshotted onto **every liquid-collateral loan regardless of `depthTieredLtvEnabled`**, so thin-market collateral is only liquidatable at 90% LTV today (the bad-debt shape the gradient exists to prevent). Isolated to the tier machinery; no dependency. Fastest high-value win. |
| **2** | **Interaction-reward lifecycle** | S4, S5, S13 | Two High-severity gaming bugs (claim-then-default forfeit bypass; accrual on retired principal + refinance double-count). Establishes the `closed`-bit primitive Tranche 3's preclose/refinance wiring depends on. One coherent reward-lib PR. |
| **3** | **Preclose / refinance / repay close-outs** | S3, S2, S7, L-c | Two High fund/cure bugs (S3 principal double-pay on offset-cancel; S2 unreachable fallback cure) + refinance interest mode + Opt-2/3 rounding. All in `PrecloseFacet`/`RefinanceFacet`/`OfferCancelFacet`/`RepayFacet`. Rebases on Tranche 2's `closeLoan` wiring. |
| **4** | **Forced-close / liquidation correctness** | S12, S9, L-g, L-h | Interest double-charge on every liquidation/default (S12), grief vector forcing healthy loans into the 3%+2% premium with zero swap attempted (S9), waterfall + incentive consistency (L-g, L-h). All converge on `RiskFacet` + `DefaultedFacet`; L-h enables a DRY incentive-helper extraction. |
| **5** | **Standalone hardening** | S8, S10, S15 | Three independent one-to-two-file fixes: NFT late-fee base, sanctions locked-release fail-closed, range-mutate re-checks. Batched to close the umbrella. |
| tail | **CLAUDE.md sweep** | #1018 | Doc-only; fold last (or opportunistically). |

## 6. Per-tranche approach

Each tranche is one PR: targeted tests only (`--match-path`), ABI re-export for
any facet whose error/selector/struct surface changes, deploy-sanity suite when
selectors change, release-note fragment + FunctionalSpec touch, `Closes #<card>`
for each finding it lands.

### Tranche 1 — Tier-threshold semantics (S1, S11)

- **S1:** Flip the default gradient so **deeper = higher threshold**:
  `DEFAULT_TIER1_LIQUIDATION_LTV_BPS` (thinnest, tier 1) becomes the *lowest*
  and tier 3 (deepest) the *highest* — i.e. swap 9000/8500/8000 → **8000/8500/9000**
  (values to be re-ratified against the whitepaper §7 numbers as part of the
  done-criteria, not assumed here). Flip the `ConfigFacet` setter invariant from
  `T1 ≥ T2 ≥ T3` to `T1 ≤ T2 ≤ T3` and update its `NonMonotoneTierLiquidationLtvBps`
  doc-comment + the `LibVaipakam:152-156` comment that currently asserts the
  inverted "tier 1 = deepest" semantics.
- **S11:** In `OracleFacet._liquidityTier`, gate Tier 1 on the currently-ignored
  `best[1]` ($50k `tier1SizePad`) probe: an asset that clears the $5k floor but
  not the $50k pad should fall to the *untierable* floor case, not silently get
  Tier 1. Decide (and document) the exact rule: `best[1] > bound ⇒ 0` before the
  `return 1` fallthrough. This makes the `tier1SizePad` governance knob live.
- **Tier-0 fallback — MUST be handled in this tranche (Codex #1052 r1, P1).**
  `cfgTierLiquidationLtvBps(0)` today returns the Tier-3 default (the conservative
  end under the *current* inverted numbering). After the flip, Tier 3 becomes the
  **highest** (90%) threshold — so a floor-clearing-but-sub-$50k liquid loan
  (which S11 now sends to Tier 0) would snapshot **90%** and retain the exact
  bad-debt shape S1 removes. The flip must therefore **remap the tier-0 fallback
  to the LOWEST/most-conservative threshold** (the new Tier-1 8000-equivalent, or
  an explicit dedicated tier-0 floor), not leave it aliased to Tier 3. Verify
  `LoanFacet`'s `effTier == 0` snapshot path lands on the conservative value.
- **Interaction:** S11 changes *which* tier an asset gets; S1 changes *what
  threshold* each tier carries; and S11's new tier-0 outcomes make the tier-0
  fallback remap load-bearing — the three are one coherent change, which is why
  they land together.
- **Done-criteria (from #999):** re-add the settled per-tier defaults to
  whitepaper §7 + the spec's depth-tier section **in the same PR**.
- **Tests:** tier-assignment table (floor/$50k/$500k/$5M boundaries), the setter
  invariant (accept ascending, reject descending), HF snapshot picks the deeper
  = higher threshold. No ABI change (constants + invariant + internal decision).

### Tranche 2 — Interaction-reward lifecycle (S4, S5, S13)

- **S4:** Add a `bool closed` to `RewardEntry` set by `closeLoan`/`_closeEntry`;
  gate `_processEntry` (and its view twin `_previewEntryReward`) on `closed`
  rather than the dead `endDay == 0` sentinel. `endDay` stays purely the accrual
  bound. This closes the "claim at maturity while still open, then default"
  forfeit-bypass: an entry is only payable once its loan is actually closed.
- **S5:** Wire reward handling into the paths that currently mutate a loan
  without touching the reward ledger. **Distinguish TERMINAL closes from
  CONTINUING transfers (Codex #1052 r1, P1) — this is the crux:**
  - **Terminal** paths that flip Active→Repaid — `precloseDirect`,
    `completeOffset`, and `RefinanceFacet`'s old-loan settlement — call
    `closeLoan(...)`: borrower-initiated preclose ⇒ `borrowerClean=false`;
    lender-initiated ⇒ `lenderForfeit=true`; refinance old-loan ⇒
    `borrowerClean=true` per §6 (record the refinance-intent decision explicitly).
  - **Continuing** path `transferObligationViaOffer` (Option 2) rewrites the
    borrower/collateral but leaves the loan **Active** — it is NOT a terminal
    close. Calling `closeLoan` there would forfeit the exiting party and stop the
    surviving loan from ever accruing again. Instead **migrate the entry** to the
    new counterparty (reuse the existing `transferLenderEntry` /
    `_allocEntry`-based reopen mechanism the lender-position-transfer path already
    uses), so the continuing loan keeps a live reward entry under the new owner.
  - Confirms/closes #969, and fixes the refinance double-count (old entries must
    close before the new loan's entries register).
- **S13:** the §4 cap is **per-user-per-day**, not per-entry. Replacing the
  window aggregate with a per-day `min(raw_d, cap_d)` *inside a single entry* is
  necessary but **not sufficient (Codex #1052 r1, P2):** a user with several
  same-side loans opened the same day holds several `RewardEntry`s, and capping
  each independently lets their sum exceed the user's daily ceiling
  (`min(Σ raw_d, user_cap_d)` ≠ `Σ min(raw_d, cap_d)`). This tranche therefore
  needs a **user×day aggregate** accounting, not just per-entry window math —
  e.g. accumulate a per-`(user, day)` awarded-so-far total that each entry's
  daily award is clamped against as entries are processed. This is the one
  finding in the tranche that needs its own small sub-design (storage for the
  running per-user-day total, and a deterministic processing order so preview and
  claim agree); flag it as the highest-uncertainty item and design it before
  coding. Whatever the mechanism, `_processEntry` and `_previewEntryReward` must
  produce identical numbers.
- **Sequencing within the tranche:** S4 first (the `closed` primitive), then S5
  (consumes it), then S13 (independent cap math). All three touch `_processEntry`,
  so one PR avoids three-way conflict on that function.
- **ABI:** `RewardEntry` is read by `InteractionRewardsFacet` views — re-export
  `InteractionRewardsFacet.json` (+ frontend typecheck) for the struct-shape
  change.
- **Tests:** claim-blocked-while-open; claim-after-close pays; default-after-
  maturity forfeits (no payout); preclose/refinance close the entries;
  per-day cap bites a spike day without netting against slack days.

### Tranche 3 — Preclose / refinance / repay close-outs (S3, S2, S7, L-c)

- **S3:** the offset Step-1 payment (`principal + accruedInterest − treasuryFee
  + shortfall` into the old lender's vault + `heldForLender += lenderTotal`) is
  the double-pay root. Two candidate fixes:
  (a) move the *principal* portion to `completeOffset` (spec Step 2), leaving
  only the accrued-interest reservation at Step 1; or (b) make
  `OfferCancelFacet.cancelOffer`'s offset branch pull the offset contribution
  back out of the lender's vault and decrement `heldForLender`.
  **Recommendation revised to (a) — the Step-2 principal move (Codex #1052 r1,
  P1).** `heldForLender[loanId]` is a **composed accumulator** — a partial
  internal match or fallback rescue can also add to it, and those prior proceeds
  are paid with the eventual lender claim. So the cancel-unwind (b) must
  **subtract exactly `lenderTotal`, never zero the accumulator** (zeroing would
  wipe legitimate prior held funds), which means tracking the offset's own
  contribution separately (e.g. `offsetHeld[loanId]`). Option (a) sidesteps this
  entirely: principal never enters `heldForLender` at Step 1, so a cancel needs
  no unwind of it — only the accrued-interest reservation (a smaller amount) is
  in play. Whichever is chosen, also: (c) reject a second `offsetWithNewOffer`
  while `loanToOffsetOfferId[loanId] != 0` (guard in `_validateOffsetRequest`,
  new error); and (d) after the `ClaimFacet` withdrawal, **decrement** the
  offset's held contribution (currently read-and-withdrawn but never cleared — a
  latent re-withdraw), again by subtraction, not by zeroing the shared bucket.
- **S2:** exempt the grace gate when `curingFallback == true` (the flag is
  already in scope at `RepayFacet.sol:254`). The cure payment fully compensates
  the lender (principal + interest incl. grace accrual + late fees), so there is
  no lender-side harm in allowing the cure past `graceEnd`.
- **S7:** route the refinance exiting-lender payoff through the same
  `LibEntitlement.settlementInterestNet(oldLoan, block.timestamp)` the preclose
  path uses, instead of the unconditional `fullTermInterest(...)`. That helper
  already honors `useFullTermInterest` (full-term for opt-in, accrued-only for
  pro-rata) — so refinance and preclose stop disagreeing.
- **L-c:** cap the Opt-2/3 replacement maturity at the **original** loan maturity
  — either clamp `now + newDurationDays·1day ≤ originalStart + originalDuration·1day`,
  or derive the replacement term from seconds-precise remaining rather than the
  up-rounded whole-day `_remainingDays`.
- **Note:** all four co-locate in the preclose/refinance/repay facets and rebase
  on Tranche 2's `closeLoan` wiring (S5) already present in `PrecloseFacet`/
  `RefinanceFacet` — preserve those calls when restructuring the offset path.
- **Tests:** offset-cancel refunds + zeroes `heldForLender` (no later double-
  claim); second-offset rejected; fallback cure past graceEnd succeeds; pro-rata
  refinance charges accrued-only; replacement maturity never exceeds original.

### Tranche 4 — Forced-close / liquidation correctness (S12, S9, L-g, L-h)

- **S12:** net `loan.interestSettled` into the interest owed at all four
  forced-close sites — `RiskFacet.triggerLiquidation`,
  `RiskSplitLiquidationFacet`, `DefaultedFacet.triggerDefault`,
  `LibFallback.computeFallbackEntitlements`. **Do NOT reroute through
  `settlementInterestNet` (Codex #1052 r1, P1):** that helper rounds to whole
  days AND applies the `useFullTermInterest` full-term floor, whereas the
  forced-close paths intentionally accrue **seconds-precise** outstanding
  interest — rerouting would silently change the forced-close debt model (over/
  undercharging early liquidations). Instead subtract in place:
  `owedInterest -= min(interestSettled, accruedInterest)` on each site's
  *existing* seconds-precise `accruedInterest`, preserving the current accrual
  semantics and only crediting what was already settled (saturating so it can't
  underflow).
- **S9:** reject an empty adapter try-list at the two forced-close entry points
  (`RiskFacet.triggerLiquidation`, `DefaultedFacet.triggerDefault`) before
  falling into `_fullCollateralTransferFallback` — mirror
  `RepayPeriodicFacet`'s `PeriodicSettleSwapPathRequired` guard so a caller can't
  push a healthy loan into the premium fallback with zero routes attempted. (The
  genuine "all configured routes failed" path still reaches the fallback.)
- **L-g:** reorder the waterfall so the **2% treasury handling fee is
  subordinated to full lender recovery** when proceeds are short — keep the
  liquidator bonus senior (it must stay to incentivize the liquidation), but the
  treasury handling fee (and the interest-split fee) yield to making the lender
  whole first. **Apply the reorder to BOTH `RiskFacet` AND
  `RiskSplitLiquidationFacet` (Codex #1052 r1, P2)** — the split-route facet
  carries the same `bonus → handling-fee → debt` waterfall, so fixing only
  `RiskFacet` would leave split-route liquidations still paying treasury ahead of
  a short-changed lender.
- **L-h:** add the dynamic incentive (6% − realized slippage, capped 3%, per-
  asset `liqBonusBps` ceiling) to the `DefaultedFacet` time-based-default swap
  path so it matches the HF-based path. Since that incentive block is currently
  **copy-pasted at three sites** (`RiskFacet` ×2, `RiskSplitLiquidationFacet`),
  extract it into a shared helper (`LibEntitlement`/`LibSwap`) and call it from
  all four — a DRY win that also guarantees the time-default path can't drift.
- **Ordering within:** S12 first (the netting touches the same debt math L-g's
  waterfall consumes), then L-g, then L-h (helper extraction), then S9 (guard).
- **Tests:** periodically-settled loan liquidated/defaulted pays interest once;
  empty try-list reverts on both forced-close entries; short-proceeds waterfall
  makes lender whole before treasury handling fee; time-default swap pays the
  same incentive as HF-liq; the extracted helper matches the prior inline math
  (regression on the three existing sites).

### Tranche 5 — Standalone hardening (S8, S10, S15)

- **S8:** branch `calculateLateFee` on asset type: for NFT rentals base the fee
  on `principal × undeductedDays` (the overdue rental amount) with the cap at
  **5% of total rental** (`principal × durationDays`), not 5% of one day's fee.
  ERC-20 path unchanged. (No dedicated total-rental field exists — derive from
  `principal × durationDays`, matching how prepay is computed at
  `OfferAcceptFacet.sol:44`.)
- **S10:** add a **fail-closed** sanctions variant (mirror the
  `VaultFactoryFacet:753` pattern: oracle-unset ⇒ refuse, oracle-revert ⇒ refuse)
  and call it **only** at the locked-proceeds release gate (the `ClaimFacet`
  screen for a `SanctionedProceedsLocked` deposit). Normal never-flagged
  claim/withdraw paths keep calling the fail-open `isSanctionedAddress` so an
  oracle blip can't freeze honest users' funds. The locked funds stay parked in
  the flagged wallet's own vault until the oracle recovers and confirms clean.
- **S15:** re-run the `MinCollateralBelowFloor` / `MaxLendingAboveCeiling` range
  checks in `OfferMutateFacet` (extract the create-time block into a shared
  internal so create and mutate share one definition), so a mutate can't move a
  compliant range offer into a shape `createOffer` would reject. **Do NOT gate
  the checks on the dormant `rangeAmountEnabled` flag (Codex #1052 r1, P2):** the
  create path no longer *rejects* range offers when that flag is off, so mirroring
  the flag-guard on mutate would let an off-flag deployment create AND mutate
  out-of-bounds range shapes — the card would stay open. Apply the bounds
  **wherever a range shape is allowed** (i.e. keyed on the offer actually being a
  range shape + liquid-both-legs, not on `rangeAmountEnabled`), at both create and
  mutate, so the invariant holds regardless of the flag. Keep the liquid-both-legs
  ERC-20 conditions the create path uses.
- **Tests:** NFT late fee scales with term + caps at 5% of total; locked-release
  reverts on oracle-revert while a normal claim still succeeds; mutate rejects an
  out-of-bounds range shape create would reject.

## 7. Cross-cutting notes

- **Shared-helper extractions** (do them as part of the tranche that needs them,
  not as separate refactors): the liquidation incentive block (L-h, Tranche 4)
  and the range-bounds check (S15, Tranche 5). Both currently duplicated;
  extracting is a correctness guarantee, not just tidiness.
- **The `closed`-bit primitive** (S4) is the one genuinely load-bearing new
  storage/struct field — every reward payout path routes through its gate, so it
  ships with the widest test surface (Tranche 2).
- **ABI re-export triggers:** Tranche 2 (`InteractionRewardsFacet` struct shape),
  and any tranche that adds a custom error to a facet's surface (S3 double-offset
  guard, S9 empty-list guard, S10 fail-closed error). Tranche 1 needs none.
- **Deploy-sanity:** none of these add/remove selectors except possibly new
  custom errors (errors don't get cut as selectors), so `SelectorCoverage` /
  `FacetSizeLimit` only need a re-check if a facet grows materially — verify per
  tranche, don't assume.
- **Spec/whitepaper:** Tranche 1 carries the whitepaper §7 + depth-tier spec
  update (S1 done-criteria). Every tranche updates the relevant
  `docs/FunctionalSpecs/` domain + a release-note fragment; move the closed
  findings' rows in `_CodeVsDocsAudit.md` from Open → Resolved as each lands.

## 8. Out of scope

- The "keep code / update spec" items (S6, S14, S16–S19, L-f, L-l, L-m) — already
  merged in PR #1011.
- Still-needs-adjudication ambiguous items (L-i, L-a, L-j, L-o) — not on #998's
  code-fix list; leave for a separate owner decision.
- #1018 CLAUDE.md sweep — doc-only, folded after the code tranches.

Each tranche lands as its own PR under #998, `Closes #<card>` per finding, with
its own Codex review pass. This doc is the shared reference every tranche PR
points back to for the agreed order and approach.
