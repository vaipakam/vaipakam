## Frontend — BNB testnet is now a user-facing chain

BNB testnet (chain 97) now appears in the app's network switcher and wallet
network picker, so a connected wallet can select it like any other supported
testnet. Previously it was tracked by the indexer but deliberately hidden from
the app, because its price-oracle configuration hadn't been completed yet — a
half-configured chain would have made lending and risk flows misbehave.

That oracle configuration has since landed (a numeraire price feed plus an
on-chain PancakeSwap-based liquidation route), and sample loan/offer flows are
already being indexed on the chain, so the chain has graduated from
"indexed-only" to fully user-facing.

One caveat worth knowing on the testnet specifically: only the chain's numeraire
asset is deeply liquid, so offers using other BNB-testnet assets will be valued
and routed conservatively. That is an accepted limitation of the testnet
environment and does not affect the mainnet BNB configuration.

Note for operators: the deployed app must be re-published for this change to
appear on the live site.
