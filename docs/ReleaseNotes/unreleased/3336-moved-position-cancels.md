## Thread — Anyone may clear a listing whose position moved (PR #3389)

A position NFT moves freely, and a listing or request tied to it can never complete once the position has moved. Before this change, only the offset and lender-sale offers could be cleared by anyone once their position moved. A collateral sale listing, a swap-to-repay order and a refinance request stayed in place until their own expiry. Until then the record stayed in storage and stayed visible in listing views, and the new holder had to deal with a flow that was never theirs.

Each of the three existing permissionless cancels now clears its route as soon as the position has moved:
- The collateral sale listing cancel works at once, fixed-price or Dutch, without waiting for grace or the auction's end. It is recorded with the position-moved reason.
- The swap-to-repay order cancel works at once, before the order's deadline. Both fill hooks already refuse such an order.
- The offer cancel now also treats a refinance request as dead once it is no longer its loan's recorded request on an unmoved position.

None of these cancels releases the loan's own assets: the collateral stays under the loan's lien. The swap-to-repay cancel, like every teardown of that order, also moves the borrower side to the position's current holder, so the still-liened collateral follows that holder into their vault; the others leave it where it is until repay, claim or default. A moved offer or refinance request can also be cleared inside the usual short cancellation cooldown, since nothing can accept it any more. What a creator put in personally, such as a refinance request's fresh collateral, goes back to that creator through the same refund an ordinary cancel makes. The caller receives nothing. No selector, event or storage changed.

This advances #3336. Still to come under that issue: the keeper sweep that finds moved positions and calls these cancels (the keeper thread's work, shipping disarmed), and hiding dead listings in the apps and indexer.

> Caveat: until the keeper sweep is armed, a dead listing is cleared only when someone calls the cancel.
