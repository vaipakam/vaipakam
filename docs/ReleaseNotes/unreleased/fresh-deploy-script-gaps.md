## Thread — the testnet deploy script closes the gaps the last fresh deploy hit

The fresh deploy of 3–4 November ran into several script gaps, recorded in `docs/DesignsAndPlans/FreshDeployHardeningPlan.md`. Each one cost a manual repair mid-deploy. Before the next fresh testnet deploy, `deploy-testnet.sh` and the scripts it runs now close the cheapest and most expensive of them.

Every broadcast is now followed by a check of its receipts. A run that lands a failed transaction stops there and names it, instead of letting later steps build on a half-built Diamond (lesson 1: a diamond cut that ran out of gas on Arbitrum Sepolia).

A fresh deploy now keeps the records that do not belong to the Diamond. These are the keeper wallet the app reads, and the standalone sanctions contracts the sanctions services read: the rehearsal list, its delisting timelock, the oracle stand-in and the clearance attestor. They are carried into the new artifact, and the run prints what it carried. The old Diamond's reward-custody activation record is archived with the rest of its state, so the new Diamond is never described as already activated (lesson 3).

A mirror chain's reward-custody activation reads the mirror's own VPFI token from its artifact, instead of stopping for a hand-passed address (lesson 5).

On BNB testnet a pinned gas price now pins the priority tip as well. The node's 0.1 gwei minimum tip had made the first cross-chain wiring run send nothing. WETH also has one variable name on every chain, the same one the oracle reads (lesson 8).

> Caveat: the explicit diamond-cut gas limits, a recovery phase for an interrupted run, the committed topology and settings file, and reusing the pre-deploy gate across chains are still to build; the operating settings are still restored by hand.
> Caveat: an operator `.env` that still sets the old bare WETH names (`BNB_TESTNET_WETH` and similar) must use `<PREFIX>_WETH_ADDRESS` instead; BNB testnet has no default and refuses to run without it.
