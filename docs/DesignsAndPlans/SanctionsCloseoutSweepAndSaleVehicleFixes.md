# Sanctions close-out sweep completion + sale-vehicle accept correctness

**Status:** design → Codex review (docs-only) → implementation.
**Drives:** the outstanding Codex findings on PR #981 (`audit/954`, sanctions
gate sweep — 11 findings) and PR #959 (`feat/951`, sale-vehicle v2 bind-to-live
— 2 P1s). This document is the plan; nothing here is implemented yet.

Line references are against the branches as reviewed by Codex
(`audit/954-sanctions-gate-sweep` @ `cb3c3796` for #981,
`feat/951-loan-sale-offer-onchain-fix` @ `dcae1049` for #959).

---

## 0. Background — the freeze-at-source model (already established)

Every fund-touching external method is one of two postures (see
`docs/DesignsAndPlans/SanctionsGateCoverageMatrix.md`):

- **Tier-1** (creates state / pays value to the caller): screen the acting
  wallet up front, hard-revert `SanctionedAddress` for a flagged one.
- **Tier-2** (close-out — repay / default / liquidation / periodic servicing):
  MUST complete regardless of either party's status so the honest counterparty
  is made whole. A flagged party's proceeds are **frozen** (parked in a vault
  behind the claim-side sanctions gate) rather than the tx being blocked.

The reference implementation is `RepayFacet` (scouted):
- **Lender leg** → receive-side exemption `LibSanctionedLock.begin(s, lender)` …
  deposit … `end(s, lender, loanId, asset, amount)` (repayLoan:332-345); the
  flagged lender's proceeds land in their own tracked vault, claimable once
  delisted via the Tier-1-gated `claimAsLender`.
- **Payer-funded / vault-sourced withdraw** → `beginMoveOut(s, payer)` …
  withdraws … `endMoveOut(s)` (repayLoan NFT branch 449-474), so resolving the
  flagged payer's vault doesn't revert while custody is LEAVING them.
- **Discretionary partial payout** (`repayPartial`) → **hard screen**
  `_assertNotSanctioned(recipient)` on the direct EOA payout (repayPartial:743);
  no freeze, because the Tier-2 escape hatch is a full `repayLoan`.

Two receive-side facts that make the below necessary:
- `VaultFactoryFacet.getOrCreateUserVault(user)` screens `user` and, under the
  receive exemption, resolves an EXISTING vault but REFUSES to mint one for a
  flagged wallet (`SanctionedRecipientHasNoVault`). So freezing must always
  target a vault that already exists (e.g. `loan.borrower`, who posted
  collateral at init; `loan.lender`, who funded).
- `LibEncumbrance.freeBalance(user, asset, id, raw) = raw − s.encumbered[user][asset][id]`
  is consulted by the vault-withdraw guard AND by the signed-offer
  materialisation path, but the **VPFI fee-tier / reward** path reads
  `protocolTrackedVaultBalance` (via `LibConsolidation.restampUserVpfi`), which
  is **blind to `s.encumbered`**. Encumbrance alone therefore does NOT keep
  frozen VPFI out of the parking vault owner's tier.

---

## Part 1 — #981: complete the Tier-2 close-out sweep

The `swapToRepayFull` surplus branch added in `cb3c3796` is correct and is the
model. The sweep is incomplete on five sibling surfaces.

### 1.1 `swapToRepayFull` lender leg bricks for a flagged lender (P1)

`SwapToRepayFacet.sol:359-361` does `getOrCreateVault(loan.lender)` +
`safeTransfer(plan.lenderDue)` + `recordVaultDeposit`, with **no** receive-side
exemption. A lender flagged after init makes an otherwise-clean borrower unable
to close via swap-to-repay (the lender-vault resolution reverts
`SanctionedAddress`).

**Fix:** wrap the lender deposit in `LibSanctionedLock.begin(s, loan.lender)` …
`end(s, loan.lender, loanId, loan.principalAsset, plan.lenderDue)`, exactly as
`repayLoan:332-345`. `loan.lender`'s vault always exists (they funded), so no
mint is needed; the proceeds are frozen behind `claimAsLender`.

### 1.2 `swapToRepayFull` collateral pull bricks for a flagged self-holder (P1)

When the borrower NFT holder IS `loan.borrower` and is flagged after init,
`consolidateToHolder(…Tier2CloseOut)` returns `Skipped` (correctly), then the
collateral pull `vaultWithdrawERC20(loan.borrower, …)` (SwapToRepayFacet:321-330)
resolves `loan.borrower`'s vault through `getOrCreateUserVault`, which screens
the owner and reverts `SanctionedAddress` — bricking the close-out.

