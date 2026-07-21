## Thread — Honor the lender Full/hold stamp on the preclose-family settlement paths (M2 PR-6 follow-up, part B3 — preclose family) (PR #<n>)

Continues #1383. Parts B and B2 delivered the swap family and the repay family;
this part extends the same lender Full/hold yield-fee discount to the
**preclose family** — the early-close and obligation-transfer settlements, which
until now took their treasury cut with no discount at all.

Three settlement legs that previously ignored the discount now honor it:

- **Early close of an NFT rental.** A rental lender lost the discount purely
  because the collateral was an NFT — the rental leg never asked for it. It now
  does, sized on the same remaining-rental-plus-late-fee base the treasury cut is
  taken from.
- **Obligation transfer, interest leg.** When a borrower hands their obligation
  to a new borrower, the exiting lender is paid the interest accrued up to the
  handover. That settlement now applies the lender's discount. The extra top-up
  the incoming borrower owes for a shorter replacement term is money the treasury
  never touches, so it stays outside the discounted base.
- **Obligation transfer, rental catch-up leg.** Same for the rent that accrued
  since the last daily deduction, which is forwarded to the lender at the moment
  of transfer.

Every leg resolves the discount for **whoever currently holds the lender
position**, which is the party a claim actually pays out to. This matters most
when a lender position has been sold: the settlement bookkeeping can still name
the seller in places, and pricing the discount off that stale name would have
sized it against the seller's holdings and — once the token peg is configured —
spent the seller's own tokens to fund a discount they would never receive. The
discount follows the party who is paid, never the party the paperwork happens to
still mention.

To make room for all of this on a facet that was within a few hundred bytes of
the contract size limit, the early-close ERC-20 path was switched from carrying
its own copy of the discount delivery to calling the shared settlement helper the
other paths use. That reclaimed roughly two kilobytes, leaving comfortable
headroom rather than the sliver there was before, and it means the discount
logic now lives in exactly one place across every settlement path in the system.

Ships **dark**: no loan carries a Full lender stamp until the fee-entitlement
cut-over, so every current preclose and obligation transfer settles exactly as it
did before — now also including the consent-gated hold discount these paths
formerly ignored.

Two settlement paths are deliberately **not** covered here and remain
prerequisites before the fee-entitlement cut-over: the offset close-out (its
treasury cut is computed in one transaction but settled in a later one, so the
figure the discount is sized against has to be carried across that boundary) and
the automated-lifecycle case where the lender position has been transferred.
Each is subtle enough to warrant its own focused change.

Part of #1383. Umbrella: #1349.
