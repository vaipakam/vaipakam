## Thread — Get cash from a loan you made: one door, and an advance the loan repays

A lender who wants money back before a loan ends now has one door instead of a
list of route names. One read (`cashOptions`) answers, for a lender position
token and the wallet that would act, whether each of three choices is open:
"Sell now", "Sell at my price" (the existing listing) and "Borrow against it",
with every refusal the routes themselves would raise and the route that already
stands on the position. "Sell now" (`sellNow`) tries up to eight buyers the app
found, in the seller's order, through each route's own rules; a buyer that
refuses is skipped and reported, and the step fails only below the seller's
stated least. Its preview runs the same fills and unwinds them, so the figures
agree to the unit.

"Borrow against it" is a new advance from an Auto-lend slot whose owner has
consented to it. The slot pays the holder part of the loan's outstanding
principal at its own fixed rate; everything the loan then pays its lender side
goes first to the advance's interest, then the advance, then the holder. The
holder may repay it from their vault at any time. Interest stops on each amount
when the money arrives, and the advance's part is set aside in the same step,
so nobody needs to act afterwards. Booking never makes a borrower's step fail.
While an advance is open the position is locked: no transfer, sale, listing,
takeover, extension, roll or re-commit. Advances are top-tier pairs only and
ship behind their own switch, which is off.

The two places a lender side's money rests (held while the loan is open, and the
final claim) are now written by one library only, `LibLenderSide`, whose booking
host is the new `LenderSideFacet`; a new pre-deploy check (step 1d5) reads the
compiler's AST and refuses a write to either anywhere else. The old
`LibHeldForLender` is gone. To keep room under the contract size limit, the
listing and the full repayment now reach consolidation through
`ConsolidationFacet`, and the held-extra payout to the borrower runs on
`EncumbranceMutateFacet`, instead of each facet carrying its own copy.

Three new facets: `LenderCashOutFacet`, `LenderAdvanceFacet` and
`LenderSideFacet`. They reach a chain by fresh deploy. Design:
`docs/DesignsAndPlans/LenderCashOutDesign.md`. Advances #3760.

> Caveat: a part sale (#3674), the sale to an Auto-lend slot at a price (#3667 Part B) and renewal with another lender (#3763) are not built; "Sell now" sells whole, skips a buying-slot source by name, and only the extension lock applies.
