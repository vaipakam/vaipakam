## Issuer-power check results are stored and served (#3433)

A vault can lose an asset, or be unable to move it, without any protocol call: some token issuers can claw tokens back, force or freeze transfers, pause the token or replace its code, and some collections run a transfer validator that can block the platform's transfers. The contracts stay uncurated, so these powers are looked for off-chain and disclosed in the apps.

This change adds the place those results live. Two new shared tables hold, per token or collection on a chain, the last run of the checker: what it took the contract to be, when it looked and at which block, which list of checks it applied, whether every check ran, and each check's result with the public evidence behind it. The indexer serves them read-only at `/assets/issuer-powers`, beside the market-cap rankings.

The route states facts, never a verdict. "Not found" means the checker looked and did not find that power, never that an asset is safe. A check that could not run is reported as unknown, an asset that was never checked is named as such, and a check this build does not recognise is still returned rather than dropped. Before the tables exist the route answers "unavailable" rather than an empty list.

The keeper pass that runs the checks and writes the rows is separate work; until it ships, the route returns no results.

Part of #3433.
