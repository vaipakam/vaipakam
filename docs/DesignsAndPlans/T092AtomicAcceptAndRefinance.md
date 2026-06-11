# T-092-H — Atomic accept-and-refinance design document

**Status**: Design — ready for implementation (#539).

**Companion to**: [#549 (design)](https://github.com/vaipakam/vaipakam/issues/549) + [#539 (implementation)](https://github.com/vaipakam/vaipakam/issues/539).

**Prior art**: PR #542 (closed) — first attempt that surfaced the three blocking findings documented below.

## 1. Goal

Make refinance-tagged Borrower offers fire `RefinanceFacet.refinanceLoan` **in the same transaction** as their accept, eliminating the multi-tx race-condition window between Tx 2 (accept, principal lands in borrower wallet) and Tx 3 (refinance, wallet drained to pay old loan).

Pre-T-092-H state:
- Tx 1 — borrower creates a refinance-tagged Borrower offer.
- Tx 2 — new lender accepts (`OfferAcceptFacet.acceptOffer`) OR matcher matches (`OfferMatchFacet.matchOffers`) → new loan created → principal lands in borrower's WALLET.
- Tx 3 — keeper (or anyone) calls `RefinanceFacet.refinanceLoan(oldLoanId, borrowerOfferId)` → wallet pulled to pay old loan.

Between Tx 2 and Tx 3 the borrower's wallet holds the principal exposed to spends, swaps, MEV front-runs, or competing dapp interactions. The operational loan netting documented in PR #538 relies on a best-effort assumption that nothing changes between txs.

Post-T-092-H: every accept that flips a refinance-tagged offer's `accepted = true` ALSO fires the chained refinance in the same atomic tx. Either both loans transition (old → Repaid, new → Active) or the whole tx reverts.

## 2. Why the surgical PR #542 approach failed

Three Codex findings:

### 2.1 P1 — ReentrancyGuard nesting (blocker)

`OfferAcceptFacet.acceptOffer` is `nonReentrant`. The chained `RefinanceFacet.refinanceLoan` is ALSO `external nonReentrant`. The cross-facet call hits `LibReentrancyGuard` while the diamond is `ENTERED` and reverts EVERY tagged-offer accept. The PR as written doesn't work.

### 2.2 P2 — Deferred-accept ordering on matched path

For refinance-tagged offers accepted via `matchOffers` with `partialFillEnabled` on, `offer.accepted = true` is **deferred** to OfferMatchFacet's borrower-side dust-close block ([OfferAcceptFacet.sol:1009-1012](../../contracts/src/facets/OfferAcceptFacet.sol#L1009-L1012)). A chain placed at the end of `_acceptOffer` runs BEFORE that flip → `refinanceLoan`'s `offer.accepted` check ([RefinanceFacet.sol:200](../../contracts/src/facets/RefinanceFacet.sol#L200)) fails with `OfferNotAccepted`.

### 2.3 P3 — AtomicRefinanceFailed doesn't surface

`LibFacet.crossFacetCall` uses `LibRevert.bubbleOnFailureTyped` which re-bubbles inner revert payloads verbatim. `AtomicRefinanceFailed` only fires on empty-revert. The dapp gets the original `RefinanceCapsRequired` / `SanctionedAddress` / etc., not the new wrapper.

## 3. Revised architecture

### 3.1 RefinanceFacet refactor — internal-callable variant

Extract `refinanceLoan`'s body into a private logic function + add an `onlyDiamondInternal` external wrapper without `nonReentrant`:

```solidity
contract RefinanceFacet {
  // Existing external entry — keep nonReentrant for external callers.
  function refinanceLoan(uint256 oldLoanId, uint256 borrowerOfferId)
      external nonReentrant {
      _refinanceLoanLogic(oldLoanId, borrowerOfferId);
  }

  // NEW: cross-facet callable, no reentrancy guard (outer
  // acceptOffer's lock covers the whole tx).
  function refinanceLoanFromAccept(
      uint256 oldLoanId,
      uint256 borrowerOfferId
  ) external onlyDiamondInternal {
      _refinanceLoanLogic(oldLoanId, borrowerOfferId);
  }

  // Body of the existing function, unchanged.
  function _refinanceLoanLogic(
      uint256 oldLoanId,
      uint256 borrowerOfferId
  ) private {
      // existing refinanceLoan body
  }
}
```

The `onlyDiamondInternal` modifier (existing pattern, see [VaultFactoryFacet.sol:41](../../contracts/src/facets/VaultFactoryFacet.sol#L41)) requires `msg.sender == address(this)`. Cross-facet calls via `LibFacet.crossFacetCall` satisfy this; external EOAs cannot reach the new function.

### 3.2 Reentrancy analysis — why removing the guard is safe

The chained `refinanceLoanFromAccept` runs INSIDE `acceptOffer`'s `nonReentrant` lock. Any reentrant attempt from inside the refinance logic to call any other `nonReentrant` external function on the diamond reverts at `LibReentrancyGuard` — the outer lock is already held.

What about external untrusted code called by `_refinanceLoanLogic`?

- `IERC20.safeTransferFrom` — calls into the principal-asset token contract. If the token is malicious and reenters the diamond, the outer lock catches it.
- `vaultDepositERC20From` / `vaultWithdrawERC20` — internal facet calls, no external untrusted code.
- `LibERC721.ownerOf` — internal to the diamond's NFT registry.
- `LibPrepayCleanup.clearActiveListing` — internal.

All external-token callbacks are containable by the outer `acceptOffer` lock. No new reentrancy surface is introduced by removing the inner `nonReentrant`.

### 3.3 Chain hooks — placement in both paths

The chain must fire AFTER `offer.accepted = true` is set, in BOTH code paths:

#### 3.3.1 Direct accept path

In `OfferAcceptFacet._acceptOffer`, after line 1021 (`offer.accepted = true`):

```solidity
offer.accepted = true;
// existing metrics hook
// ...
// T-092-H chain (direct path):
if (offer.refinanceTargetLoanId != 0 &&
    offer.offerType == LibVaipakam.OfferType.Borrower) {
    LibFacet.crossFacetCall(
        abi.encodeWithSelector(
            RefinanceFacet.refinanceLoanFromAccept.selector,
            offer.refinanceTargetLoanId,
            offerId
        ),
        bytes4(0) // bubble inner errors verbatim — P3 fix
    );
}
```

This branch handles:
- Direct `acceptOffer` calls (legacy single-fill).
- Direct `acceptOfferWithPermit` calls.
- `matchOffers` with `partialFillEnabled` OFF (the `deferAcceptFlip` check fails → accept is set inline at 1021).

#### 3.3.2 Matched path (deferred accept)

In `OfferMatchFacet.matchOffers`, in the borrower-side dust-close branch where `bm.accepted = true` is set ([~line 397](../../contracts/src/facets/OfferMatchFacet.sol#L397)):

```solidity
if (borrowerRemaining < bm.amount) {
    // ... existing collateral refund + metrics hook ...
    bm.accepted = true;
    // T-092-H chain (matched path):
    if (bm.refinanceTargetLoanId != 0) {
        LibFacet.crossFacetCall(
            abi.encodeWithSelector(
                RefinanceFacet.refinanceLoanFromAccept.selector,
                bm.refinanceTargetLoanId,
                borrowerOfferId
            ),
            bytes4(0)
        );
    }
}
```

This branch handles:
- `matchOffers` with `partialFillEnabled` ON, dust-close branch.

Both branches use the same selector + same target — only the trigger location differs.

### 3.4 Error bubbling — P3 fix

Pass `bytes4(0)` as the fallback error selector to `crossFacetCall`. `LibRevert.bubbleOnFailureTyped` will re-bubble the inner revert payload verbatim, surfacing `RefinanceCapsRequired` / `SanctionedAddress` / etc. to the caller. The dapp's existing `autoLifecycleErrors.ts` decoder already handles these.

Remove the `AtomicRefinanceFailed` error declaration from `OfferAcceptFacet`. It was misleading and never fired in practice.

## 4. Code path enumeration

Every entry point that can lead to `offer.accepted = true` being flipped needs the chain hook OR a clear exclusion rationale:

| Entry point | Path through | `accepted = true` location | Chain hook? |
|---|---|---|---|
| `acceptOffer(offerId, consent)` | → `_acceptOffer` | Line 1021 (inline) | ✅ Direct chain hook |
| `acceptOfferWithPermit(offerId, ..., permit, sig)` | → `_acceptOffer` | Line 1021 (inline) | ✅ Same direct chain hook |
| `matchOffers(L, B)` with `partialFillEnabled == false` | → `_acceptOffer` (borrower) | Line 1021 (inline because `deferAcceptFlip` false) | ✅ Same direct chain hook |
| `matchOffers(L, B)` with `partialFillEnabled == true`, single-fill consumes the offer | → `_acceptOffer` (borrower) → dust-close branch | OfferMatchFacet ~line 397 | ✅ Matched-path chain hook |
| `matchOffers(L, B)` with `partialFillEnabled == true`, partial fill | → `_acceptOffer` (borrower) | NOT flipped this tick (stays open) | ❌ Excluded — offer is NOT yet accepted; refinance MUST wait for full fill |

The partial-fill exclusion is correct: a refinance-tagged offer should be AON (Phase 2b cap-check enforces `fillMode == Aon` for tagged offers — see [LibAutoRefinanceCheck.validate](../../contracts/src/libraries/LibAutoRefinanceCheck.sol)). So the partial-fill case shouldn't arise in practice. But if a tagged offer somehow ends up partially filled (governance bug, AON enforcement bypass), the chain correctly does NOT fire because the offer hasn't been fully accepted.

## 5. Test surface

### 5.1 Happy path

A new test in `T092AutoLifecycleIntegrationTest` (or a dedicated `T092AtomicAcceptRefinanceTest`):

1. Pre-funds a new lender wallet + their vault + diamond approvals.
2. Pre-sets the borrower's standing approval to the diamond on the principal asset.
3. Builds an Active loan.
4. Borrower sets refinance caps.
5. Borrower creates a refinance-tagged offer (AON, valid caps).
6. New lender accepts → asserts BOTH:
   - Old loan status = Repaid.
   - New loan status = Active.
   - In the SAME transaction.

This requires the fixture expansion tracked under #548.

### 5.2 Matched-path happy path

Same setup, but trigger the accept via `matchOffers(lenderOfferId, borrowerOfferId)` with `partialFillEnabled = true`. Asserts the same outcome via the matched-path chain hook.

### 5.3 Failure cases (each reverts the WHOLE tx)

- Caps tightened between create and refinance (manual `setAutoRefinanceCaps` with stricter caps after offer create) → revert + new loan rolled back.
- Sanctions list (borrower added to sanctions oracle between create and accept) → revert + new loan rolled back.
- Grace expired on old loan (warp past `endTime + gracePeriod`) → revert + new loan rolled back.
- Kill switch flipped off mid-flow (`AdminFacet.setAutoRefinanceEnabled(false)`) → revert + new loan rolled back.

### 5.4 Structural guardrails

- `RefinanceFacet.refinanceLoanFromAccept.selector != bytes4(0)`.
- `onlyDiamondInternal` modifier on `refinanceLoanFromAccept` actually rejects external EOAs (call directly, expect revert).
- Direct `acceptOffer` with non-tagged offer (refinanceTargetLoanId == 0) does NOT trigger the chain.

## 6. Out of scope

- **True vault-first netting** — covered by #407 (Vault encumbrance sub-ledger). Once that lands, the refinance fund source can shift from wallet pull to vault pull without the locked-balance double-spend risk Codex caught on PR #538.
- **Auto-extend chain** — extension doesn't have a "new loan accept" event; `extendLoanInPlace` is its own atomic entry already.
- **PrecloseFacet Options 2/3** — out of T-092 scope (#513 closed wontfix-for-now).

## 7. Sequence diagrams

### 7.1 Direct accept path (current vs T-092-H)

**Current (multi-tx, race window):**
```
External caller → OfferAcceptFacet.acceptOffer(borrowerOfferId, true)
  → _acceptOffer
    → new loan created
    → P sent to borrower's WALLET
    → offer.accepted = true
  ← returns newLoanId

[GAP — borrower's wallet exposed to spends / front-runs / etc.]

Keeper → RefinanceFacet.refinanceLoan(oldLoanId, borrowerOfferId)
  → reads offer.accepted == true ✓
  → reads autoRefinanceCaps[oldLoanId] (still enabled hopefully)
  → safeTransferFrom(borrower, treasury, fee) — uses standing approval
  → vaultDepositERC20From(borrower, oldLender, lenderDue)
  → old loan.status = Repaid
  ← returns
```

**T-092-H (single tx, atomic):**
```
External caller → OfferAcceptFacet.acceptOffer(borrowerOfferId, true)
  → _acceptOffer
    → new loan created
    → P sent to borrower's WALLET
    → offer.accepted = true
    → if (offer.refinanceTargetLoanId != 0 && offer is Borrower):
        → LibFacet.crossFacetCall(refinanceLoanFromAccept, oldLoanId, offerId)
          → RefinanceFacet.refinanceLoanFromAccept
            → _refinanceLoanLogic
              → reads offer.accepted == true ✓
              → reads autoRefinanceCaps[oldLoanId]
              → safeTransferFrom(borrower, treasury, fee)
              → vaultDepositERC20From(borrower, oldLender, lenderDue)
              → old loan.status = Repaid
            ← returns
          ← returns (no AtomicRefinanceFailed wrapper — errors bubble verbatim)
  ← returns newLoanId

[NO GAP — both loans transitioned atomically in the same tx]
```

### 7.2 Matched path (T-092-H)

```
Keeper → OfferMatchFacet.matchOffers(L, B)
  → _acceptOffer(L)
    → lender side update + offer.accepted (deferred for borrower path)
  → _acceptOffer(B)
    → new loan created
    → P sent to borrower's WALLET
    → bm.accepted deferred (partialFillEnabled, borrower side)
  → borrower-side post-match block:
    → bm.amountFilled += matchAmount
    → if (borrowerRemaining < bm.amount):    // dust-close
      → refund residual collateral
      → bm.accepted = true
      → if (bm.refinanceTargetLoanId != 0):
        → LibFacet.crossFacetCall(refinanceLoanFromAccept, ...)
          → [same refinance flow as above]
        ← returns
  ← returns
```

## 8. Operator action

None. Pure contract change. The existing dapp surface (#523) sets `params.refinanceTargetLoanId` already; existing offers carrying the tag become atomic upon next accept.
