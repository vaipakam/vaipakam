## Thread — Price settings wait as long as vault code changes (PR #<n>)

On a production chain, a change to a price setting now waits at least seven days, not one. This covers the price guard's own settings (feeds, WETH, secondary sources, tolerances) and the feed registry the guard reads its Chainlink feeds from. The default delay for both is now seven days, up from three. The ceiling stays at fourteen days, and a testnet may still use no delay.

Why: every vault holds the price guard's address in its own code, and the guard decides what collateral is worth. A vault owner who pins their vault's code is protected from a code change for as long as the vault code delay lasts. A price-setting change can move value out of a vault just as surely, so it must stay visible for at least as long. The owner chose to match the vault code delay (seven days, #3421).

The feed registry gets the same floor because the guard prices through it. Without that, a feed change could take effect after one day, behind a guard that otherwise waits seven.

The guard and the feed registry cannot be upgraded, so this reaches a chain only through a fresh deploy. The testnets keep their zero delay.

> Caveat: the protocol registry's own minimum delay (which governs replacing the guard's address for the Diamond) is still three days. It follows the vault code delay, so it moves with #3421.

Advances #3272.
