## Thread — Auto-extend reserve (PR #TBD)

An in-place extension settles the closing window's interest, and any late fee, from the borrower-position holder's vault. Until now, no route let a borrower put free principal asset there, so every extension of a loan with interest owed reverted. The borrower now funds an explicit extension reserve: they deposit the loan's principal asset from their wallet into their own vault, recorded and earmarked for that loan's extensions (owner decision, "add an explicit top-up").

The reserve is not free balance. No other withdrawal reaches it, and repayment, default, liquidation and collateral release never take it. An extension draws the current holder's reserve first, then any other free balance they hold in the asset. A new event states how much came from each and what is left reserved. A shortfall refuses the extension and takes nothing. Nothing is pulled from the wallet at extension time, so no standing approval is needed.

Only the current borrower-position holder can fund, and only while the loan could actually be extended (the feature on, the loan active, an ERC-20 loan with no periodic cadence). The depositor can withdraw unused reserve to their wallet at any time, after the loan has closed included. The reserve stays with the depositor if the position moves; a new holder funds their own.

A funding view gives, for a loan and a wallet, the reserve, the other free balance, what an extension would charge now, and the most it can charge (at the end of the extension window). It uses the same charge rule as the extension, so the app can show the holder how much to deposit. The extension test fixture now funds through this route instead of writing the vault counter directly.

Design: [`docs/DesignsAndPlans/AutoExtendReserveDesign.md`](../../DesignsAndPlans/AutoExtendReserveDesign.md). Closes #2814.

> Caveat: The app's funding screen and the keeper's use of the funding view are follow-ups for the app and keeper threads; the contracts alone do not show the holder the reserve.
