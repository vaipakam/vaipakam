## Thread — position NFTs are read only from the standalone PositionNFT (#3321)

The position NFTs moved out of the Diamond into a standalone PositionNFT contract in #3205. Until now every off-chain reader carried two modes: the standalone contract where a chain's deployment record names one, and the old Diamond-hosted NFT otherwise. That second, legacy mode is gone. The app, alpha05, the indexer, the keeper, the shared library and the test drivers now read owners, approvals, transfers and holder locks only from the PositionNFT, and read a position's open route and retirement only from the Diamond.

A deployment record that names no PositionNFT is now refused with an error that names the chain and its Diamond. Nothing falls back to reading the Diamond as if it held the NFTs, because a Diamond that does not host them would answer with something misleading, or not at all. This change lands with the fresh deploy, which writes the PositionNFT address into every chain's record; until that deploy reaches a chain, position reads on it fail closed rather than guess.

The pieces that only existed for the old mode are removed with it. The keeper no longer runs a step that released queued position-NFT transfers for protected accounts, since the contracts no longer queue them. The Protection page no longer shows an NFT transfer queue or the old "protect my NFTs" setting; it shows the PositionNFT holder lock only. The copy that told users an open sale listing or offset blocks moving the NFT is gone, leaving only the current rule that moving the NFT cancels the listing or offset. The indexer watches only the ERC-721 events of the PositionNFT, and the activity feed no longer lists the retired transfer-queue events.

The Terms-of-service write gate drops the four retired NFT-queue functions, and the app's protected-account reader no longer reports the two retired NFT protection fields, which the contracts keep only as unused storage.

Closes #3321

> Caveat: until the fresh deploy adds a PositionNFT to a chain's deployment record, the app, indexer and keeper refuse position-NFT reads on that chain.
