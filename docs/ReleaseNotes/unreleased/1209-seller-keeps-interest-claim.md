## Thread — a lender who sells keeps the interest they earned (PR #<n>)

A lender who sold their position used to forfeit all the interest they had
earned and not yet been paid, and that interest went to the treasury. Now the
seller keeps it, as a claim on the loan. The buyer still pays only the
outstanding principal, so no buyer funds more than their offer says. The
seller's only cost at the sale is the rate shortfall, when the buyer takes a
higher rate than the loan pays, and that goes to the buyer as before. The
treasury takes nothing at the sale.

The seller is paid when the borrower pays. Every later interest payment to the
lender side, of any kind, pays the open seller claims first, oldest first, and
then the current holder. The yield fee is taken once, when interest is paid,
whoever receives it. A seller's share lands in their own vault, set aside for
them, and they withdraw it when they choose; a share for a sanctions-flagged
seller waits there until they are clear. When a loan ends in a short recovery,
the holder's principal is paid first, then the seller claims oldest first. A
recovery the platform cannot value pays the holder only. Whatever a claim is
not paid is stated in its closing event.

Underneath, each loan now keeps an exact interest ledger: every stretch of time
is priced at the principal and rate in force over it, and interest counts as
paid only when it reaches the payee. This replaces the old "paid through" mark
and its long list of special cases (#1808). The principal and rate are written
through one library that checkpoints the ledger first, and a guard test fails
if anything else writes them. A loan carries at most four open seller claims;
a sale that would open a fifth is refused, and the sale verdict names that
reason.

The new host is `SellerClaimFacet`. It refreshes together with the payout,
sale and claim facets. Because the ledger opens lazily at the loan's start, an
in-place refresh across this change is refused while any ERC-20 loan is open,
and the curated refresh scripts refuse a Diamond that predates the ledger.
Testnets get it with the all-waves fresh deploy.

The connected app's sale screens still show the old forfeiture figure and need
to show the claim instead; that is handed to the app thread. The sale path's
interaction-reward forfeiture is unchanged.

Closes #1209. Closes #1808.

> Caveat: a recovery that cannot be valued (no trusted price, an illiquid asset, an NFT) pays the holder in full and closes the seller claims unpaid.
> Caveat: no in-place upgrade path; a chain with open ERC-20 loans reaches this only by fresh deploy.
