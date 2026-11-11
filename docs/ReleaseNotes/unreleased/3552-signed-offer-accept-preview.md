## Thread — Accept preview for gasless signed offers (PR #3564)

An interface can now ask, read-only, whether filling a vault-backed signed offer would succeed and what loan it would produce, before the taker signs anything. Until now the accept preview needed an on-chain offer id, which a signed offer does not have until its fill creates one, so the app could only learn a signed offer was unfillable by a failed transaction.

The new preview runs the same body as the ordinary accept preview, over the offer the fill would create, so the projected principal, rate, collateral and initiation fee and every accept check are the ones an on-chain offer gets. The signed offer's own checks (a Full-tariff opt-in without its ceiling, the signature deadline, the offer's expiry, a cancelled nonce, an already filled or cancelled order) now live in one place that both the fill and the preview read, so the two cannot drift. After those come the signature, the supported shape (both legs ERC-20, no refinance target), the signer's sanctions screen and both assets' pause (live checks that can change after the offer was signed), the signer's free vault balance of the stake, and the offer-book minimum value, in the order the fill checks them. The preview also names the stake asset, the amount the fill draws and how much the signer has free, so a maker who has spent their backing can be shown as unfillable.

What it does not check is stated in its documentation: the creation bounds an app-authored signed offer already meets, the taker's risk-access standing (which has its own preview), and the wallet-backed fill, whose stake is a token transfer a read cannot perform.

Offer expiry is now one rule everywhere: an offer is expired at its expiry second and after. The signed fill's own check used "after" and left the exact second to a later refusal; it now refuses that second itself, as the matcher and on-chain offers already did.

Closes #3552.
