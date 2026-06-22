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

- **`RefinanceFacet.refinanceLoan`** — the **lender side always** (the old
  lender exits in every refinance: it is paid out via `lenderClaims` and the
  old loan closes, so its reward entry + VPFI checkpoint repoint to the
  current lender-NFT holder). The **borrower side is consolidated only on
  the non-carry-over path** (transferred / untagged / ranged offer), where
  the old collateral is returned and the old loan closes for the borrower
  too — so its lien / reward / VPFI follow the current holder and the
  borrower-LIF rebate prices from that holder. On the carry-over path the
  borrower stays and its collateral re-tags into the new loan (#576), so a
  borrower-side consolidation there is skipped (it would be a no-op at best
  and fight the re-tag at worst). On the non-carry-over path the old
  collateral is then returned to the holder, so when it is VPFI the path runs
  a post-withdraw VPFI re-stamp (the same one the liquidation hosts use) so
  the holder doesn't keep fee-tier / staking credit on VPFI that has left the
  vault.

Both hooks use the few-byte cross-facet consolidation entry (both facets
are size-tight) with Tier-2 "skip-not-block" semantics — a
sanctioned/excluded holder never bricks a close-out.

Direct preclose leaves the position's payouts to be claimed later via
`ClaimFacet`; both claim paths now run a post-withdraw VPFI re-stamp after VPFI
leaves the vault, so a holder can't keep fee-tier / staking credit on VPFI that
has been claimed out. On the borrower side (`claimAsBorrower`) this covers VPFI
in any of its three forms — collateral, a VPFI principal-surplus claim row, or a
still-liened VPFI top-up paid via the extra-lien path. On the lender side
(`claimAsLender`) it covers VPFI proceeds and a `heldForLender` top-up. Both use
a general user-keyed restamp, gated on the actually-withdrawn asset so the common
non-VPFI claim never reaches the consolidation facet. **NFT-rental loans are out of scope** for this consolidation —
the underlying primitive only handles ERC20 loans, so a transferred rental
position keeps its position effects on the stored anchor (consistent across
the whole #594/#658 arc).

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
