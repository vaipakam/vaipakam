# Release Notes — 2026-10-29

A lender who sells their position keeps the interest they earned, and the app now shows those seller claims and lets the seller collect them; the sale screens no longer say the interest is forfeited. Borrowers can fund an earmarked reserve that automatic extensions draw from, so an extension no longer fails just because the vault held no free principal asset. The keeper's extension pass now skips an extension the reserve and free balance cannot cover and says why. The contract change reaches the testnets only with the all-waves fresh deploy.

## Thread — sellers see and collect their interest claims (PR #3072)

The app now follows the rule that a lender who sells keeps the interest they
earned. The sell-now and listing screens no longer say the earned interest is
forfeited: the only cost at the sale is the rate top-up when the buyer's rate
is above the loan's own, and the review states, apart from the payout, about
how much interest the seller has earned so far and that it stays theirs as a
claim on the loan. It also says what that claim risks: it is paid as the
borrower pays interest, and if the loan ends short the buyer's principal is
paid first. No fee is taken at the sale; the usual cut of interest comes out
of the claim when it is paid.

The Claims page has a new card, "Interest from positions you sold". A seller
holds no position token any more, so the app finds these loans from the
activity index (every step of a seller claim is now filed under the seller,
and the index's activity route takes a list of event kinds, so claims and
payments are read as one stream)
and reads each one from the chain: what is still owed to this seller, and what
has already reached their vault, per asset. Each loan says where it stands
(being paid as the borrower pays, waiting on a fallback, or settled at
withdrawal from what the loan recovered). The withdraw button appears only
when the protocol's own check says the withdrawal would pay something now,
and that check runs again just before signing. Withdrawing is a way out,
so it is not held behind the Terms of Service acceptance. When the index is down, a loan
cannot be read, or a wallet has more sales than the card reads, the card says
so rather than showing nothing.

The contracts behind this (PR #3068) reach the testnets only with the all-waves
fresh deploy. Until then the sale quote stays unavailable on the old Diamonds
and the card lists nothing, because no seller claim exists there. Advances
#1209.

> Caveat: Claim all does not include seller claims yet; each is withdrawn from its own row.
> Caveat: no end-to-end spec drives a seller claim until a Diamond with the new facets exists to run it against.

_Committed 2026-10-29 00:49 UTC (2eee63c87)._
<!-- assembled-fragment: 1209-seller-claims-app.md sha256=2020f8806f3f8e5f5f2a96ef279af6fe76e140aba9ccca2b9403dddb3dd17991 -->

## Thread — Auto-extend reserve (PR #3071)

An in-place extension settles the closing window's interest, and any late fee, from the borrower-position holder's vault. Until now, no route let a borrower put free principal asset there, so every extension of a loan with interest owed reverted. The borrower now funds an explicit extension reserve: they deposit the loan's principal asset from their wallet into their own vault, recorded and earmarked for that loan's extensions (owner decision, "add an explicit top-up").

The reserve is not free balance. No other withdrawal reaches it, and repayment, default, liquidation and collateral release never take it. An extension draws the current holder's reserve first, then any other free balance they hold in the asset. A new event states how much came from each and what is left reserved. A shortfall refuses the extension and takes nothing. Nothing is pulled from the wallet at extension time, so no standing approval is needed.

Only the current borrower-position holder can fund, and only while the loan could actually be extended (the feature on, the loan active, an ERC-20 loan with no periodic cadence). The depositor can withdraw unused reserve to their wallet at any time, after the loan has closed included. The reserve stays with the depositor if the position moves; a new holder funds their own.

A funding view gives, for a loan and a wallet, the reserve, the other free balance, what an extension would charge now, and the most it can charge (at the end of the extension window). It uses the same charge rule as the extension, so the app can show the holder how much to deposit. The extension test fixture now funds through this route instead of writing the vault counter directly.

Design: [`docs/DesignsAndPlans/AutoExtendReserveDesign.md`](../DesignsAndPlans/AutoExtendReserveDesign.md). Closes #2814.

> Caveat: The app's funding screen and the keeper's use of the funding view are follow-ups for the app and keeper threads; the contracts alone do not show the holder the reserve.

_Committed 2026-10-29 00:54 UTC (db46248ec)._
<!-- assembled-fragment: 2814-auto-extend-reserve.md sha256=9cf3162a47999cf0ca3057e099d7e1e3f0a86f67ce9e2ed6af2373e3f1a7bb62 -->

## Keeper — the extension pass names an unfunded extension (PR #3073)

A borrower can now keep a reserve for a loan's automatic extensions (#2814).
An extension draws that reserve first, then the holder's other free balance
of the loan's asset, and is refused if the two together fall short of what
it charges.

The keeper's extension pass now checks this before it tries. For a loan
whose two sides have consented and whose extension window is open, it asks
the protocol what the current borrower-position holder has ready and what an
extension now would charge. If the reserve and the other free balance
together fall short, it skips the loan and logs the three figures and the
asset, so an operator can see why the loan was not extended. Before, the
same loan was refused at the send's gas estimate with a generic reason.
Nothing was broadcast in either case, so no gas was ever spent on it.

A deployment built before the reserve has no way to report funding. There the
pass says once per run that the pre-check is off, and the send's estimate
still refuses an unfunded extension. The holder is taken from the borrower's
consent itself, which the protocol only reports as active while its setter
still holds the position, so the check costs one read per candidate loan.

Follows #2814 (closed by #3071).

_Committed 2026-10-29 01:30 UTC (7255853b1)._
<!-- assembled-fragment: 2814-keeper-extend-funding.md sha256=53cd5529096107b112965b2ae9322ee11b00334ac33a1850024c19bb092c84b9 -->
