## Thread — concurrent ERC-1155 rentals no longer overwrite each other (PR #2657)

A lender's vault can hold several units of one ERC-1155 token and rent parts
of it to different borrowers at the same time. The vault recorded each
renter in a single slot per token, so a second rental of the same token
replaced the first renter's record, and repaying or defaulting either rental
cleared the record for every renter of that token. It also recorded every
ERC-1155 renter as holding one unit, whatever quantity was rented. No funds
moved wrongly, but the user rights the vault reports to integrations were
wrong for every concurrent rental.

Each ERC-1155 rental now has its own record in the vault, keyed by its loan,
carrying the loan's rented quantity. Starting, extending, handing over,
repaying or defaulting one rental changes only that rental's record; the
other rentals of the same token keep their renter, quantity and expiry, and
the vault's aggregate quantity and earliest expiry are computed across them.
This holds even when the same borrower rents the same token twice. ERC-721
rentals are unchanged: a token can be rented once at a time and keeps its
single record.

The rental update the platform publishes for integrators now names the
rental it changed, so a subscriber can tell concurrent rentals of one token
apart, including when one of them is revoked. One lender's vault now carries
at most 64 active rentals of one ERC-1155 token at once. Every change to a
token's rentals reads all of that token's records, so without a limit enough
concurrent rentals could make repaying or defaulting one of them cost more
than a transaction allows, leaving it unable to close. A new rental beyond
the limit is refused when it is accepted; rentals whose rights have expired
do not count, and closing or extending an existing rental is never refused.
An ERC-1155 rental offer whose quantity is larger than one rental record can
hold is now refused when it is created, before any units move, rather than
standing open with units no accept could ever record.

Every step of a rental now sets the renter through one Diamond route that
reads the loan for the vault, the token, the asset type and the quantity, so
no caller can pass figures that disagree with the loan. The two earlier
routes are retired. The accept now records the renter just after the loan
is created rather than before, since the loan is what the record is keyed
by.

Rollout: the change spans the vault implementation and every facet that
touches a rental, so it reaches a chain by a fresh deploy, or by the
all-facets refresh together with the vault-implementation upgrade, in one
paused window. Lenders do not have to upgrade their own vaults: the first
rental step that reaches a vault on an older version upgrades it to the
current implementation, so an accept, a repayment, a default or a handover
is never blocked on that. An older vault keeps an ERC-1155 rental's record
under its renter rather than its loan, and the new writes would never find
it, so the in-place refreshes refuse to cross this change while any ERC-1155
rental is open: such rentals are closed first, or the chain gets a fresh
deploy. Because a new rental could otherwise open between that check and
the refresh, the crossing runs only while the operator has already paused
the platform. The curated partial refresh refuses a Diamond
from before this change rather than leave a rental half on the old routes.

Closes #902.
