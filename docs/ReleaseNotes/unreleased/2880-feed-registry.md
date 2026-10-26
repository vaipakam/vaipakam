## Thread — Every chain prices through its own Chainlink feed registry (#2880)

Outside Ethereum mainnet, the oracle could price WETH and nothing else. It finds every other asset's Chainlink feed through a feed registry, and Chainlink runs its registry on Ethereum mainnet only. So on Base, Arbitrum, Optimism and Polygon every other asset would have read as unpriced, and therefore illiquid. Testnets hid this because their mock rig deployed a mock registry. Every chain, Ethereum included, now deploys Vaipakam's own registry in the contracts phase. The Diamond prices through it with no oracle-code change, because the registry answers the same lookup Chainlink's does.

The registry holds only official Chainlink feeds. On every add or replace it checks what the chain can prove: the token answers its decimals, and the feed answers the declared decimals and pair name. The pair's quote must also be the one the entry is filed under, so an ETH-quoted feed cannot become a USD price, and the feed's latest answer must be positive and within its heartbeat. What the chain cannot prove, which token a pair name means, is left to a reviewed per-chain record. Every change also carries the hash and date of the Chainlink directory file it was checked against.

Every change waits a delay the Pauser Safe can veto: adds, replacements and removals alike. The delay is three days by default on a production chain (one to fourteen allowed) and zero on a test network. A proposer key may propose low- and medium-risk feeds only. Higher-risk feeds need the owner, which becomes the Timelock at the handover. The handover also moves the registry's veto to the Pauser Safe, and the handover gate refuses any other holder.

Configure now points the Diamond at the recorded registry on every chain and takes the USD and ETH denominators from it. The old denominator and registry environment settings are retired. The testnet and Anvil mock rigs and the end-to-end fixture now register their mock feeds in the real registry, so the shape the testnets run is the shape a mainnet runs. Fresh deploy only.

Still to come under #2880: the tool that drafts each chain's reviewed bindings from Chainlink's directory, cross-checked against CoinGecko, CoinMarketCap and the chain's token list. After that come the service that proposes and executes the merged bindings, and a launch-readiness check that the registry is set. #2745 (secondary oracle keys from the registered pair name) builds on this.

Part of #2880.
