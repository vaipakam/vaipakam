## Thread — Phase B flow-rehearsal portability (#856) + BNB-testnet cross-chain deploy

Two testnet-rehearsal follow-ups from the Base/Arb Sepolia flow work.

### #856 — Phase B positive-flow rehearsal now runs on any testnet

The Phase B rehearsal (the "new-features" wave of the positive-flow script)
self-deploys mock USDC/WETH and a mock price/liquidity fixture, then exercises
loan lifecycle features that need on-chain risk math (loan-to-value and
health-factor). It passed on a fresh local devnet but aborted on Arbitrum
Sepolia the moment any scenario asked for risk math — the mock USDC was being
classified as an illiquid asset, and the platform refuses to compute risk math
on illiquid loans.

The cause was that the mock liquidity fixture didn't satisfy the platform's
depth check on a real testnet. Two things had to be corrected so the mock
asset reads as liquid on any chain: the fixture now tells the platform which
quote asset to price the mock pool against (previously it inherited the real
chain's own quote-asset list, for which no mock pool exists), and the mock pool
is now priced consistently with the mock price feeds (previously it used a
placeholder 1:1 price, which the depth check rejected because the pool's value
didn't agree with the feed). With both corrected, every Phase B scenario now
runs on Arbitrum Sepolia exactly as it does locally. This is a test/rehearsal
tooling change only — no platform contract behaviour changed.

### BNB-testnet — cross-chain stack deployed and indexed

The BNB Chain testnet deployment previously had only its core diamond and
timelock. Its cross-chain stack (the mirror VPFI token, the messenger, the
token pool, the rate governor and the reward messenger) is now deployed and the
mirror VPFI token is registered on the diamond. BNB testnet has been added to
the indexer's active-chain set, and the indexer now tracks it alongside Base
and Arbitrum Sepolia. The earlier "stuck on BNB RPC" blocker turned out to be a
minimum-gas-price requirement on the network rather than an RPC-connectivity
problem.
