## Keeper — daily market-cap rankings for asset trust tiers (PR #<n>)

The keeper has a new duty, the asset rankings pass. It keeps the rankings
behind the app's asset trust tiers fresh: blue chip, top 100, and so on down
to top 500, with an own-risk warning beyond. It advances #3446; the app side,
the shared tables and the read route are separate work.

Once a UTC day, for each of two public market-data sources and each mainnet
chain (Ethereum, Base, Arbitrum, Polygon, Optimism and BNB Chain), the pass
fetches the top 500 coins by market-cap rank. It then maps each coin to its
contract address on that chain. The rank is matched by address, never by name
or symbol, so a look-alike token never inherits a listed token's tier. Keeping
the two sources side by side lets the app show a disagreement instead of a tier.

A good fetch replaces that source's list for the chain and records the run in
one database step, so a reader never sees half a list. A failed fetch keeps the
last good list and records that the day failed and why, so the app can say how
old its list is. Two cases count as failures and are never written: a ranked
list shorter than 400 coins, and a chain that maps to no address at all. The
second means a wrong platform id or a changed response, not a chain without
tokens. A failed day is retried hourly.

The pass runs on the keeper machine, not in the agent Worker. The coin list is
about 4 MB, more than the agent's CPU allowance can parse. It reads both
sources without an API key and sends no transaction. It ships switched off
behind `ASSET_RANKINGS_ENABLED`; arming it is the owner's call.

> Caveat: both sources are used on their free, keyless tiers. If either starts
> refusing keyless calls, its rows go stale and each day's run records why.
> Adding a key is a follow-up.
