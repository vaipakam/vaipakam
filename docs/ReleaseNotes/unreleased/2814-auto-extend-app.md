## Thread — Automatic extension and extension reserves in the app (PR #3102)

The contracts for the extension reserve (#3071) gave the borrower an explicit way to fund automatic extensions, but the app had no automatic-extension surface at all: neither side could set their consent, and nobody could see whether an extension would be funded. The loan page now has an automatic-extension card for both parties to an active loan.

The card states the protocol's switch and pause, the loan's extension window, and both sides' limits as the protocol holds them, including that limits an earlier holder of a position set no longer count. From the two sets of limits it states the terms an extension may use, or that they leave no rate both accept, or that both sides must have limits in force first, and it says that whoever sends the extension picks the exact terms within them. Each party can set or clear their own side; turning consent off stays open even while the feature is switched off and before the current Terms are accepted.

The borrower-position holder also sees the extension reserve: what is reserved, their other free balance of the loan's asset, what an extension would charge now and at the end of the window, and whether that is covered, with the shortfall named. They can add to the reserve (the loan is re-checked before any approval, and an approval left behind by a failed deposit is put back) and withdraw what is unused (read again just before signing, never held behind the Terms gate, with a protected account's payout route stated). The card also says whether a keeper they allow can send the extension, and what to change if not.

The reserve belongs to the depositor, so a wallet holding one on a loan that has ended, or on a borrower position it has since passed on, sees it on the loan page with its withdrawal. The Claims page lists every reserve a wallet holds, found from the indexer, which now files the reserve's funding, withdrawal and draw rows under the depositor.

Advances #2814 (the app half; the contract half closed it).

> Caveat: there is no end-to-end test of this surface yet; it needs a Diamond carrying the #3071 facets, which no testnet has until the all-waves fresh deploy.
> Caveat: a protected account's controller cannot yet withdraw the reserve of an account it took over from this card; the contract allows it, and the card offers only the connected wallet's own reserve.
