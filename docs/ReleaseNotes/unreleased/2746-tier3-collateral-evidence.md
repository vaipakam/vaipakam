## Keeper — Tier 3 needs evidence the asset is used as collateral elsewhere (PR #2806)

Before the keeper's liquidity relay promotes an asset to the deepest tier, an
off-chain advisory checks that the asset is "battle-tested elsewhere". It used
to pass on any two of three signals, and two of those, market cap and trading
volume, come from the same CoinGecko response. So a popular, volatile token with
no lending-market footprint could pass on CoinGecko alone, which the advisory's
own description said must not happen. Its lending-market signal also counted any
pool that held the token, including supply-only pools and markets on a venue
where anyone can list any collateral.

The lending-market signal is now required, and it now means collateral. The
asset must be enabled as collateral, with a loan-to-value above zero as DeFiLlama
reports it, on an Aave v3 or Compound v3 pool with at least the configured TVL on
that chain. Market cap or trading volume must back it, but neither can stand in
for it. Morpho Blue no longer counts: its markets are permissionless, so a listing
there says nothing about a curator's decision. Aave's zero loan-to-value is
ambiguous (not collateral, frozen, or e-mode only) and is read as no evidence.
An operator who turns the lending-market signal off now gets no Tier 3
promotions at all, since market presence cannot stand in for collateral evidence.
The keeper also keeps only the rows it needs from the two DeFiLlama responses
instead of the whole pool list.

Closes #2746.
