## Thread — realistic testnet faucet prices (mUSDC $1 + ETH-priced mWETH)

The testnet faucet's liquid tokens were all priced identically at $2,000, so
loan math on the test network was unrealistic — one unit of any token was
worth one unit of every other, and a borrow of "1,500 tokens" against "0.1
tokens" looked absurd rather than instructive.

The faucet tokens now carry distinct, realistic USD prices. The second liquid
token is relabelled to look like USDC — "Mock USD Coin" (mUSDC), priced at $1
— and mWETH is priced like real ETH, defaulting to $3,000 and configurable at
deploy time. An optional override lets an operator point mWETH (and the WETH
quote leg) at the network's real Chainlink ETH/USD feed for live price
tracking; because mWETH and WETH then share the same feed, their pool never
drifts. tLIQ stays at $2,000. Together these give a wallet three liquid assets
at three realistic price points, so health-factor, LTV, and liquidation
behave the way they would with real assets.

Because the faucet tokens now carry distinct prices, the mock liquidation swap
venue also had to price cross-asset swaps at the fair ratio (selling 1 mWETH
for ~3,000 mUSDC) rather than a flat 1:1 — otherwise every liquidation on an
unequal pair would miss the oracle-derived minimum output and fall into the
full-collateral fallback. For mWETH and WETH that payout now reads the **live**
Chainlink ETH/USD feed at swap time — the same feed the oracle prices them with
— so it tracks ETH as it moves and never drifts out of the slippage band; tLIQ
and mUSDC use their static fake-stable prices. The deploy script also fails
fast with an actionable message if an operator tries to reuse a swap adapter
from an older script version that predates this pricing.

Making the prices differ required re-deriving each mock AMM pool's spot price
from its assets' feed prices (previously every pool was a trivial 1:1, valid
only because every price was equal). The oracle only treats a token as liquid
when its pool spot agrees with its price feed within a few percent, so the
pools are now computed from the price ratio instead of a fixed constant. A
deploy-sanity test asserts all three tokens still classify liquid at their new
prices and that each reports its intended dollar value.

This is a testnet-only faucet + deploy-script change (mUSDC keeps 18 decimals
for mock-token uniformity; the "$1 stablecoin" behaviour is what matters for
realistic loan math). No production/mainnet surface and no contract `src/`
logic changes. Operators pick it up by re-running the testnet-mocks deploy
(reuse-pinning every existing faucet asset except the relabelled token) and
the frontend deployments sync.
