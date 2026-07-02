## Thread — BNB-testnet oracle configured via PancakeSwap (no 0x dependency)

The BNB Chain testnet deployment now has its price-oracle and liquidation
routing fully configured, completing the earlier BNB cross-chain + indexing
work. BNB testnet can now price assets and run risk math (loan-to-value,
health-factor) rather than fail-closing every asset to illiquid.

The notable part is how liquidation swaps are routed. The platform's
HF-liquidation path isn't tied to one venue — it tries a configurable list of
swap adapters in order. The default testnet setup uses the 0x and 1inch
aggregator adapters, but neither aggregator has a BNB-testnet backend (0x's
swap API covers BNB mainnet but not the testnet). Rather than leave BNB
testnet without a liquidation route, a Uniswap-V3-style on-chain swap adapter
was pointed at PancakeSwap V3 (which is a Uniswap V3 fork with a compatible
router). This gives BNB testnet a fully on-chain liquidation route with no
dependency on an external aggregator API.

To support this, the oracle-configuration script now recognises BNB (mainnet
and testnet) and treats the 0x proxy as optional: when it isn't configured, the
script requires that at least one on-chain swap adapter is already registered
(validated before any transaction is broadcast, so a misconfigured run can't
leave the chain half-configured), so a chain can never end up with no
liquidation route at all. Chains that do have 0x (all mainnets, including BNB
mainnet) continue to require it as before.

The price numeraire follows the platform's canonical rule: the "WETH" oracle
slot must be a bridged-WETH9 (ETH-denominated) token plus an ETH/USD feed —
never the wrapped-native — because the pool-depth valuation assumes
ETH-denominated value. BNB testnet has no canonical bridged-ETH, so a deployed
18-decimal WETH stand-in is used there (mainnet BNB and, later, Polygon use
their real bridged-WETH9). This keeps the configuration production-representative
and identical in shape across every non-ETH-gas chain. The keeper's swap-quote
registry was also given a BNB-testnet entry (PancakeSwap's V3 quoter + the
on-chain adapter index) so the keeper actually produces liquidation quotes for
the chain rather than skipping it.

Every BNB-testnet address was verified on-chain before use (the price feed, the
PancakeSwap factory / router / quoter — the router and quoter both confirmed to
share the oracle's configured factory), and the result was confirmed by checking
that the numeraire asset classifies as liquid on the BNB-testnet diamond.
