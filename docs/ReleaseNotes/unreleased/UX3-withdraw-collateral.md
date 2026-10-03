## Thread — Borrowers can take back collateral their loan no longer needs (PR #2389)

The protocol has always let a borrower withdraw collateral from an open loan, as long as the loan stays healthy. The app never offered it. A borrower whose collateral had grown in value had no way to use the surplus short of closing the loan. The 2026-10-03 live review recorded this as UX3-009.

A loan page now has a "Take back extra collateral" section for the borrower, in Basic mode as well as Advanced. It states how much can be taken back right now, using the protocol's own live limit, and refreshes that figure while the page is open. It also says plainly that taking collateral back makes the loan riskier, and that a figure right at the limit can be refused if prices move before the transaction lands. A Max button fills in the whole limit.

When nothing can be taken back, the page explains why, as far as the app can tell: the loan needs all of its collateral, or the collateral cannot be priced at the moment. When the app cannot tell which, it says so. If the limit could not be read at all, the page says that instead of showing zero.

Before the wallet opens, the app checks again for each thing that would make the protocol refuse, and says the reason in plain words:
- the wallet is no longer the borrower-position holder;
- a sale listing of the lender's position is linked to the loan;
- a swap-to-repay order is pending against the loan (the page says this app cannot cancel it);
- the limit has moved below the amount.

When the collateral is VPFI, the page notes that the fee-discount tier may drop; when it can't tell whether the collateral is VPFI, it says so and gives the same caution. A swap-to-repay order that passed its deadline without filling still blocks the withdrawal until it is cancelled, and the page says so. If any of the checks can't be answered — the sale-listing check or the swap-order check — nothing is sent and the page says it couldn't check. The limit is shown rounded down, so typing the figure the page states is always within it. The card disappears once the live loan status shows the loan is no longer open, even before the lists catch up. Like repaying, taking back extra collateral works for a wallet that hasn't accepted the current Terms, because it only returns the borrower's own assets. All the new text is translated into the ten supported languages.

German register fix: the German text for this card, and three German claim strings added with the claim-payout change (#2373), used the informal "du". The rest of the German app uses the formal "Sie", so these strings now use "Sie" too.
