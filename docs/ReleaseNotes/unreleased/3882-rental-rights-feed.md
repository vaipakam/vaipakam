## Indexer — who may use a rented item, on the public feed

The indexer now keeps a table of rental rights, rebuilt from the platform's own `VaultRentalUpdated` events: one row per rental, with the collection, the token, the owner of the vault holding it, the recorded user, the expiry and the quantity. A later update replaces a row and an older one never does, so a re-scan cannot put a past state back. A clearing keeps the row with no units, and a rental past its expiry stops counting by time alone. Two rentals of one ERC-1155 token stay apart, one row each.

Two routes in the public data feed answer from that table alone. `/public/v1/rentals/by-collection` lists each active rental of one collection, optionally for one token, a page at a time. `/public/v1/rentals/may-use` lists the active rentals in one collection that name one address as user, which is the answer a game or service needs to decide who may use an item. Each takes exactly one collection, and `may-use` exactly one address; a list, a repeated parameter or a wildcard is refused.

Both routes are public because they return only what the chain already publishes: every row restates one event, and an ERC-721 renter can also be read from the owner's vault. They do not hide who rents. They never join anything the platform keeps for a wallet, and a test holds that both read the rental table and nothing else.

"Active" is judged at the time of the answer rather than at the indexer's last block, because an expiry is a time and not an event: an expired rental is never shown as a right.

Closes #3882. Design: `docs/DesignsAndPlans/ProjectKitDesign.md` §6 and §12.
