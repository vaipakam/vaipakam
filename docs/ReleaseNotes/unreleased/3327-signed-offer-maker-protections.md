## Signed offers carry the maker's protections

A gasless signed offer stays fillable for as long as its maker leaves it, by
anyone holding the signature. Until now the maker could not limit the fees a
fill would charge, who could fill it, or cancel many offers at once without one
transaction per nonce. Four new signed terms and one new action close that gap.

The maker now signs the highest treasury fee and the highest loan initiation
fee they accept, and a fill is refused while either protocol fee is above its
cap (only while it stays above: the offer is fillable again if the fee comes
back down, so cancelling is what stops it for good). They may name the one
wallet allowed to fill (on a match, the creator of the counterparty offer), and
a co-signer whose fresh approval, lapsing within fifteen minutes, each fill
needs. The approval is bound to how much of the offer was already filled, so
it can be spent on one fill only, and a leaked signature alone cannot be
filled.
A new cancel-floor action cancels every offer the wallet signed below a chosen
nonce in one transaction; the floor only rises.

All of these live in one shared fill rule that the direct fill, the keeper
match and the accept preview all read, in one order, and the preview reports
each refusal by name. The off-chain book checks the new fields and the floor on
the way in, drops every offer below a floor as soon as it rises, and removes
offers stored in the old shape, because the signed fields changed the
signature: offers signed before this change cannot be filled after it.

Both apps sign the fees their review showed as the caps, draw nonces above the
wallet's floor, and name no taker or co-signer. The connected app refuses to
post when the fees moved since the review, and keeps a restricted order in the
book as depth with no Fill button and a tooltip saying why. Asking a
co-signing service, choosing a taker and a cancel-all control are follow-ups.

On the live testnet, signed offers stop working between this merge and the
next fresh deploy, since the deployed contracts still expect the old shape.

Advances #3327 (part 1 of 2; Merkle offer sets follow).
