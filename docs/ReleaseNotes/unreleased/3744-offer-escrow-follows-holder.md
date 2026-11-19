## Thread — An open offer's escrow follows its position token (#3744)

An open offer has its own position token, and whoever holds it when the offer fills takes the loan position. Its escrow and its rights now follow that holder too (owner decisions of 2026-11-18 and 2026-11-19).

Cancelling an offer before it expires, editing it, and lowering a collection offer's loans are for the account manager of the token's current holder, not the creator once the token has moved. Anyone may still clear an expired offer, an offer whose route is dead, or an offer of a recovered account.

Everything an offer returns goes to the vault of the token's holder as free balance: a cancel, an expired-offer cleanup, a downward size edit, a collection offer's released backing, a match's unused collateral or closing remainder, and a direct accept's unused collateral. One host (`OfferCancelFacet.refundOfferEscrow`) does this for every step, and the outflow policy reads the holder from the token, so no step names a payee. While the creator still holds the token nothing moves: the escrow becomes free in the creator's own vault. A holder's size increase is paid from the editor's wallet into the creator's vault, where the escrow and its lock live.

A step someone else triggers is never blocked by a holder who cannot be paid, such as a sanctions-flagged wallet with no vault. The amount then stays in the creator's vault, reserved for the token so the creator cannot take it, and the token's holder collects it with `collectOfferRefund`. `OfferEscrowReturned` names the holder for every return and says whether it was held; `OfferRefundCollected` records a collection.

The cancel refusal `NotCreatorOrNotExpired` keeps its name for the decoders that read it, but its first field is now the token's holder. An edit by someone who does not manage the holder is refused with `NotNFTOwner`.
