# Lender sale — the seller keeps a claim on the interest they earned

**Status:** built, one pull request (owner-decided 2026-10-28, decision card in
the issues-plan thread). The "As built" notes below record where the build
differs from the first draft of this design, and why. Cards: #1209 (stop forfeiting the seller's accrued interest) and
#1808 (replace the scalar paid-through mark with a per-segment ledger).
**Supersedes** the upfront-price model in
[`LenderSaleAccruedInterestPricingDesign.md`](LenderSaleAccruedInterestPricingDesign.md)
and the paid-through mark rules of #1801.

## The decision

When a lender sells an ERC-20 loan position, the buyer pays the outstanding
principal, as today. The interest the seller earned while they held the
position, and that has not yet reached them, becomes **a claim on the loan**.
The borrower's later interest pays open seller claims first, then the current
holder. On a recovery that falls short, the buyer's principal is paid first,
then interest, oldest first.

Why this option (owner's pick, recommended):

- **No buyer funds more than their offer said.** A direct sale fills an
  ordinary lender offer whose amount must equal the principal (#1923). An
  upfront price would need a new buyer-side price cap on every lender offer.
- **The seller carries the same borrower risk they carried while holding.**
  They are paid when the borrower pays, from what the borrower pays.
- **One seam.** The per-segment ledger #1808 needs a checkpoint at every
  principal, rate and delivery event. Seller claims are paid at exactly those
  events, so both live in one shared step.

The treasury no longer takes a forfeiture at sale. The yield fee on each
interest slice is collected once, when the slice is paid, as for any loan.

## Scope

- ERC-20 loans only. A rental position cannot be sold (`SaleExitVerdictFacet`
  refuses it on both routes, and §9 says so), so rentals carry no ledger.
- Both lender exit routes: the listed sale (`EarlyWithdrawalFacet`) and the
  direct sale into a buy offer (`EarlyWithdrawalDirectFacet`).
- A plain transfer of the lender position NFT is not a sale. The earned
  interest travels with the NFT, as it does today.
- Out of scope: the sale-path interaction-reward forfeiture (rewards are owned
  by another thread), and what moves in `heldForLender` at a sale (unchanged:
  the seller still reviews the held ceiling and the held balance moves to the
  buyer; see "Held balances" for why this stays consistent).

## The ledger (#1808)

Per loan, one record for the current holder and a short list of seller claims:

```
InterestLedger {
    uint64  touchedAt;          // last checkpoint
    uint256 holderEarnedGross;  // earned by the current holder, not yet paid to them
    uint256 principalOwed;      // principal the lender side is still owed
}
SellerClaim { address seller; uint256 grossOwed; }   // oldest first, at most MAX_SELLER_CLAIMS
```

**Checkpoint** (`touch`): `holderEarnedGross += principal × rate × (now −
touchedAt) / (SECONDS_PER_YEAR × BPS)`, then `touchedAt = now`. Seconds-precise,
rounded down, on the principal and rate in force over that segment. It runs
before every change of principal or rate and at every sale and every interest
delivery. Origination sets `touchedAt` to the start time.

**Delivery** (`deliver(grossInterest)`): interest the borrower has paid towards
the lender side. It pays open seller claims first, oldest first, each up to
its `grossOwed`, then reduces `holderEarnedGross` (saturating at zero). Any
excess (the full-term floor, rounding) belongs to the holder. Each payee's
share is paid **net of the loan's snapshot yield fee**, so the fee is taken
once per slice whoever receives it.

**Sale** (`recordSale(seller)`): checkpoint, then move `holderEarnedGross` into
a new seller claim (merged into the last claim when the same address is the
seller again) and zero it. The buyer starts at zero.

**Bound.** At most `MAX_SELLER_CLAIMS = 4` open claims per loan. A sale that
would add a fifth is refused (`SellerClaimsFull`) until older claims are paid.
This bounds the gas of every interest payout against a seller who resells to
themselves to grow the list.

**One writer per field.** `loan.principal` and `loan.interestRateBps` are
written through one library (`LibInterestLedger.setPrincipal`,
`writeOffPrincipal`, `setRate`), which checkpoints first. A pre-deploy guard
(`contracts/script/check-loan-terms-writer.mjs`, reading the compiler's AST)
fails if any other file in `contracts/src/` assigns either field, except the origination
lines in `LoanFacet` (the ledger opens at the loan's start, so nothing earlier
exists to checkpoint). This is the guardrail #1808 asked for, built on a single
writer instead of a list of call sites to remember.

**As built: the ledger opens lazily.** A loan whose ledger was never touched
reads `touchedAt` as the loan's start time and `principalOwed` as the loan's
principal. That is exact for every loan opened under this code. A loan opened
under the older code and still open when the code arrives would be read as if
nothing had been paid since it started, so an in-place refresh across this
change is refused while any ERC-20 loan is open (see "Reaching a chain").

## What counts as delivered

Delivered means the interest reached the payee, or the payee's own frozen
custody. A share parked in `heldForLender` because the holder is
sanctions-frozen is **not** delivered to the holder in the ledger's sense:
`holderEarnedGross` keeps it. This is what makes the held rule below
consistent.

Delivery sites (each calls `deliver` with the gross interest it paid):

| Path | Today |
| --- | --- |
| Partial repay (`RepayFacet.repayPartial`) | interest + principal via `freezeOrPayActiveLenderFromPayer` |
| Periodic settlement (`ForcedSaleFacet._bookPeriodic`, and the clean branch of `RepayPeriodicFacet.settlePeriodicInterest`) | resident payout; `interestSettled` |
| Partial swap-to-repay (`SwapToRepayPartialFacet`) | direct push of interest + principal |
| Partial liquidation (`RiskFacet.triggerPartialLiquidation`) | resident payout |
| Auto-extend in place (`AutoLifecycleFacet._routeInterest`) | interest to the lender vault, then a rate change |
| Obligation handover (`PrecloseFacet.transferObligationViaOffer`) | lender accrued share parked, then a rate change |
| Terminal settlements | through the lender claim row (below) |

## Paying seller claims

**While the loan is open**, each delivery site splits its interest payout:
seller claims' shares are paid to each seller, the rest to the holder.
Principal in the same payment always goes to the holder.

**As built:** every site reaches one step, `LibInterestLedger.paySellersFirst`,
which self-calls `SellerClaimFacet.paySellersFirst` only when a claim is open
(a loan that was never sold pays nothing extra). A seller's share goes into the
seller's own vault, reserved for them (`sellerInterestHeld`), and they withdraw
it with `claimAsSeller`. It never goes to the seller's wallet, because the
payout is part of someone else's transaction (the borrower's repayment, a
keeper's settlement), and a past lender's wallet must never be able to refuse
it. A share for a flagged seller simply waits in their vault: the withdrawal is
screened fail-closed. Each seller bears the fee the slice actually paid, in the
slice's own net-to-gross proportion.

**At a terminal**, the lender claim row is written as today. The split happens
once, when the claim is first resolved by either party, in a new host
(`SellerClaimFacet`): it reads the final lender claim (asset, amount), the
principal outstanding at the terminal, and the open seller claims:

- Lender claim in the principal asset: the holder takes the first `principal`,
  then seller claims are paid oldest first up to their net amounts, then the
  holder takes the rest.
- Lender claim in kind (collateral): when the collateral has a liquid value,
  the same ranking is applied to its value through the shared numeraire rule.
- **As built:** a recovery that cannot be valued (no price, an illiquid asset,
  an NFT) cannot show that the holder's principal was covered, so the holder
  keeps all of it and the seller claims close unpaid. The first draft split it
  in proportion instead; that would have paid sellers ahead of a principal the
  platform could not show was whole, against the "principal first" decision.
- A seller claim the recovery cannot cover is closed at what it was paid, and
  the claim records the unpaid part. Nothing is hidden.

`ClaimFacet.claimAsLender` self-calls the split before paying the holder, and
sellers withdraw through `SellerClaimFacet.claimAsSeller(loanId)`, which runs
the split first if nobody has yet. A fallback that is still pending is not
final (its claim-time retry can still rewrite the row), so the split waits for
it. The backstop's cash buyout of a fallback lender slice splits its cash the
same way (`settleSellerClaimsFrom`).

## Held balances

`heldForLender` keeps its current meaning and still moves to the buyer at a
sale. Because a frozen share was never delivered in the ledger, the seller's
claim includes it. The buyer receives the held tokens and later pays the
same amount back to the seller out of the interest the seller claim takes
first. The buyer ends level, and the seller is paid what they earned.

## The sale, after the change

Both routes keep their structure. The seller's cost is only the rate shortfall
(the buyer's higher rate over the remaining term, deposited to the buyer's
held), never accrued interest:

```
sellerCost  = shortfall
treasuryCut = 0
sellerNet   = principal − shortfall
```

The paid-through mark (`lenderInterestDeliveredThroughAt`, `lenderMarkPrincipalAt`,
`lenderMarkVoided`, `lenderMarkHeldAt`, `lenderTenureStart`), its library
functions and `RiskPreviewFacet.sellerForfeitureWindow` retire. The five
storage slots stay in place, unwritten, because storage is append-only. The seller-bounds
quote keeps its floor and held ceiling, without an accrued term. A new view
reports a loan's ledger: the holder's earned interest now and each open seller
claim, owed, paid and unpaid.

## Delivery

The first draft planned two pull requests. They shipped as one, because the
first on its own would have left a forfeiture computed from the ledger for a
single release only to delete it in the next.

## Reaching a chain

`SellerClaimFacet` is a new host, and every payout facet, both sale facets and
`ClaimFacet` reach it, so they refresh together. Because the ledger opens
lazily, an in-place refresh across this change is refused while any ERC-20
loan is open or fallback-pending, and only under the operator's manual pause
(`RefreshAllFacetsInPlace`, `RefreshChangedFacetsInPlace`); the curated
`RedeployFacets` and `ReplaceStaleFacets` refuse a Diamond that does not
already route the ledger view. The planned route is the all-waves fresh
deploy.

## Tests

- Ledger: each segment priced at its own principal and rate; a frozen period
  never subtracts; over-delivery saturates; a principal-only payment subtracts
  nothing.
- Guard: no assignment to `principal` or `interestRateBps` outside the writer
  and the allow-list.
- Sale: the seller's net is `principal − shortfall`; the treasury receives
  nothing at sale; the seller claim equals the earned interest to the wei.
- Payouts: seller claims are paid before the holder, oldest first, net of the
  fee; the fee is paid once per slice across a resale chain.
- Terminal: full repay, default with a short recovery (principal first), in-kind
  with and without a price; a fifth sale is refused.
