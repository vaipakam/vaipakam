## Why an Auto-lend is not lending

An active Auto-lend with money waiting now offers "Why isn't it lending?" on its card in Positions. Opened, it finds the open borrow requests on the Auto-lend's pair that sit closest to its terms, and asks the protocol whether it would fill each one from this Auto-lend now.

It then states one thing: the closest request's first refusal, in the protocol's own terms (with both rates, or both terms, where the gap is one of those), or that the protocol would fill a request now and is waiting for a matching service to send it, or that no borrow request stands on the pair. It never promises a fill.

The index serves the closest requests through a new route that ranks them by the same rule as the existing "why isn't my offer matching?" panel, so the two panels choose counterparties the same way. If the index does not answer, the panel says the closest requests are unknown rather than that there are none.

Closes #3660.
