## Indexer — internally matched loans now show as settled once claimed (#2464)

When both sides of an internally matched loan have claimed, the protocol settles it. The indexer kept showing these loans as internally matched anyway, so the loan page, Positions and the desk read as if claims were still pending. The handler for the protocol's settlement event only accepted a hand-written list of earlier states (repaid, defaulted, liquidated) and left internally matched loans out. Meanwhile the handler for general status changes deliberately leaves this step to the settlement event, so nothing ever corrected the row. On Base Sepolia, loans 24–27 were stuck this way.

The indexer now treats the protocol's settlement event as authoritative: it settles a loan whatever state the loan was in. It no longer keeps a second copy of the contract's rules about where settlement can come from. A one-time migration settles the loans already stuck this way, but only where the indexer's own event log shows the settlement, and it dates each one by that event.

Closes #2464.
