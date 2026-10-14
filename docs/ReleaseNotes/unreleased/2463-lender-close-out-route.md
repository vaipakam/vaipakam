## Lender close-out — liquid collateral past grace (#2463)

A lender whose loan is past its grace period could already close it out from the loan page when the collateral is handed over as it is, when the protocol can settle it against an opposing loan, or when it is an NFT rental. The commonest case, ordinary liquid ERC-20 collateral, had no button. The protocol requires that collateral to be sold on an exchange, and the close-out has to carry a list of exchange routes for the sale. The app had no way to build one, so the card could only say the loan was closable and to contact support. Base Sepolia loan #21, about 85 days overdue, sat in exactly that state.

The card now asks the operator's agent service for the route. The agent builds it with the same route builder the keeper uses, which has moved into the shared library so there is one implementation, not two. It sizes the sale from the chain exactly as the protocol performs it: the whole collateral, executed by the protocol. Exchange API keys stay on the server. On test networks the builder also uses the faucet's mock exchange, found by name rather than by a fixed position, so test-network loans can be closed out too.

With a route in hand, the card offers the close-out. Right before sending, it fetches the route again and checks it is for the loan's current collateral. If the collateral changed, or the route is gone, nothing is sent and the lender is told why. The card also says what happens if every route fails when the transaction runs: the loan moves to the protocol's fallback settlement instead of being sold. When there is no route, the card says which reason applies: no exchange can quote the sale, the service could not be reached, or this build has no route service. It names no amount, because the sale price is decided when the transaction runs.

The keeper's behaviour is unchanged on its existing chains. On test networks it now also sees the mock exchange, so it has a route where before it had none. A keeper pass that closes past-grace loans on its own, and an alert to lenders when grace ends, remain follow-ups.

Closes #2463.
