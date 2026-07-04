# Sanctions close-out sweep completion + sale-vehicle accept correctness

**Status:** design → Codex review (docs-only) → implementation.
**Drives:** the outstanding Codex findings on PR #981 (`audit/954`, sanctions
gate sweep — 11 findings) and PR #959 (`feat/951`, sale-vehicle v2 bind-to-live
— 2 P1s). This document is the plan; nothing here is implemented yet.

Line references are against the branches as reviewed by Codex
(`audit/954-sanctions-gate-sweep` @ `cb3c3796` for #981,
`feat/951-loan-sale-offer-onchain-fix` @ `dcae1049` for #959).

### Baseline already in the target branches (this plan BUILDS ON these)

This doc lives on a branch off `main`, but the fixes land on the two feature
branches above, which already contain earlier work. When reading the plan,
assume the following is ALREADY present (so items that look "missing" against
`main` are done):

- **On `audit/954` @ `cb3c3796`** — `claimAsBorrower` already reads
  `s.borrowerSurplusClaims[loanId]` (ClaimFacet:1075-1077), folds the surplus
  into its `NothingToClaim` guard, PAYS it out via a `vaultWithdrawERC20` after
  the extra-lien block, and includes the surplus asset in its post-withdraw VPFI
  restamp guard. So §2.4 below is ONLY the *`claimAsLender` settle-predicate*
  addition; the borrower-side pay-out + restamp already exist.
- **On `feat/951` @ `dcae1049`** — `_bindTermsToOffer` already binds a
  sale-vehicle `t.amount == live saleLoan.principal` (and `t.durationDays ==
  live loan.durationDays`, collateral `>=` live). So §3.2 below only has to make
  the *fund movement* (`effectivePrincipal`) read the same live loan; the BIND
  already targets live, so "buyer signs stale then charged live" cannot happen
  once the charge is aligned (they must sign live to pass the bind).

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

**Also reserve the frozen lender proceeds for EVERY ERC20 (Codex #986 catch).**
Symmetric to §2.1: parking the lender payment in `loan.lender`'s vault is not
enough, because `createSignedOfferVault` treats any tracked ERC20 balance minus
`s.encumbered` as spendable. When the lender NFT was transferred to a
now-sanctioned holder, consolidation skips and these proceeds are owed to that
holder while sitting in the STORED `loan.lender`'s vault — so the stored lender
could spend them via a signed offer before the holder delists. Reserve them via
`LibEncumbrance.encumberLenderProceeds` for every ERC20 (the existing helper is
VPFI-only; extend/gate it the same way §2.1 does for the borrower surplus), and
release it on `claimAsLender`. Confirm `claimAsLender` already calls
`releaseLenderProceeds` before its withdraw (it does for VPFI today; make the
reserve+release asset-agnostic).

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

**Also re-lien the returned residual collateral (Codex #986 catch).** The intent
COMMIT path decrements the full collateral lien when it pulls collateral into
diamond custody; `_runSettlement` returns any partial-fill residual to the
stored borrower vault and records `loan.collateralAmount − consumed` as a
`borrowerClaims` row. Adding only sanctions freezes leaves that returned residual
UN-liened in the stored borrower's vault, so a transferred-away stored borrower
could drain it before the current holder claims. Mirror `swapToRepayFull`'s
re-lien (`EncumbranceMutateFacet.incrementCollateralLien(loanId, refund)` after
the residual is pushed back) so the residual stays protected until
`claimAsBorrower` releases it. Verify against `swapToRepayFull:480-488` which
already does this.

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

**Codex #986 correction — do NOT subtract the whole `s.encumbered` bucket.** My
first draft proposed stamping the tier from `trackedVpfiBalance(user) −
s.encumbered[user][vpfi][0]`. That is WRONG: `s.encumbered[user][vpfi][0]` is a
SHARED aggregate that also holds a user's OWN active VPFI collateral liens,
lender-intent capital, and lender-offer principal (`LibEncumbrance` lines ~123,
365, 542). Subtracting all of it would wrongly strip a user's own pledged /
listed / intent-funded VPFI from their tier — a legitimate-usage regression. The
exclusion must be scoped to ONLY the frozen surplus owed to someone else.

**Chosen approach — a dedicated per-owner "frozen VPFI owed to others" counter:**

- Add `mapping(address => uint256) frozenVpfiOwedByVault` (append to Storage).
  On a VPFI surplus freeze (into `loan.borrower`'s vault for a sanctioned
  holder), increment `frozenVpfiOwedByVault[loan.borrower] += surplus`. On
  `claimAsBorrower` paying that surplus (and on any release path), decrement it.
- The VPFI tier balance for a user becomes `trackedVpfiBalance(user) −
  frozenVpfiOwedByVault[user]` (floored at 0), applied at every tier-stamp site
  (`LibConsolidation.restampUserVpfi` / `_restampVpfi`, and `pokeMyTier`'s
  rollup source). This subtracts ONLY the frozen-surplus VPFI, never the shared
  `s.encumbered` bucket, so legitimate self-encumbrances keep their tier.
- The surplus is STILL also encumbered via §2.1 (in `s.encumbered[...][0]`) so
  `freeBalance` blocks the signed-offer spend. The two mechanisms are
  independent: `s.encumbered` gates spendability (shared bucket, fine to share);
  `frozenVpfiOwedByVault` gates tier (must be scoped). Both released at claim.

This keeps the funds in `loan.borrower`'s vault (no `recoverStuckERC20` concern,
no bespoke escrow claim path) while making both the spend-guard and the tier
honor the fact that the VPFI belongs to the delistable holder, not the vault
owner. (Rejected: option B — diamond escrow under a non-tier counter — is
heavier and reintroduces the sweep concern for no extra safety here.)

### 2.3 Surface the new claim lane in read views + event (P2)

`borrowerSurplusClaims` is a second borrower claim lane, but the read surfaces
expose only `borrowerClaims`, so a delisted holder with a surplus-only close
sees a zero/collateral-only claim and can't discover the funds:
- `ClaimFacet.getClaimableAmount` (reads borrowerClaims @1729),
- `ClaimFacet.getClaimable` (@1787),
- `MetricsFacet.getNFTPositionSummary` (@1760),
- **`MetricsDashboardFacet.getUserDashboardClaimables` + `_countClaimables`**
  (Codex #986 catch) — these walk `s.borrowerClaims[lid]` and SKIP entries with
  `ci.amount == 0`, so a surplus-only loan shows zero borrower claimables in the
  dashboard snapshot too. Must surface the surplus lane here as well (count it +
  include its asset/amount), else wallets relying on the dashboard miss it.
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

*Note (re Codex's "add the surplus lane to `claimAsBorrower` itself"):* on the
target branch (`audit/954` @ `cb3c3796`) `claimAsBorrower` ALREADY folds the
surplus into its `NothingToClaim` guard AND pays it out (see Baseline). So a
surplus-only close is payable there; this §2.4 change is the missing *lender*-side
settle-predicate half that keeps the loan open long enough for that payout to be
reachable. Both halves are required; only the lender half is new.

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

On the target branch (`feat/951` @ `dcae1049`) the bind ALREADY enforces
`t.amount == live saleLoan.principal` for a sale vehicle (see Baseline — the v2
`_bindTermsToOffer` sale branch; NOT the `main` snapshot the review saw). But the
value actually funded — `effectivePrincipal` (924-930) and the borrower-pull
(1019) — is still read from the stale `offer.amountMax`/`offer.amount`, never
re-read from `loan.principal`. So the buyer must SIGN the live principal to pass
the bind, yet the charge uses the stale offer amount → a mismatch (over/underpay)
whenever the live principal has drifted since listing. (Codex's concern — "buyer
signs stale then charged live" — is exactly why bind AND charge must both be
live; the bind is already live, so aligning the charge closes it.) If
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

## Storage additions (append-only, at Storage struct end)

- `mapping(address => uint256) frozenVpfiOwedByVault` (§2.2) — per-owner VPFI held
  in-vault but owed to a delistable holder; subtracted from the tier balance.
- (`borrowerSurplusClaims` already exists on `audit/954`.)
- A per-loan lender-proceeds encumbrance for non-VPFI already has storage via
  `LibEncumbrance` (`lenderProceedsEncumbered*`); §1.1 just removes the VPFI gate.

## Resolved from Codex round 1

- §2.2 tier-exclude is now SCOPED to a dedicated `frozenVpfiOwedByVault` counter,
  not the shared `s.encumbered` bucket (which holds legit self-encumbrances).
- §1.1 lender leg now also encumbers non-VPFI proceeds (symmetric to §2.1).
- §1.4 intent path now re-liens the returned residual collateral.
- §2.3 now includes `MetricsDashboardFacet.getUserDashboardClaimables` /
  `_countClaimables`.
- §2.4 / §3.2 baseline clarified — the borrower-side surplus payout (audit/954)
  and the live-principal BIND (feat/951) already exist; only the lender settle
  predicate and the fund-movement charge are new.

## Open questions for Codex

- §3.1: honor `offerCancelled` globally at `_acceptOffer` entry — any legitimate
  flow that accepts a `offerCancelled` offer? (None known; it's the canonical
  "dead offer" marker.)
- §2.3: surface the surplus lane as extra return fields on the existing borrower
  claim views vs a dedicated `getBorrowerSurplusClaim` getter — preference for the
  frontend/indexer contract? (Plan leans to explicit extra fields so a claim can
  report BOTH residual-collateral and principal-surplus lanes without losing the
  asset/amount of either.)
