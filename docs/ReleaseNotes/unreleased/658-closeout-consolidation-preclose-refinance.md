## Thread — Eager close-out consolidation for direct preclose + refinance (PR #<n>)

Continues the #594 "eager consolidation" arc (#658 umbrella). On every
close-out, a transferred loan position is now consolidated to its current
NFT holder *before* the loan goes terminal, so the collateral lien, the
reward-accrual entry, and the VPFI fee/stake checkpoint follow the live
holder rather than staying stranded on the address that originally opened
the position.

This PR extends that hook to two more hosts:

- **`PrecloseFacet.precloseDirect`** — a both-side close-out. Both the
  borrower and lender sides are consolidated to their current holders
  while the loan is still Active (the consolidation primitive is a no-op
  once a loan is terminal, so it must run before the Active→Repaid flip).
  Direct preclose moves no collateral out of a vault — the borrower's
  collateral stays in place as a `borrowerClaims` row, withdrawn later by
  `claimAsBorrower` — so no post-withdrawal VPFI re-stamp is needed here.

- **`RefinanceFacet.refinanceLoan`** — the **lender side only** of the
  exiting old loan. At refinance the old lender exits (it is paid out via
  `lenderClaims` and the old loan closes), so its accrued reward entry and
  VPFI checkpoint are repointed to the current lender-NFT holder before the
  close. The borrower side is deliberately **left untouched**: the
  borrower's collateral carries over into the new loan (#576), and a
  borrower-side consolidation here would fight the carry-over re-tag.

Both hooks use the few-byte cross-facet consolidation entry (both facets
are size-tight) with Tier-2 "skip-not-block" semantics — a
sanctioned/excluded holder never bricks a close-out.

**Funds were never at risk** on these paths: every payout already routes
to the current holder through the `lenderClaims` / `encumberLenderProceeds`
→ `ClaimFacet` reservation and `claimAsBorrower`, all `ownerOf`- and
sanctions-gated. This change closes the remaining **position-effect
accounting** gap (reward/VPFI/lien following the holder), not a
fund-misrouting gap.

**Scope notes / deferrals (Part of #658, not Closes):**

- `EarlyWithdrawalFacet` (`sellLoanViaBuyOffer` / `completeLoanSale`) is
  **already integrated** with the #594 consolidation primitive (via
  `s.consolidationMoveFromUser`) — it is a loan-*sale* path (the lender
  position migrates to a new lender and the loan continues), not a missing
  close-out host, so no change was needed.
- `PrecloseFacet.transferObligationViaOffer` / `offsetWithNewOffer` are
  obligation-transfer paths (the position migrates / the loan continues)
  and are tracked for a focused follow-up rather than treated as plain
  both-side close-outs.
- The **multi-loan internal match** (`RiskMatchLiquidationFacet`) eager
  consolidation is **deferred** to a dedicated follow-up. The 3-way
  executor sits at the exact viaIR per-function stack ceiling: it compiles
  with zero slack today, and *any* contract-level addition (even an
  un-hooked one) tips the inlined function over. Closing it cleanly needs a
  per-function stack reduction (a lean struct-return DTO + settle-helper
  refactor of the executor), which is too invasive to bundle here for a
  position-effect-only improvement on the rarest liquidation path. The
  internal-match proceeds are already current-holder-safe via #585
  `lenderClaims` + `claimAsBorrower`.
