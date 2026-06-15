# #591 — Internal-match top-up-aware unwind (#585 Part B)

**Issue:** #591 (split from #585). **Status:** DESIGN.
**Anchors:** `RiskMatchLiquidationFacet` (`_settleLeg`, `_executeTwoWay/ThreeWayMatch`,
`_settleFallbackOrTransitionPostMatch`, `_gateMatchableLeg`,
`attemptInternalMatchAutoDispatch`), `MetricsFacet.hasInternalMatchCandidate`,
`ClaimFacet._resolveFallbackIfActive`, `LibVaipakam.hasActiveFallbackTopUp`.

## 1. The invariant today

A `FallbackPending` loan's collateral is split once it receives an AddCollateral
top-up:

```
loan.collateralAmount  ==  snapshotTotal            +  lien.amount
                           └ Diamond custody ┘         └ borrower vault, liened ┘
   (s.fallbackSnapshot[id].{lender+treasury+borrower}Collateral)   (s.loanCollateralLien[id], released==false)
```

`snapshotTotal` (the original collateral) moved to Diamond custody at fallback;
the top-up sits in **`loan.borrower`'s vault** under a non-released lien.
Internal-match `_settleLeg` draws a `FallbackPending` leg's matched collateral
**from Diamond custody**. If it drew against `loan.collateralAmount` (which
includes the vault top-up), it would over-draw Diamond custody — taking
collateral belonging to *other* fallback loans. That's why such loans are
**excluded** today (5 sites, all keyed on `hasActiveFallbackTopUp`).

## 2. Target behaviour (from #591)

Replace exclusion with **top-up-aware accounting**, per the issue:

- A topped-up `FallbackPending` leg's **matchable collateral = the Diamond
  portion only** (`snapshotTotal == loan.collateralAmount − lien.amount`). The
  vault top-up does **not** participate in the match.
- The match draws only from Diamond custody (bounded by `snapshotTotal`), so no
  over-draw.
- The vault top-up is **returned to the current borrower-position holder** —
  it's already in `loan.borrower`'s vault; we keep the lien and fold it into the
  borrower residual claim so `claimAsBorrower` pays the current holder exactly.

Rationale: the top-up was the borrower's cure attempt; on an internal match
(a liquidation substitute) it belongs back to the borrower side, while only the
originally-liquidatable (Diamond) collateral is matched.

## 3. Design

### 3.1 Matchable-collateral helper
Introduce `_diamondMatchable(loan)` returning the collateral eligible for the
match draw:
```
if (loan.status == FallbackPending && hasActiveFallbackTopUp(loan.id))
    return loan.collateralAmount - s.loanCollateralLien[loan.id].amount;  // Diamond portion
return loan.collateralAmount;                                             // unchanged for all other legs
```
Use it wherever the match currently reads `loan.collateralAmount` to size a
leg's contribution: `movedX = min(other.principal, _diamondMatchable(thisLeg))`
in `_executeTwoWayMatch` / `_executeThreeWayMatch`. Non-topped-up legs are
unaffected (helper returns the full amount).

### 3.2 `_settleLeg` draw — unchanged
Because `movedX ≤ snapshotTotal` for topped-up legs, the existing
`fromDiamondCustody` transfer (`IERC20.safeTransfer` from Diamond) stays correct
and bounded. No change needed in `_settleLeg` itself.

### 3.3 `_settleFallbackOrTransitionPostMatch` — split-aware residual
Remove the defence-in-depth revert. Compute the split once at entry:
```
topUp        = hasActiveFallbackTopUp(loan.id) ? s.loanCollateralLien[loan.id].amount : 0;
diamondAfter = loan.collateralAmount - topUp;   // Diamond residual remaining after the match decrement
```
(The match already decremented `loan.collateralAmount` by `collateralConsumed`,
all of which came from the Diamond portion, so `diamondAfter == snapshotTotal −
collateralConsumed`.)

