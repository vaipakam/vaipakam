# The next app lets a borrower lock a quantity of a multi-token NFT as collateral

A borrow request on the next app's Borrow page can now lock NFTs that come in quantities (the multi-token standard, ERC-1155), not only single NFTs. Until now the page named such a collection and sent the borrower to the current app; that hand-off is gone.

For a multi-token collection the form asks for the token's number and how many of it to lock, and says straight away how many of that token this wallet holds, with a button to fill all of them. The review names the quantity and the token, says the collateral is valued at zero so there is no loan-to-value and no price-based liquidation, and that on default the lender receives the tokens themselves. A wallet holding fewer than the quantity is blocked in place with nothing offered to sign.

The multi-token standard has no approval for one token: the protocol can only be allowed to move every token the wallet holds in that collection. So posting grants that approval for this request alone and takes it back in one more wallet step afterwards, whether the request went through or not; the review counts both steps among its wallet prompts and says so. If the wallet had already granted that approval before, it is left exactly as the wallet set it and only the request is signed. Each step counts only when the chain reads it back, and a take-back that did not land or could not be read is stated with what to check in the wallet. While the request's own receipt cannot be read, the page says the approval still stands until it settles. The outcome is read from the transaction's own logs: the request recorded, and exactly that quantity of that token moved from the wallet into the borrower's vault.

The testnet faucet on Home gains a multi-token test collection that mints ten of a fresh token at a time, so the flow can be tried. It reaches each testnet with that testnet's next test-asset deployment; until then the collection is not offered there.

The user guide's Basic and Advanced editions describe locking a quantity of a multi-token NFT in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-NFT-APPROVAL, RB-REVIEW, RB-CONFIDENCE. Epic #3180.
