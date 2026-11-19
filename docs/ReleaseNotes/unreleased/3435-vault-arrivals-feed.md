## Thread — Token arrivals in a vault, for "Unrecognised items"

The indexer can now say which tokens have arrived in a vault, whatever sent them. It reads the token contracts' own ERC-20, ERC-721 and ERC-1155 transfer records whose receiver is the vault, from the block the vault was created, and keeps one candidate per asset, standard and token id with the first and last block it was seen. It keeps nothing a token says about itself, and no sender or amount. The new route is `/vaults/<chainId>/<owner>/unrecognised`; the app decides which candidates the protocol's own records already explain.

The read is lazy. A vault is first read when its page asks, a fixed number of block ranges per request, and the indexer's scheduled pass keeps it current for 30 days after it was last asked about. Each answer states the block range read so far and whether it is complete. Only one read runs per vault at a time, reads stop at the chain's settled head so a reorganised block is never recorded, the route is limited per caller, and only an owner whose vault the Diamond reports can be asked about. A vault keeps at most 1,000 candidates (the oldest dropped first, and the answer says so), served 200 per page.

Reading by receiver means asking the provider for logs from any contract, which many public providers refuse or limit to a few dozen blocks. The scan starts at 10,000 blocks per range and halves on a range refusal, logs the size the provider accepted, and keeps it per vault.

Part of #3435 (the indexer feed; the vault page itself is the alpha05 thread's).

> Caveat: how quickly a long-lived vault's first complete answer arrives depends on the provider's range limit for logs from any contract, which is not known from the repository; the indexer logs it on first refusal.
