## Treasury yield retired (PR #TBD)

The Diamond no longer deploys treasury balances into external yield venues.
The "productive treasury reserve" let governance supply idle treasury tokens
to Aave V3, with a Lido venue reserved. It is removed while the platform is
prelive. Its eleven admin entry points and views are gone from the treasury
facet, along with its library, its events and errors, and its test suite.

Why: on the intended mainnet setup the treasury is an external multisig, so
fees leave the protocol as they are collected and the Diamond holds no idle
treasury to deploy. As built, the feature also took on Aave risk for yield it
could never collect, because there was no harvest path (#962). A single venue
loss would have locked its own configuration for good, because nothing could
write a shortfall off (#963). Rather than build harvest and write-off
machinery for funds the protocol should not hold, the multisig holds any yield
position itself, outside the protocol.

The protocol metrics view now reports the treasury as what the Diamond
actually holds. It no longer adds principal recorded as deployed elsewhere.
The six storage slots the feature used keep their places, are marked retired,
and are no longer written or read. The shared Aave pool interface keeps only
the flash-loan entry the flash-loan liquidator uses.

No deployment configured the feature. No script ever set a venue or a pool,
and the live Diamonds on Base Sepolia, Arbitrum Sepolia and BNB Testnet all
read an unset Aave pool and Lido address. A deployment needs the pool, so no
chain has principal deployed through the feature that this change could
strand.

Closes #962, #963, #486, #487.
