### Matching now requires NFT offers to name the same token (#3328)

Matching two offers compared only the NFT collection, not the token, unless the borrower was refinancing. A loan opened by a match carries the borrower offer's token, so a lender who offered against one token could have been matched with a borrower holding a different token of the same collection. The same was true of the rented token in an NFT rental. A match is now admitted only when both offers name the same token, and for ERC-1155 the same quantity, on every NFT leg. Direct accepts, refinances and loan sales already checked this and are unchanged.

This was found while preparing collection offers (#3328). Those offers will let a lender state a set of tokens, rather than have the matcher choose one.
