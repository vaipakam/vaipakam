## Thread — Sanctions screen on the buyer of listed collateral (PR #2646)

A collateral sale through the marketplace now screens the buyer, not only
the sale's recipients. Before, the fill re-checked the borrower, the live
position holders and the fee recipients, but never the account buying the
collateral, so a flagged wallet could buy a borrower's listed NFT. Now the
fill is refused when the account filling the listing is flagged and, for
ERC-721 collateral, when the account holding the NFT after the fill is
flagged (which covers a buyer who sends the NFT to another wallet, and a
marketplace match someone else assembles). The platform's own offer-match
path screens the bidder before it calls the marketplace. Each screen uses
the same outage-aware sanctions read as the existing recipient screens.

What stays outside is stated in the code and the functional spec rather
than implied: the marketplace does not tell the platform where ERC-1155
collateral goes or who paid in a match someone else assembled, so a
flagged recipient of ERC-1155 collateral that is not the account filling
the listing, and a flagged paying bidder of such a match whose NFT goes to
an unflagged account, are not seen.

Closes #1279.
