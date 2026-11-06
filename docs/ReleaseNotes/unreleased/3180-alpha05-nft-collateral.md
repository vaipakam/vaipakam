# The next app lets a borrower post a request that locks one NFT as collateral

A borrow request on the next app's Borrow page can now lock an NFT instead of a token. The test NFT collections a testnet publishes are offered beside the tokens, marked as NFTs, and any collection can be pasted. Whether a pasted address is a token or an NFT collection is the contract's own answer, read from it; if that read fails, the page says the kind is unknown and offers no request rather than guessing.

For an NFT, the form asks for the NFT's number (its token id) instead of an amount, and says straight away whether this wallet holds it, another wallet does, or no such NFT exists. The review names the NFT being locked, says the NFT is valued at zero so there is no loan-to-value and no price-based liquidation, and that on default the lender receives the NFT itself. A token another wallet holds, or one that does not exist, blocks the request in place with nothing offered to sign.

Posting asks the wallet to approve the protocol for that one NFT only, never the rest of the collection, and only when it is not approved already. The approval counts only when the chain reads it back after it lands. If the request does not go through afterwards, the approval is put back while it still reads the protocol and the wallet still holds the NFT; otherwise the app says what it found instead of overwriting it. Moving the NFT into the vault clears the approval by itself. The outcome is read from the transaction's own logs: the request recorded, and that exact NFT moved from the wallet into the borrower's vault.

NFTs that come in quantities (the multi-token standard) need an approval over the whole collection that must be taken back afterwards, so for those the page says so and links the current app's Borrow page until that step is built. Taking a lender's offer that asks for an NFT as collateral is also still left to the current app; the offer list counts such offers.

The user guide's Basic and Advanced editions gain a section on NFT collateral in every language.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-NFT-APPROVAL, RB-REVIEW, RB-CONFIDENCE. Epic #3180.
