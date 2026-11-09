## Thread — Keeper backup on Chainlink Automation

A new standalone contract, the keeper backup runner, lets Chainlink Automation run a set of permissionless upkeep steps when our own keeper has left them undone too long. The keeper runs on one machine, so until now a step nobody else called stayed undone while that machine was down, out of gas or stuck.

The runner keeps no rule of its own about when a step is due. On each check it tries every candidate step in a call whose effects are always undone and keeps only whether it would succeed, so it cannot drift from the protocol. A due step is first noted, and is run only if it is still due after a delay set per step (an hour by default, 15 minutes for the grace auto-listing, which the protocol accepts only inside a grace that can be one hour); if our keeper runs it in the meantime, the runner does nothing.

It covers daily rental deductions, expired listing and intent teardowns, the grace auto-listing of NFT collateral, past-grace defaults and periodic-interest stamps that need no sale, the Base reward-day close, the lapses, skips and recycling of finished reward days, and the vault-code changes whose delay has passed. It does not cover liquidations or matching, anything needing a swap route, quote or cross-chain fee, steps found only from event history, the reward-day finalize, or backstop fills. The design note is docs/DesignsAndPlans/KeeperBackupAutomationDesign.md.

The runner holds no funds and attaches no value to any call. It accepts runs only from its Chainlink forwarder, and builds every call itself from a step id, so a compromised forwarder can call nothing but the listed steps. Tokens a step pays it go only to the treasury fixed at deployment.

Every step ships switched off. Deploying it, registering the upkeep with Chainlink and funding it with LINK, and switching on each step are owner decisions per chain. Delayed protected payouts and position releases can be added once the protected-account facets expose a read that lists them.

Closes #3361

> Caveat: a liquid loan past grace is not backed, because its default needs a sale and the runner passes no swap route.
