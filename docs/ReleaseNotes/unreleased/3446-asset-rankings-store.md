## Thread — indexer: a store and a read route for public token rankings (PR #3492)

The indexer now has a place to keep the public market-cap rankings of tokens, and a public read route that serves them. This is the first part of the asset trust tiers in #3446: the connected app will use the ranks to sort an unfamiliar token into a tier (blue chip, top 100 to top 500, unranked) and to warn when a token copies a ranked token's symbol.

The rankings are fetched once a day by a keeper pass on the keeper machine, which ships disarmed and is built separately. The app cannot fetch them itself, because the list keys must stay off the client and one fetch serves every user. Each run stores a source's whole list at once; a failed run records only that it failed and leaves the previous list in place.

The route `GET /assets/rankings?chainId=` takes the token's own chain, which is required. It lists each ranked token once, keeping each source's rank, name and symbol apart, because two lists can name the same contract differently. For each source it states when the stored list was fetched and how the last run went, so a failed refresh is shown beside the older list rather than hidden. It carries ranks only, never a trust verdict: the tier rule is the app's. Before the tables exist it answers "unavailable", never an empty list.

The rankings describe tokens, not a Vaipakam deployment, so a fresh Diamond on a chain does not wipe them.

Part of #3446.
