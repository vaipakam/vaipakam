### Offer creation split so collection offers have room (#3328)

The offer-creation facet had about 300 bytes left under the contract size limit, and collection offers need the step that turns an off-book offer into an on-chain one to accept NFT collateral. That step now has its own facet, the offer materialize facet: it carries the two Diamond-only entries the signed-offer accept and match, and the standing-intent fill, call to put an offer on the book at the moment it fills. The plain creates stay where they were.

What an offer is (every check, the offer record, its position token and its book entry) is now one shared library that both facets run, so the rule exists once. Nothing changes for users: the function names, errors and events are the same, and only the facet that hosts the two internal entries moved. Each facet now has about 3.7 KB of room.

Advances #3328.