**Fix:** wrap the collateral pull in `LibSanctionedLock.beginMoveOut(s, loan.borrower)`
… `endMoveOut(s)`. The move-out exemption is the correct one: custody is LEAVING
`loan.borrower` (to the diamond for the swap), mirroring `repayLoan`'s NFT-branch
prepay withdrawal (449-474). Also covers the partial-fill refund back to
`getOrCreateVault(loan.borrower)` at 480-488 if it can run while flagged.

### 1.3 `swapToRepayPartial` — unscreened direct payouts (P1)

`swapToRepayPartial` is a discretionary, loan-stays-Active partial path (the
analogue of `repayPartial`). It pays `lenderTotal` to `ownerOf(lenderTokenId)`
(SwapToRepayFacet:773) and any surplus to `ownerOf(borrowerTokenId)` (784-787),
both **direct EOA, unscreened**.

**Fix (mirror `repayPartial`):** `_assertNotSanctioned(currentLenderHolder)`
before line 773 and `_assertNotSanctioned(currentBorrowerHolder)` before 784.
Hard revert — NOT a freeze — because this is discretionary; the flagged party's
must-complete escape is `swapToRepayFull` (which freezes). This keeps the
Tier-1/Tier-2 split identical to `repayPartial` vs `repayLoan`.

### 1.4 Fusion intent-fill settlement — no sanctions handling at all (P1)

`LibSwapToRepayIntentSettlement._runSettlement` (called by
`IntentDispatchFacet.postInteraction` for `ORDER_KIND_SWAP_TO_REPAY`) is a
**terminal** swap-to-repay-full via a resolver fill. It has ZERO sanctions
handling: lender leg `getOrCreateVault(loan.lender)` + transfer (225-227) and
surplus `safeTransfer(ownerOf(borrowerTokenId), surplusPrincipal)` (229-235). A
borrower can commit the intent while clean and be flagged before the fill.

**Fix:** apply the *same* freeze pattern as `swapToRepayFull` (this IS the
must-complete terminal, so freeze, don't screen):
- lender leg → `begin/end` freeze on `loan.lender`;
- collateral pull / residual return → `beginMoveOut/endMoveOut(loan.borrower)`;
- surplus → the surplus-freeze branch: `isSanctionedAddress(ownerOf(borrowerTokenId))`
  → `depositLocked(s, loan.borrower, …)` + write `s.borrowerSurplusClaims[loanId]`
  + encumber (§2.1). Requires adding the `LibSanctionedLock` / `LibEncumbrance`
  imports (currently absent from that file).

To avoid duplicating the surplus-freeze block in two places, factor it into a
small internal helper (e.g. `LibCloseoutFreeze.freezeOrPayBorrowerSurplus(s,
loanId, loan, currentHolder, surplus)`) that both `SwapToRepayFacet` and
`LibSwapToRepayIntentSettlement` call. Same for the lender-leg freeze.

### 1.5 `backstopFill` — creator not re-screened at fill (P1)

`setOfferBackstopEligible` screens `msg.sender == o.creator` at opt-in
(BackstopFacet:352), but `backstopFill` (412-459) re-checks only shape /
liquidity, never `o.creator`. A borrower flagged in the opt-in→`eligibleAfter`
window can still have a treasury-funded loan originated to them; downstream
`matchIntent` screens only the solver/backstop vault.

**Fix:** `LibVaipakam._assertNotSanctioned(o.creator)` immediately before
`executeFill` (BackstopFacet:454). This is Tier-1 (originates state + routes
principal to the creator) → hard revert, matching the shape re-assert already
done there.

### 1.6 Matrix update

`SanctionsGateCoverageMatrix.md` currently states the sweep found exactly four
gaps. Add rows 5-9 for the above and correct the "four gaps" conclusion.

---

## Part 2 — #981: frozen-surplus escrow hardening

The surplus is frozen into `loan.borrower`'s vault. Two leaks (Codex P1/P2):

### 2.1 Encumber the frozen surplus for EVERY ERC20 (P1) — chosen approach

Today only a VPFI surplus is reserved (`encumberBorrowerProceeds`). For any
other ERC20 the surplus sits as plain `protocolTrackedVaultBalance` under
`loan.borrower`, and `freeBalance` (which the **signed-offer materialisation**
path consults) sees it as spendable — so the stored borrower can consume a
transferred position's frozen surplus as collateral/funding before the holder
is delisted; the later `claimAsBorrower` withdraw then fails.

**Fix:** remove the `if (principalAsset == vpfiToken)` gate — call
`encumberBorrowerProceeds(loanId, loan.borrower, principalAsset, surplus)` for
**every** ERC20 surplus. `freeBalance` then subtracts it everywhere it matters
(withdraw guard + signed-offer path). `claimAsBorrower` already calls
`releaseBorrowerProceeds(loanId, loan.borrower)` (asset-agnostic) before the
withdraw, so the release path already works for any asset.

Constraint noted: `encumberBorrowerProceeds` asserts a single
`borrowerProceedsEncumberedAsset[loanId]` per loan. A swap-to-repay loan has at
most one borrower surplus, so one asset per loan holds. (If a loan could ever
carry two distinct encumbered borrower assets this assert would trip — it can't
on these paths, but the design flags it.)

### 2.2 Keep the frozen VPFI surplus out of the parking owner's tier (P2)

Encumbrance fixes the spend-as-free-balance leak but NOT the VPFI tier leak: the
tier ring buffer is stamped from `protocolTrackedVaultBalance` (restampUserVpfi,
LibConsolidation:436), blind to `s.encumbered`. So a clean stored `loan.borrower`
holding a transferred position's frozen VPFI surplus gets a tier/reward boost
from funds that aren't theirs, until the holder delists and claims.

**Options (design decision — flagged for Codex):**

- **(A) Encumbrance-adjusted tier stamp (preferred).** Change the VPFI tier
  balance source so it stamps from `trackedVpfiBalance(user) −
  s.encumbered[user][vpfi][0]` (free VPFI), not the raw tracked balance. This is
  the smallest change and is arguably *more correct generally*: reserved
  proceeds owed to another party shouldn't count toward the reserver's tier.
  Risk: it also excludes any *lender*-proceeds VPFI encumbrance from the
  lender's tier — need to confirm that is acceptable / already true (lender
  proceeds are likewise not-yet-owned until claimed). Touch point:
  `LibConsolidation.restampUserVpfi` + `_restampVpfi` (and any direct
  `trackedVpfiBalance` tier reader).

