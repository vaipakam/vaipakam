## Thread — A price read through two feeds keeps the finer feed's precision (PR #TBD)

Part of the #2419 scale change. When no direct feed prices an asset in the
active numeraire, the protocol combines two feeds: the asset's price in ETH
with ETH's price in the numeraire, or, on the PAD route, the asset's price in
the PAD with the PAD-to-numeraire rate. The combined price is now reported at
the finer of the two feeds' precisions, with one rounding down at the end, so
it carries every digit both feeds supply. Every caller already reads a price
together with its decimals, so values, loan-to-value and health-factor figures
come out the same whatever precision the feeds use.

Funds: no transfer, fee or settlement rule changes. The change is to how a
composed price is expressed; valuations through it are exact to the finer
feed's precision.

Part of #2419.
