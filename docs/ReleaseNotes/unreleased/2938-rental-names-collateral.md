## Thread — The rental review refuses a listing that names collateral, and says why (PR #<n>)

A rental takes no collateral. Accepting one pulls only the renter's
prepayment, and a rental default pays the prepayment out and returns the NFT
without ever reading the listing's collateral fields. Nothing stops a listing
from being created with those fields set, though, and the contract then asks
the renter to acknowledge the named asset if it is unpriced. Since #2936 the
app acknowledges only what its review showed. Such a listing was therefore
refused before signing, with the generic "terms changed" message, and a fresh
review showed the same thing again with no reason given.

The rental review now recognises a listing that names a collateral asset,
amount, token id or quantity, whether the indexer row or the offer read live
from the chain names it. It says plainly that a rental takes no collateral
and that the app does not accept a listing in this shape. The accept button
stays disabled, and the same refusal applies at submit. The app's own rental
create never sets these fields. The contract-side rule that refuses such a
listing at creation is tracked separately (#2949), so after the all-waves
deploy no such listing can exist. Until then the app refuses it openly, where
before #2936 it would have acknowledged the unused asset silently.

Closes #2938.

> Caveat: there is no end-to-end test of the refusal, because no such listing exists on any testnet and the app cannot create one; the rule is unit-tested.
