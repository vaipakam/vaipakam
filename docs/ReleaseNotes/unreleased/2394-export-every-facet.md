## Thread — The combined Diamond ABI covers every facet the Diamond has (PR #<n>)

The app, the indexer and the keeper read the Diamond through one combined ABI
built from a hand-kept list of exported facets. That list left out eight
facets the Diamond actually runs, on the reasoning that they were internal
plumbing nobody calls directly. But a facet carries its events and errors as
well as its functions, so the combined ABI was missing things the Diamond does
emit: four reward-expiry events, which the indexer could therefore not decode;
the revert raised when an unexpected NFT is sent in, which the app could not
name; the role, ownership and diamond-upgrade events; and the borrower-fee
step of accepting an offer.

Following an owner decision, every facet the Diamond has is now exported —
the eight added are the access-control, ownership, NFT-receiver, diamond-cut,
offer-acceptance-fee and three reward-walk facets — and the exclusion list is
gone rather than reasoned about case by case. Listing an internal function in
an ABI authorizes nothing. A new deploy-sanity check fails whenever the
exported list and the Diamond's own facet set differ in either direction, so a
facet added later cannot be left out silently. No existing facet's ABI
changed, and no function or event name became ambiguous.

One gap remains and is tracked separately: the Diamond proxy's own
"function does not exist" revert is declared on the proxy contract rather than
on a facet, so it is still not in the combined ABI. Closes #2394.
