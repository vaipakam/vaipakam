# Lender-Proceeds Reservation — Mechanism v2

**Status:** Design (for review) · **Issues:** #592 (terminal-path reserve),
#597 (held-for-lender). · **Builds on:** #585 (the original reserve/release
mechanism). · **PR in flight:** #596 (terminal-path gates, currently *draft*
— this doc supersedes its remaining scope).

> Authority note (per the working principle, 2026-06-14): this design is
> derived from `docs/FunctionalSpecs/ProjectDetailsREADME.md`, **not** from
> what the current code happens to do. The contract code is the thing under
> test. Where the code diverges from the spec, it is flagged below as a
> *candidate bug*, not adopted as a requirement.

---

## 1. Problem

VPFI is the one asset that is **both** a valid loan principal/collateral
**and** has a user-facing tracked-balance exit: `withdrawVPFIFromVault`
(the staking-unwind door). When a loan closes, the lender's claimable
proceeds are deposited into the **stored `loan.lender`'s vault** but are
owed to the **current lender-position NFT holder** (FunctionalSpec §928:
"claim rights and payout routing remain tied to the current position-NFT
holder"). If the lender position was transferred, the stored lender —
who still owns the *vault* that physically holds the VPFI — can call
`withdrawVPFIFromVault` and drain those proceeds **before** the current
holder claims them, leaving the rightful claim unfundable.

The platform is **pre-live**, so no funds are at risk today; this is a
mainnet-blocker class to close before cutover.

#585 introduced the fix mechanism for the internal-match path:
`LibEncumbrance.encumberLenderProceeds(loanId, lender, asset, amount)`
reserves the amount in `s.encumbered[lender][asset][0]` (the exact
aggregate `withdrawVPFIFromVault`'s free-balance guard subtracts) and
records it per-loan in `s.lenderProceedsEncumbered[loanId]`;
`releaseLenderProceeds` frees it in `ClaimFacet._claimAsLenderImpl`
immediately before the payout. #592 set out to extend the **reserve** call
to every other deposit site. Codex review of #596 surfaced two structural
gaps that make this more than "add a call":

- **G1 — Wrong key asset.** Both the reserve gates and the release
  (ClaimFacet.sol:341 — `releaseLenderProceeds(loanId, loan.lender,
  loan.principalAsset)`) key on **`loan.principalAsset`**. But the
  claimable asset is not always the principal: a default whose collateral
  is liquidated **in-kind** deposits `loan.collateralAsset` into the
  lender's vault and records `lenderClaims[loanId].asset =
  collateralAsset`. VPFI **is collateral-eligible** (no gate forbids it;
  see `VPFIDiscountFacet.withdrawVPFIFromVault` "VPFI is collateral-
  eligible" note). So a non-VPFI-principal / VPFI-collateral default
  produces a VPFI claim that the principal-keyed gate **misses entirely**,
  and even if reserved, a principal-keyed *release* would free the wrong
  aggregate.

- **G2 — Held-for-lender not covered.** The preclose **offset** and
  **obligation-transfer** paths accumulate `s.heldForLender[loanId]` on a
  loan that stays **active**, paid later (with the lender claim) to the
  current holder. These were excluded from #596 because the lender of
  record can change before the claim. They still represent the same drain
  vector and must be reserved.

## 2. Spec-derived ownership model (the foundation)

From `docs/FunctionalSpecs/ProjectDetailsREADME.md`:

1. **Claims follow the current position-NFT holder** (§928, §612). Every
   lender payout — `lenderClaims` *and* `heldForLender` — is owed to
   whoever holds the loan's lender NFT at claim time, and is routed to
   their wallet.
2. **Staking yield belongs to the vault owner, not the loan.** VPFI
   staking rewards accrue to whoever owns the vault. They are **not** loan
   proceeds and must **not** be reserved. (Already structurally true:
   `withdrawVPFIFromVault` clamps the withdrawable to
   `min(balance, protocolTrackedVaultBalance) − encumbered`, so any
   balance *above* the tracked principal — the yield — is outside the
   reservation and stays with the vault owner.)
3. **Accrued interest on a lender sale is forfeited to treasury** (§1322,
   §1337-1338), *not* carried to the buyer or kept by the seller. So a
   sale never deposits the seller's tenure interest into `heldForLender`.
4. **Accrued interest on an offset is owed to the exiting lender** (§1210,
   §1235, §1258) — who is the holder of the (now-closed) original loan's
   lender NFT, so rule (1) still resolves it correctly.

**Synthesis — the single invariant this design enforces:**

> Reserve every VPFI amount that is **deposited into a `loan.lender`
> vault and owed to the current lender-NFT holder via a deferred claim or
> `heldForLender`**, keyed on the **asset actually deposited**, against the
> vault owner's `withdrawVPFIFromVault`, until that holder claims — and
> keep the reservation attached to the **vault that physically holds the
> VPFI**, re-keying it whenever that vault changes.

Staking yield (rule 2) is automatically out of scope; the seller's
forfeited accrued interest (rule 3) is never in a lender vault as a claim,
so it is automatically out of scope too.

## 3. Code-vs-spec check (candidate bugs surfaced, and ruled out)

Per the principle, each was verified against the spec rather than assumed:

- **Checked & MATCHES (no bug):** the lender-sale settlement
  (`EarlyWithdrawalFacet` ~L215-277) deducts the seller's `accrued` from
  their payout (`toLiam = principal − liamCost`) and routes the forfeited
  remainder to **treasury** (`treasuryCut`, L230/L271) — exactly §1322.
  The `heldForLender` that remains after a sale is Noah's shortfall
  compensation + the migrated `priorHeld`, both owed to the new current
  holder. `ClaimFacet` pays `heldForLender` to the current NFT holder.
  Consistent — earlier "may not match" hypothesis **retracted**.
- **Checked & MATCHES (no bug):** offset closes the original loan with the
  exiting lender (status Repaid) and does **not** rewrite `loan.lender`
  (only loan-init + `migrateLenderPosition` write it). So the offset's
  `heldForLender` is owed to / claimed by the exiting lender per §1210.
- **CANDIDATE BUG (G1) — log to `_CodeVsDocsAudit.md`:** the reservation
  release keys on `loan.principalAsset`, but the claimable asset is
  authoritative as `lenderClaims[loanId].asset` (which can be
  `collateralAsset`). This is a real release/asset mismatch for VPFI-
  collateral claims and is fixed by this design (§4.1).

## 4. Design

### 4.1 Claim-asset keying (fixes G1)

Make the reservation key on the **deposited/claim asset**, end to end:

- **Reserve sites:** gate on `claimAsset == s.vpfiToken` and reserve
  `claimAsset`, where `claimAsset` is the asset actually deposited into the
  lender vault at that site — `loan.principalAsset` for the cash-settled
  terminals, `loan.collateralAsset` for the in-kind/illiquid default
  branch. (Today every gated site happens to use `principalAsset`; this
  adds the in-kind default branch with `collateralAsset`.)
- **Release point (ClaimFacet) — RECORD the reserved asset, release under
  it** (refined after Codex round-4). Releasing under any *derived* asset —
  `loan.principalAsset` OR `lenderClaims[loanId].asset` — is fragile: the
  loan's single per-loan reserved amount (`s.lenderProceedsEncumbered`) is
  ticked under exactly **one** aggregate, and the release must decrement
  **that same** aggregate, which equals neither derived value in general (a
  loan that reserved under principal and later resolves to a collateral
  claim would underflow the collateral bucket and leave the real reservation
  stuck). So the reserve **records the asset**
  (`s.lenderProceedsEncumberedAsset[loanId]`) and `releaseLenderProceeds`
  takes **no asset argument** — it releases under the recorded asset.
  Reserve/release are then self-consistent by construction. A loan reserves
  lender-proceeds at its **single terminal**, so the recorded asset is
  written once; a second reserve under a different asset is an invariant
  break (`assert`, no ABI surface).

*Why record and not derive:* only the value captured at reserve time is
authoritative; neither `principalAsset` nor `lenderClaims.asset` is
guaranteed to be the asset the reservation was actually ticked under.

### 4.2 Held-for-lender reservation + re-key (fixes G2)

`heldForLender` is a *second* claimable VPFI balance per loan, distinct
from `lenderClaims`. Two new needs:

1. **Reserve at accrual.** At each `s.heldForLender[loanId] += amount`
   site (offset `_settleOffsetPayments`, `transferObligationViaOffer`),
   when the deposited `payAsset == s.vpfiToken`, reserve `amount` for
   `loan.lender`. Track it separately from the `lenderClaims` reservation
   so the two release independently.
2. **Re-key on vault change.** The reserved VPFI must follow the vault
   that physically holds it. The only mid-loan mover of both the vault
   *and* `loan.lender` is `migrateLenderPosition` (the **sale** path),
   which also migrates `priorHeld` old→new vault
   (`EarlyWithdrawalFacet` ~L297-309). The reservation must migrate in the
   same step: decrement the old lender's `encumbered[old][vpfi][0]` and
   increment the new lender's by the migrated amount.

**Storage:** `s.lenderProceedsEncumbered[loanId]` currently records one
per-loan reserved amount. Held-for-lender needs its own per-loan record so
the two release/migrate independently. Options in §5.

**Release:** `ClaimFacet` pays `heldForLender` to the current holder
(ClaimFacet ~L384). Add a `releaseHeldForLenderReservation(loanId, …)`
immediately before that withdraw, mirroring `releaseLenderProceeds`.

### 4.3 What stays out of scope (with reasons)

- **Wallet-direct payments** (partial repay, periodic-interest shortfall):
  pay the lender's *wallet*, not a vault — nothing tracked to drain.
- **Partial liquidation** (`RiskFacet.triggerPartialLiquidation`): deposits
  to the lender vault with **no deferred claim** — proceeds belong to the
  lender at liquidation time, not a later holder. (Re-confirm against spec
  during implementation; if the spec implies these are owed to a later
  holder, it moves in scope.)
- **Staking yield** — rule (2); structurally excluded.

## 5. Design forks — DECIDED (2026-06-14, owner)

- **F1 → (a)** separate `s.heldForLenderEncumbered[loanId]` record.
- **F2 → (a)** re-key old→new in `migrateLenderPosition` / sale `priorHeld`
  migration; raw lender-NFT transfer needs no re-key (vault unchanged).
- **F3 → (a)** split: **G1 (claim-asset keying) + the #596 terminal gates**
  land now as one PR; **G2 (held-for-lender + re-key)** lands as **#597**.

Original fork write-up retained below for context.

## 5b. Design forks (write-up)

**F1 — Held-for-lender reservation storage.**
- **(a) Recommended:** add `s.heldForLenderEncumbered[loanId]` (a second
  per-loan record) parallel to `s.lenderProceedsEncumbered[loanId]`.
  Cleanest separation; each releases/migrates independently; append-only
  storage (pre-live, cheap). One extra mapping.
- (b) Fold both into a single `s.lenderProceedsEncumbered[loanId]` total.
  Less storage, but the two are released at *different* points in
  `ClaimFacet` (proceeds before the lenderClaims withdraw; held before the
  held withdraw) and on different assets — a single total can't release
  them independently without extra bookkeeping. Not recommended.

**F2 — Re-key vs. forbid.**
- **(a) Recommended:** re-key the reservation in `migrateLenderPosition` /
  the sale's `priorHeld` migration (and treat a raw lender-NFT
  `transferFrom` as covered, since that doesn't move the vault — the
  reservation stays correctly on `loan.lender`). Matches the spec's
  "claims follow the NFT" with no UX restriction.
- (b) Forbid selling a loan while it has a non-zero VPFI reservation.
  Simpler, but a real UX regression (blocks legitimate sales) and
  off-spec. Not recommended.

**F3 — Scope of this PR vs. follow-up.**
- **(a) Recommended:** land **G1 (claim-asset keying)** + **the terminal
  gates already in #596** as one correct PR (low-risk, self-contained),
  and land **G2 (held-for-lender + re-key)** as a second PR (#597) since
  it touches the offset/sale/claim paths and warrants its own review pass.
- (b) One PR for everything. Larger blast radius + review surface.

## 6. Implementation sketch (once forks are chosen)

- **G1:** add `collateralAsset` reserve at the in-kind default branch
  (`DefaultedFacet` ~L500-510); switch the ClaimFacet release to
  `lenderClaims[loanId].asset`; re-confirm every existing gate keys on its
  deposited asset.
- **G2:** new `heldForLenderEncumbered` record + `encumberHeldForLender` /
  `releaseHeldForLenderReservation` / `migrateLenderProceeds` primitives in
  `LibEncumbrance`; reserve at the two `heldForLender +=` sites; migrate in
  `migrateLenderPosition` + the sale `priorHeld` block; release before the
  `ClaimFacet` held withdraw.

## 7. Test plan

- VPFI-collateral default: claim reserved + released on the **collateral**
  asset; stored lender's `withdrawVPFIFromVault` blocked; holder paid.
- Held-for-lender (offset/transfer): reserved at accrual; blocked; released
  to current holder on claim.
- **Sale re-key:** held-for-lender reserved under old lender; loan sold
  (`migrateLenderPosition` + `priorHeld` migration); reservation moves
  old→new; old lender cannot unstake; new holder claims, released.
- Regression: every existing #592 terminal gate + the merged #585 path
  unaffected (release now keys on `lenderClaims.asset == principalAsset`).
- Mirror the `Vpfi592LenderProceedsTest` seed-based harness.

## 8. Open items

- Log G1 to `docs/FunctionalSpecs/_CodeVsDocsAudit.md`.
- Re-confirm partial-liquidation ownership against the spec during impl.
