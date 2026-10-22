## Thread — concurrent ERC-1155 rentals no longer overwrite each other (PR #<n>)

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

Every step of a rental now sets the renter through one Diamond route that
reads the loan for the vault, the token, the asset type and the quantity, so
no caller can pass figures that disagree with the loan. The two earlier
routes are retired. The accept now records the renter just after the loan
is created rather than before, since the loan is what the record is keyed
by.

Rollout: the change spans the vault implementation and every facet that
touches a rental, so it reaches a chain by a fresh deploy, or by the
all-facets refresh together with the vault-implementation upgrade. On the
in-place route each lender's vault must also be upgraded before its next
ERC-1155 rental (an un-upgraded vault refuses that rental's accept), and an
ERC-1155 rental opened before the upgrade keeps its old one-unit record
until that record expires. The curated partial refresh refuses a Diamond
from before this change rather than leave a rental half on the old routes.

Closes #902.
