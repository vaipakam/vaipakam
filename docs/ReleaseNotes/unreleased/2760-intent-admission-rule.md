# Lender intents: priced assets and a minimum fill value (#2760, PR #2815)

A standing lender intent could be registered on any pair of tokens with a smallest fill of one unit. Funding it with that one unit put it in the discovery feed the keeper reads every run, so junk-token intents could be added at almost no cost.

Registering an intent now needs two more things. Both of its assets must be priced by the platform's own value rule; every fill is sized from the lender's loan-to-value ceiling, so an unpriced leg could never fill anyway. And its smallest fill must be worth at least a governance-set minimum, 100 numeraire units by default. Governance can set the minimum between 1 and 1,000,000, and it goes back to the default when the numeraire changes.

The rule is checked when the intent is set. A later price move, or a raised minimum, does not remove an intent that was already admitted; setting it again applies the rule again. The feed lists an intent only once its funded capital covers one smallest fill, so the minimum is also the least capital each listed intent commits.

The Protocol Console shows the minimum beside the standing-intent fill switch, and the admin parameter reference documents it. Each setting the console publishes now names the events that announce its change, and the indexer's snapshot refreshes on exactly those, so a changed minimum shows within one scan. Writing that list down found the ETH reference feed can also be changed by a setter that announces nothing, so the console now says its snapshot can lag, as it already did for the sequencer uptime feed.

The rule applies to every intent, including the backstop vault's and the aggregator adapter's. Fresh deploy only: no live chain carries it until the post-waves testnet refresh. (Owner decision 2026-10-25.)
