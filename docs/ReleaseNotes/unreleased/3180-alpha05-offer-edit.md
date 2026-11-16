## New app: change an open offer without cancelling it

The creator of an open loan offer or request can now change it in place from the offer's page: its rate range, its amount range and its token collateral. A refinance request can change only its rate, and the term and the repayment options stay as posted; to change those, the offer is cancelled and posted again. A sale or early-close listing, a rental, an expired or ended offer and another wallet's offer are not offered the change, and a pause or a standing sale order refuses it by name.

The form starts from the offer as the chain holds it and applies the protocol's own shape to what changes, so an out-of-order range, a rate above 100% a year or an amount below what is already filled is caught before review. The review states each figure before and after and what moves. Raising what the offer locks pulls the difference from the wallet into the vault, through an approval of exactly that much; lowering it returns the difference to the wallet, routed like any payout when protected mode is on. A rate change moves nothing. The review also says the offer cannot be taken for a short wait after the change, so no one takes it on terms they did not see, and that a backstop opt-in ends.

The protocol's own check runs before the wallet opens, or, for a pull the approval does not yet cover, right after the approval and before the change; an approval the change did not use is put back. The finish card checks the protocol's record of the new figures against the review and measures what left or reached the wallet.

The "why isn't my offer matching" section now links a rate gap to this change, filled in with the rate that closes it, instead of saying the offer cannot be changed. Closes #3659.
