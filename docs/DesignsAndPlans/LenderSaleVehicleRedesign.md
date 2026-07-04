# Lender Position-Sale ("Sale Vehicle") Lifecycle Redesign

**Status:** design → implementation (PR #959, redesign pass).
**Origin:** #951 (createLoanSaleOffer could not complete on-chain). The
incremental-fix PR #959 went through three Codex review rounds, each surfacing a
deeper issue because the flow had never run end-to-end. Owner direction: step
back and redesign the whole lifecycle, addressing every surfaced issue in one
coherent pass.

## Scope

The lender position-sale ("sale vehicle") flow: an exiting lender lists their
live loan position at their own rate via
`EarlyWithdrawalFacet.createLoanSaleOffer`, a buyer takes over the lender side,
and the live loan's lender relationship transfers. Phase 1 is **ERC-20 principal
+ ERC-20 collateral** only (NFT-collateral lender-sale is tracked as #974).

The sale vehicle is a **Borrower-type offer** (`amount = loan.principal`,
`collateralAmount = 0` — it escrows no fresh collateral; the real collateral
stays on the live loan) linked to the live loan via
`saleOfferToLoanId` / `loanToSaleOfferId`. A buyer accepts it; `acceptOffer`
pays the sale principal to the seller (the offer creator) and auto-completes the
sale in the same transaction.

## The root cause behind most of the findings

Every terminal loan flow (repay, default, preclose, refinance, swap-to-repay, …)
calls **`LibConsolidation.consolidateToHolder(loanId, isLenderSide, ctx)`**
before mutating a side, which re-anchors that side's stored identity
(`loan.lender` / `loan.borrower`) **and** its vaulted value (`heldForLender`,
liens, reward entry, VPFI stamp) to the current position-NFT holder
(`ownerOf(tokenId)`). This keeps *stored identity == economic identity*.

`EarlyWithdrawalFacet.createLoanSaleOffer` **does not** consolidate. So when a
lender position was transferred on the secondary market but not yet
consolidated, `loan.lender` is **stale** while `ownerOf(lenderTokenId)` (the
seller who lists and whom `acceptOffer` pays) is the real economic party. The
completion path then has to choose an identity for each operation, and the two
diverge:

- `heldForLender[loanId]` physically sits in the **stored `loan.lender`** vault →
  the held-proceeds migration must pull `from` the stored lender (Codex R3-P1).
- The sale principal was paid to the **current holder** → accrued/shortfall
  settlement must be against the current holder (Codex round-2 finding-3).

Trying to satisfy both with a single hand-rolled `originalLender` identity is
what produced the P1 regression. The fix is to **remove the divergence at the
source**: consolidate the lender position to the current holder at listing time,
so `loan.lender == ownerOf(lenderTokenId) == seller` for the entire sale, and
the completion path can use `loan.lender` uniformly (identity == custody ==
who-was-paid).

## Design

### D1 — Consolidate the lender position at listing (root fix)

`createLoanSaleOffer` calls `LibConsolidation.consolidateToHolder(loanId,
/* isLenderSide */ true, ctx)` **before** it locks the NFT and creates the sale
offer. After this, `loan.lender` and `heldForLender` are re-anchored to the
seller. This mirrors the #656 pattern where the collateral-listing flows
consolidate the borrower side before binding a listing.

**Skipped case:** `consolidateToHolder` returns `Skipped` for a lender position
carrying *unreserved* `heldForLender` VPFI (the #597 `_isExcludedLive` guard) —
the lien re-key can't carry an unreserved reservation. A position in that state
cannot be safely sold (its stored/economic identity can't be unified), so
`createLoanSaleOffer` **reverts** when consolidation is skipped, with a typed
error (`SalePositionNotConsolidatable`). This is a rare edge; the seller resolves
the held VPFI first. The invariant "a successfully-listed sale has
`loan.lender == seller`" then holds unconditionally.

### D2 — Completion settles uniformly against `loan.lender`

With D1, `_completeLoanSaleImpl` reverts the round-2 `originalLender =
ownerOf(...)` change back to `originalLender = loan.lender` (now authoritative):
the held-proceeds migration, the `releaseLenderProceeds` reservation release, and
the accrued/shortfall settlement all key on the same consolidated identity.
Resolves R3-P1 and round-2 finding-3 together with no divergence.

### D3 — Direct-accept only; block sale vehicles from the range matcher

A position sale is an all-or-nothing full-principal transfer, not a range/partial
order. On the `OfferMatchFacet.matchOffers` path `_acceptOffer` runs with
`matchOverride.active` → `deferAcceptFlip = true`, so `offer.accepted` is set only
later in the dust-close block — *after* the auto-complete crossFacetCall has
already run and reverted `SaleOfferNotAccepted` (Codex R3-P2). Rather than thread
the accept-flip earlier, we **reject a sale-vehicle borrower offer from the match
path** (typed `SaleVehicleNotMatchable`). Sale vehicles are accepted through the
direct `acceptOffer` path only, where `accepted` is set before the auto-complete.

### D4 — Freeze a linked sale offer against mutation

`OfferMutateFacet._assertMutableBy` (the shared gate for `setOfferAmount` /
`setOfferRate` / `setOfferCollateral` / `modifyOffer`) gains a guard: a linked
sale offer (`saleOfferToLoanId[offerId] != 0`) is **immutable**. Once listed, the
sale offer's economics are fixed until it is accepted or cancelled — a seller
cannot lower `amount`, change the rate, or set a positive collateral after
linking, which would desync the vehicle from the live loan (Codex R3-P2). Typed
error `SaleVehicleImmutable`.

### D5 — Frontend decoder entries

`packages/lib/src/decodeContractError.ts` gains the new typed reverts so the dapp
surfaces friendly messages instead of raw selectors:
`SaleOfferCollateralMustBeERC20`, `SaleOfferAlreadyExists`, and the new
`SalePositionNotConsolidatable`, `SaleVehicleNotMatchable`, `SaleVehicleImmutable`.

### Retained from the earlier PR passes (already correct)

- Posting fix: `_submitSaleOffer` → `createOfferInternal` (reentrancy) with the
  seller as explicit creator; the `saleVehicleCreate` ceiling + collateral-pull
  exemptions.
- `completeLoanSaleInternal` (address(this)-gated) + routing `acceptOffer`'s
  auto-complete to it (accept→complete reentrancy P1).
- ERC-20-collateral Phase-1 scope (`SaleOfferCollateralMustBeERC20`).
- One-listing-per-loan guard + link teardown on completion (cancel already
  cleared the links).
- Lock the lender NFT before the create hop.

## Invariants

- A successfully-listed sale has `loan.lender == ownerOf(lenderTokenId) ==
  seller` (D1). Custody, stored identity, and who-was-paid never diverge.
- A linked sale offer is immutable and non-matchable; it can only be accepted via
  direct `acceptOffer` or cancelled (D3, D4).
- On cancel or completion both link directions and the NFT lock are cleared, so a
  genuine re-list is always possible afterward.
- Held-for-lender VPFI always moves stored→current in one atomic step (via
  consolidation at listing, then the existing migration at completion).

## Test matrix (unmocked where feasible)

1. Direct accept E2E: list → buyer accepts → auto-complete; lender migrates to
   buyer; accrued/shortfall settled against the seller; links + lock cleared.
2. Transferred-but-unconsolidated position: list consolidates to the current
   holder; settlement + held-proceeds all key on that holder; no divergence.
3. Unreserved-held position: `createLoanSaleOffer` reverts
   `SalePositionNotConsolidatable`.
4. Match path: matching a linked sale vehicle reverts `SaleVehicleNotMatchable`.
5. Mutation: `setOfferAmount`/`setOfferRate`/`setOfferCollateral`/`modifyOffer`
   on a linked sale offer reverts `SaleVehicleImmutable`.
6. NFT-collateral loan: `createLoanSaleOffer` reverts
   `SaleOfferCollateralMustBeERC20` (#974 tracks lifting this).
7. Cancel: links + lock cleared, no collateral-refund attempt, re-list works.
8. Duplicate listing reverts `SaleOfferAlreadyExists`.

---

# v2 — Bind-to-live (dissolves the round-4→8 finding class)

**Status:** design → implementation (PR #959, redesign pass 2). **Owner-approved.**

## Implementation sequencing — #980 is a hard prerequisite

The core of v2 adds the sale-vehicle live-binding branch to
`OfferAcceptFacet._bindTermsToOffer`. That facet is **at the EIP-170 24,576-byte
ceiling** (24,564 B before this change; #980 tracks it), and the binding branch
adds ~140 B → the facet compiles at ~24,725 B and fails `FacetSizeLimit`. A
compact inline-ternary rewrite did not help (ternaries over storage reads are no
smaller). So **v2 cannot land until `previewAccept` is extracted into its own
facet (#980)**, which frees ~2.5 KB of OfferAcceptFacet headroom AND is where v2
needs to move the "preview reads live" work anyway. Order of work:

1. **#980 first** — extract `previewAccept` (+ `AcceptPreview` / `AcceptError`)
   into a new `OfferPreviewFacet`; full facet-addition checklist (DiamondFacetNames,
   SelectorCoverage ×2, FacetSizeLimit, DeployDiamond, HelperTest, RedeployFacets,
   exportFrontendAbis + barrel) and re-cut every test that cuts OfferAcceptFacet +
   calls `previewAccept` (PreviewAccept / OfferPrincipalLock / OfferExpiry /
   RiskAccessAcceptGate / EarlyWithdrawalFacet tests).
2. **Then v2** — the `_bindTermsToOffer` live-binding (below), the LoanFacet
   freshness-check removal + current-holder self-buy/compliance, drop the
   `saleListingCollateral` snapshot, the listing-teardown-on-exit hook, and the
   live previews.

(The v2 code was prototyped and reverted at this checkpoint precisely because it
overflowed the ceiling; the branch stays at its functional round-7 state until
#980 lands.)

## The second root cause

After the v1 redesign made the flow *run*, Codex rounds 4→8 surfaced a steady
stream of P1/P2 findings that are **all one class: snapshot-vs-live divergence.**
`createLoanSaleOffer` copies the live loan's state into an **immutable** sale
offer (`amount = loan.principal`, `durationDays = remaining-at-listing`, the
seller's sale `interestRateBps`) plus a side snapshot (`saleListingCollateral`).
The buyer signs those copied values via the #662 `AcceptTerms` equality checks,
but `completeLoanSale` settles them into the **live** loan. So every loan field
that can drift between listing and accept becomes its own freshness patch:

| Field | Drifts on | Patch it forced |
|-------|-----------|-----------------|
| principal | partial repay | R4 freshness `offer.amount == loan.principal` |
| collateral | withdraw / periodic auto-liq / add | R6 `saleListingCollateral` snapshot + check; R7 `<` refinement |
| remaining term | **every block** (continuous) | R8 — can't be patched with equality |
| borrower identity | position-NFT transfer | R8 P1 — stale `linked.borrower` |
| loan status | repay / default before sale | R8 P2 — stale links not torn down |
| preview parity | all of the above | R8 P2/P3 — preview didn't mirror the checks |

Term-drift is the tell: it changes every block, so no equality check against a
snapshot can converge. Patching per field is an open-ended tail.

## The fix — bind the accept to the live loan's IMMUTABLE facts

The #662 machinery already binds the buyer to per-field values via equality, and
`AcceptTerms` already carries `linkedLoanId`. So **for a sale vehicle, point the
equality checks at the live loan instead of the stale offer snapshot** — the
buyer signs the live position and the anti-phishing guarantee now protects
against loan drift, not offer-copy drift. Crucially, bind to facts that are
*immutable or discrete*, never the continuously-shrinking remaining term:

`_verifyAndBindAccept`, sale-vehicle branch (`saleOfferToLoanId[offerId] != 0`),
binds the buyer's `AcceptTerms` against `s.loans[linkedLoanId]`:

- **principal** (`t.amount`) `==` live `loan.principal` — discrete (changes only
  on repay); a repay between view and mine forces a re-sign (correct: the buyer
  pays for exactly the principal they accept).
- **duration** (`t.durationDays`) `==` live `loan.durationDays` — the loan's
  **original, immutable** duration, NOT remaining-days. Fixed for the loan's life
  → no drift. The buyer is buying a position that matures at the fixed
  `startTime + durationDays`; the remaining term is derived and shown live in the
  UI, never bound. (Bind `startTime` too so the fixed maturity is pinned.)
- **collateral** (`t.collateralAmount`) `>=`-style: require live
  `loan.collateralAmount >= t.collateralAmount`. A reduction (withdraw / auto-liq)
  fails the buyer's floor → revert; a harmless top-up (`addCollateral`, still
  permitted) only improves the position and passes (R7's exact concern, now
  structural). The buyer signs the collateral they reviewed as a **minimum**.
- **rate** (`t.interestRateBps`) `==` the **seller's** sale rate on the offer —
  this one genuinely IS the seller's immutable ask, so it correctly binds to the
  offer (unchanged).

## What this removes vs. keeps vs. adds

**Removes** (now enforced structurally by the live-binding, or moot):
- The LoanFacet `initiateLoan` sale-vehicle freshness checks (principal, collateral).
- The `saleListingCollateral` storage mapping + its write/cleanup (collateral is
  bound `>=` live at accept; no snapshot to store or drift).
- The term-staleness patch that R8 asked for (duration binds to the immutable
  loan duration; no window needed).

**Keeps** (not snapshot-drift — real invariants):
- Linked loan must be **Active** at accept (else the position doesn't exist).
- **Self-buy** guard — buyer ≠ the loan's **current** borrower, resolved via
  `ownerOf(borrowerTokenId)` (R8 P1 fix: current holder, not stored `borrower`).
- Sanctions (both parties) + **buyer-vs-current-borrower** compliance recheck.
- D1–D4 (consolidate-at-listing, uniform completion, non-matchable, immutable).

**Adds** (clean lifecycle hooks, not drift-patches):
- **Listing teardown on loan exit** (R8 P2): when a listed loan reaches a terminal
  state without a sale (repay / default / liquidation), clear both link
  directions, unlock the lender NFT, and mark the sale offer cancelled — so a
  stale listing can't linger with a locked NFT. Implemented as a shared
  `LibSaleListing.teardownOnLoanExit(s, loanId)` helper, exposed via a
  **permissionless** `OfferCancelFacet.teardownStaleSaleListing(loanId)` entry
  (anyone — seller / keeper / frontend — may trigger it once the loan is
  terminal; no value moves, mirroring the #195 lazy-clear of expired offers).

  *Why lazy, not an automatic hook on the terminal transition:* the original
  intent was to call the helper from the single `LibLifecycle` transition
  chokepoint so no path could forget it. Measured, that inlines the ~500-byte
  teardown body (and even a slim cross-facet stub) into every facet that
  transitions a loan — and the three that drive terminal transitions
  (`RepayFacet`, `DefaultedFacet`, `RiskFacet`) all sit within a few hundred
  bytes of the EIP-170 ceiling, `RiskFacet` within ~1 byte. Any addition to the
  transition path overflows them. Crucially, **fund-safety never depended on the
  teardown**: a stale listing can't be over-accepted because
  `LoanFacet.initiateLoan` already rejects a sale-vehicle accept whose linked
  loan is not Active (kept invariant). The teardown is pure hygiene (free the
  seller's NFT, drop the dead offer from the book), so a permissionless lazy
  entry is the right cost/benefit — and it's idiomatic here (#195). Making it an
  automatic hook is a follow-up gated on first freeing headroom in the three
  terminal facets (a `previewAccept`-style extraction, cf. #980).
- **Preview reads live** (R8 P2/P3): `previewAccept` computes its sale-vehicle
  projection + blockers from the live loan (mirroring the bind), and
  `previewIntent` / `_previewMatchCore` gains the sale-vehicle non-matchable
  check that `previewMatch` has.

## Findings dissolved (round → mechanism)

- R4 principal freshness, R6/R7 collateral snapshot, R8 term-staleness →
  **gone**: the buyer binds to live principal/duration/collateral directly.
- R8 P1 stale borrower → self-buy/compliance resolve the **current** holder.
- R8 P2 stale links → explicit **teardown-on-exit** hook.
- R8 P2/P3 preview parity → preview reads live + gains the intent check.

## Migration / compatibility notes

- The sale offer no longer needs to store loan-derived `amount` / `durationDays`
  as load-bearing values (they're re-read live at accept). Keep them populated
  for display/back-compat, but the **verifier** reads the live loan.
- Pre-live platform: no deployed state to migrate; the `saleListingCollateral`
  mapping is removed from `LibVaipakam.Storage` (append-only discipline: it was
  the last field added; removing it is safe pre-deploy, or leave it unread/dead
  if strict append-only is preferred — decide at implementation).

## Test matrix (v2 additions)

9.  Repay-then-accept-stale: partial-repay after listing → buyer signing the old
    principal reverts on the live-binding; signing the new live principal succeeds.
10. Collateral top-up after listing → accept still succeeds (`>=`); reduction →
    reverts.
11. Time passes after listing → accept still succeeds (duration binds to the
    immutable loan duration, not remaining).
12. Borrower NFT transferred after listing → self-buy guard checks the current
    holder; the new holder buying reverts, a third party succeeds.
13. Loan repaid/defaulted while listed → a later accept already reverts as
    terminal (the `LoanFacet` Active-check, before any teardown); then the
    permissionless `teardownStaleSaleListing(loanId)` clears both links, unlocks
    the lender NFT, and marks the offer Cancelled. Guards: it reverts
    `SaleListingLoanStillLive` on an Active / FallbackPending loan and
    `NoStaleSaleListing` when no live (unaccepted) listing exists.
14. `previewAccept` and `previewIntent` mirror the live-bound blockers.

## Out of scope / follow-ups

- #974 — NFT-collateral lender-sale (complete/cancel collateral handling).
- #927 — re-enable the listing UI once the flow is solid.