- **(B) Escrow VPFI surplus outside the parking vault.** Hold a frozen VPFI
  surplus in the diamond under a dedicated non-tier counter rather than
  `loan.borrower`'s vault. Cleaner isolation, but reintroduces the
  `recoverStuckERC20`-sweep concern and a bespoke claim path — heavier.

Recommendation: **(A)**. It composes with the encumber-all-ERC20 change (both key
off `s.encumbered`), needs no new storage, and is a single, auditable balance
substitution. §2.1 already encumbers the VPFI surplus, so (A) makes the tier
honor that reservation.

### 2.3 Surface the new claim lane in read views + event (P2)

`borrowerSurplusClaims` is a second borrower claim lane, but the read surfaces
expose only `borrowerClaims`, so a delisted holder with a surplus-only close
sees a zero/collateral-only claim and can't discover the funds:
- `ClaimFacet.getClaimableAmount` (reads borrowerClaims @1729),
- `ClaimFacet.getClaimable` (@1787),
- `MetricsFacet.getNFTPositionSummary` (@1760),
- `BorrowerFundsClaimed` event (emitted @1322 off `claim.*`).

**Fix:** add the surplus lane to each borrower-side read. Preferred shape: keep
the primary return = the collateral `borrowerClaims`, and ADD the surplus as
explicit extra fields (a `surplusAsset`/`surplusAmount` pair) rather than
overloading the single asset/amount slot — a claim can legitimately owe BOTH the
residual collateral AND the principal surplus (different assets), so folding
them into one slot loses information. Emit a distinct `BorrowerSurplusClaimed`
event (or extend the existing emit with the surplus) when `claimAsBorrower` pays
the surplus. Exact struct/return-shape changes are ABI-affecting → re-export
frontend ABIs.

### 2.4 Keep a surplus-only loan open until the surplus is claimed (P1)

`claimAsLender`'s settle predicate (ClaimFacet:971-975) computes
`borrowerHasNothing` from `borrowerClaims.amount == 0 && ERC20 && LIF-rebate == 0`.
When a full swap consumes all collateral and freezes ONLY a principal surplus,
`borrowerClaims.amount == 0`, so a lender-first claim flips `borrowerHasNothing`
true and settles the loan → the delisted holder later hits `InvalidLoanStatus`
in `claimAsBorrower` and never gets the surplus.

**Fix:** add `(s.borrowerSurplusClaims[loanId].claimed ? 0 :
s.borrowerSurplusClaims[loanId].amount) == 0` as a fourth conjunct to
`borrowerHasNothing` at 972-974, so a pending surplus keeps the loan un-Settled
until `claimAsBorrower` pays it.

---

## Part 3 — #959: sale-vehicle accept correctness

### 3.1 A torn-down sale offer can still be accepted as a normal offer (P1)

`teardownStaleSaleListing` sets `s.offerCancelled[saleOfferId] = true` and
deletes `saleOfferToLoanId[saleOfferId]`. But the accept path never reads
`offerCancelled` (guards at OfferAcceptFacet `_acceptOffer` entry are
`creator==0` / `accepted` / `amountFilled` / `offerConsumedBySale` / expired —
729-761; `LoanFacet.initiateLoan` likewise). After teardown the link is gone, so
`_bindTermsToOffer` treats it as a NORMAL offer (`saleLoanId == 0`) and binds
against the stale offer snapshot — a cancelled sale offer could originate a loan.

