## Thread — Base Sepolia no longer routes the eleven functions its code had retired (PR #2400)

Base Sepolia was refreshed in place once more on 4 October (paused briefly from 03:00 to 03:07 UTC), using the refresh change from #2385. That change removes every function the current code no longer has. Base Sepolia had still routed eleven of them, each to the code it was last installed with:
- older shapes of the offer-accept entry points;
- two keeper-approval setters from before keeper permissions changed shape;
- four reward and acknowledgement receive hooks.

The refresh removed all eleven and checked each one afterwards, and a read of the live chain confirms none of them is routed. All 103 transactions succeeded. Every facet the deployment script installs was replaced with a fresh copy of current main. The facet that performs upgrades, which the Diamond installs when it is created, was not touched, and neither was the vault template, and the Diamond address did not change. The deployment record now covers every address the Diamond routes to. Those records are the per-chain file, its provenance record and the consolidated copy the apps and workers read. This closes #2313.

The routing record that reward-custody activation checks was taken again over the clean routing. Activation itself was not run: the owner deferred it on 4 October until the VPFI recycling work is ready. Until it runs, Base Sepolia keeps refusing reward claims and remittances that need freshly funded VPFI. Payouts funded only from recycled VPFI are unaffected.