- **Branch 2 (FallbackPending full rescue, `principal == 0`):**
  - Transfer **only `diamondAfter`** (not `loan.collateralAmount`) from Diamond
    → `loan.borrower` vault. The top-up is already in that vault.
  - Borrower residual claim = `loan.collateralAmount` (= `diamondAfter + topUp`,
    the full remaining). Lien after: the existing top-up lien **incremented by
    `diamondAfter`** so the lien covers the whole residual (matches the
    non-topped-up path which liens the transferred residual).
  - `borrowerClaims[loan.id]` = `loan.collateralAmount`.
  - Clear `fallbackSnapshot.active`, forfeit borrower LIF, → `InternalMatched`
    (unchanged).
- **Branch 3 (FallbackPending partial rescue, `principal > 0`):**
  - The match consumed `collateralConsumed` from the **Diamond** portion only.
    Scale the snapshot's collateral/principal fields by the consumed fraction of
    the **Diamond portion** (`collateralConsumed / snapshotTotal_before`), NOT of
    `loan.collateralAmount`. The top-up lien is **untouched** (stays liened in
    the vault, owed to the borrower) and is excluded from the scaling base.
  - Loan stays `FallbackPending`; `hasActiveFallbackTopUp` remains true; the
    residual Diamond portion + the still-liened top-up remain for a later match
    or in-kind payout.
- **Branch 1 (Active):** unaffected — Active loans have no fallback snapshot and
  their lien was never released; `_diamondMatchable` returns the full amount.

### 3.4 Remove the 5 exclusion sites
Once 3.1–3.3 land + tests pass:
1. `_gateMatchableLeg` revert (~542) — delete.
2. `_settleFallbackOrTransitionPostMatch` defence-in-depth (~745) — delete.
3. `attemptInternalMatchAutoDispatch` skip (~914) — delete.
4. `MetricsFacet.hasInternalMatchCandidate` filter (~463) — delete.
5. `ClaimFacet._resolveFallbackIfActive` retry-swap skip predicate (~809) —
   here the swap must still only touch the Diamond portion. Change
   `_attemptRetrySwap` to swap `diamondMatchable` (Diamond portion) instead of
   `loan.collateralAmount`, then drop the `!hasActiveFallbackTopUp` guard. (If
   that's larger than this PR warrants, keep this one guard and note it; the
   internal-match unwind — the issue's core — does not depend on the retry-swap.)

Keep the `InternalMatchFallbackTopUpUnsupported` error declaration only if any
site still references it; otherwise remove it (and re-export ABIs — errors are
in the ABI).

## 4. Invariants to preserve (custody-sensitive)
- Diamond custody is never drawn beyond `snapshotTotal` for any leg.
- `sum(borrower vault top-up + Diamond residual)` returned to the borrower side
  equals `loan.collateralAmount` remaining after the match — no collateral
  created or destroyed.
- The top-up always routes to the **current** borrower-position NFT holder (via
  `borrowerClaims` + `claimAsBorrower`), never to a stale `loan.borrower` if the
  position was transferred.
- Lender proceeds routing (#585 Part A) is unchanged.

## 5. Tests (`test/InternalMatchTopUpUnwind.t.sol`, + extend existing)
Per the issue matrix, with a fallback-pending + topped-up loan seeded
(`triggerLiquidation`/`triggerDefault` with swap failure → `addCollateral`):
1. Topped-up **full** match → `InternalMatched`; Diamond portion matched; top-up
   + Diamond residual claimable by the **current** borrower holder; lender
   proceeds route per #585.
2. Topped-up **partial** match → stays `FallbackPending`; snapshot scaled on the
   Diamond base; top-up lien intact.
3. Topped-up **zero-residual** (Diamond portion exactly consumed) → settles;
   top-up alone returned to borrower holder.
4. Transferred borrower position → top-up pays the new holder, not stale borrower.
5. Custody invariant: Diamond same-token balance never goes negative across a
   topped-up match alongside another fallback loan in the same asset.
6. Regression: the former exclusion tests in `InternalMatchLiquidationGates`
   that asserted `InternalMatchFallbackTopUpUnsupported` now assert a successful
   match instead.

## 6. Docs
Update the FunctionalSpec internal-match section + the
`InternalLiquidationLedger.md` staging-constraint note (topped-up loans now
match). Release-note fragment `docs/ReleaseNotes/unreleased/591-*.md`.
