## Thread — keeper backstop for listing NFT collateral during grace

While a loan backed by an NFT is in its grace window, anyone other than the borrower-position holder may put the collateral up for sale at the protocol floor. The floor is the asking price that pays the lender and the treasury what they are owed, plus the configured buffer. Nothing made that call on a schedule. So a grace window could pass with the NFT never offered, and the lender took it in kind at default even when a buyer at the floor existed.

A new keeper duty, grace auto-list, now makes the call every minute on every chain it serves. It ships switched off, behind its own arming flag. Every minute because the shortest grace window is one hour.

The keeper decides whether a loan is in grace from the loan's own deadlines, pause credit included, against the chain's clock. It works only loans whose terms allow a prepay listing, whose collateral is an NFT and whose principal is a token, and whose borrower has not opted out of auto-listing. With no listing up it posts one at the floor. A listing above the floor, or one built on amounts that have since grown, is moved down to it.

The price is always the protocol's floor at the moment the call lands; the keeper never chooses one. The run's report names each listing with its asking price, and each loan the protocol declines with the protocol's own reason. The keeper pays only gas and moves no value to itself. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: at most six loans per chain are tried each run, and a large book of active loans is read a window per run, so on a busy chain a loan can wait a few runs before it is listed.
> Caveat: it does not withdraw a listing once grace ends. Whether the keeper should cancel expired listings is an open question on #2984.