**Fix (two options — flagged for Codex):**
- **(A) Honor `offerCancelled` at accept (preferred, general hardening).** Add
  `if (s.offerCancelled[offerId]) revert OfferConsumedBySale()` (or a new
  `OfferCancelled` error) at `_acceptOffer` entry (~728). This closes the hole
  for EVERY cancellation path, not just sale teardown, and is a one-line
  invariant. Mirror it in `LoanFacet.initiateLoan` and in
  `previewAccept`/`previewMatch` classification.
- **(B) Make teardown consume the offer via an already-honored guard.** Have
  `teardownStaleSaleListing` also set a guard the accept path DOES read (e.g.
  `offerConsumedBySale[saleOfferId] = true`, or delete `s.offers[saleOfferId]`).
  Narrower but reuses an existing gate.

Recommendation: **(A)** — `offerCancelled` is the canonical "this offer is dead"
marker and the accept path arguably should always have honored it; (B) overloads
a sale-specific flag. (A) needs a check that no legitimate flow relies on
accepting a `offerCancelled` offer — none should.

### 3.2 Charge the live sale principal, not the stale offer amount (P1)

For a sale vehicle the bind enforces `t.amount == saleLoan.principal`
(OfferAcceptFacet:522/533 via `roleAmount`), but the value actually funded —
`effectivePrincipal` (924-930) and the borrower-pull (1019) — is read from the
stale `offer.amountMax`/`offer.amount`, never re-read from `loan.principal`. If
the live principal moved since listing, the bind passes on the signed `t.amount`
yet the fund movement charges the stale offer amount (buyer over/under-pays).

**Fix:** in `_acceptOffer`, when `s.saleOfferToLoanId[offerId] != 0`, source
`effectivePrincipal` (and any principal-pull) from the LIVE
`s.loans[saleOfferToLoanId[offerId]].principal` instead of `offer.amount*`. Since
the bind already guarantees `t.amount == live principal`, `effectivePrincipal`
becomes exactly what the buyer signed. Keep the non-sale path unchanged. Verify
the LIF / fee split (1091-1094) and the borrower-pull (1010-1023) all key off the
corrected `effectivePrincipal`.

(Alternatively bind-and-use `terms.amount` directly for sale vehicles — but the
scout shows the codebase deliberately re-derives from storage after the bind, so
reading the live loan is the smaller, more consistent change.)

---

## Test plan

**#981 close-out sweep (SwapToRepayFacetTest, new IntentSettlement + Backstop tests):**
1. `swapToRepayFull` with a flagged LENDER → completes; lender proceeds frozen in
   lender vault; claimable after delisting.
2. `swapToRepayFull` where the flagged holder IS `loan.borrower` → collateral
   pull does not brick (move-out exemption).
3. `swapToRepayPartial` with a flagged lender holder → reverts `SanctionedAddress`;
   with a flagged borrower holder → reverts. (Clean → succeeds, unchanged.)
4. Fusion intent `_runSettlement` with flagged holder → completes; surplus frozen +
   `borrowerSurplusClaims`; lender leg frozen. Clean → direct payout unchanged.
5. `backstopFill` where `o.creator` was flagged after opt-in → reverts before
   `executeFill`.

**#981 escrow:**
6. Frozen NON-VPFI surplus is encumbered → stored `loan.borrower` cannot use it as
   `freeBalance` in a signed-offer materialisation; claim after delist still pays.
7. Frozen VPFI surplus does not raise `loan.borrower`'s effective tier
   (pokeMyTier / restamp reads the encumbrance-adjusted balance).
8. Surplus-only close (all collateral consumed): lender claims first → loan stays
   un-Settled; borrower delists → `claimAsBorrower` pays the surplus; THEN settles.
9. `getClaimableAmount`/`getClaimable`/`getNFTPositionSummary` surface the surplus
   lane for a surplus-only delisted holder.

**#959:**
10. Torn-down sale offer → `acceptOffer`/`initiateLoan` revert (offerCancelled
    honored); `previewAccept` classifies it blocked.
11. Sale accept charges the LIVE principal after a post-listing partial-repay
    drift (bind + fund movement agree); buyer neither over- nor under-pays.

## Open questions for Codex

- §2.2: option (A) encumbrance-adjusted tier stamp vs (B) diamond escrow — is (A)'s
  global "encumbered VPFI excluded from tier" acceptable for lender-proceeds
  encumbrance too, or must it be scoped to the borrower-surplus reservation only?
- §3.1: option (A) honor `offerCancelled` globally at accept — any legitimate flow
  that accepts a cancelled offer? (None known.)
- §2.3: extra return fields vs a dedicated getter for the surplus lane — preference
  for the frontend/indexer contract?
