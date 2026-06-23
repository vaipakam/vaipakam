## Thread — Confirm the treasury buyback stays dormant + reroute the staking overflow (PR #<n>)

Closes the VPFI legal-program excision (#687, after the fixed-rate sale in
#711 and the 5% staking yield in #714). The treasury buyback stays **dormant**
for Phase 1 (the ratified "Option 2"): there is no automated funding path and
no new admin enable/disable knob — every buyback entry point is already
admin-only and default-off, and the kept reward budgets
(`rewardEmissionsBudget`, `keeperRewardBudget`) degrade gracefully to zero when
their top-up targets are unset.

The one concrete change is reconciling the leftover the staking-yield removal
exposed: the buyback "priority router" used to send any overflow (proceeds past
the rewards + keeper top-up targets) into a staking-pool budget that — now that
the 5% staking yield is gone — has no way to ever be spent. Rather than let a
buyback silently strand VPFI in that dead budget, the overflow tier is removed:
a buyback fill that would deliver more VPFI than the two top-up targets can
absorb now reverts instead of accumulating an unspendable balance. In the
dormant Phase-1 configuration this is never reached (no buyback is committed and
both targets default to zero). The dead `stakingPoolBuybackBudget` budget, its
read-only getter, and the now-unused fourth field of the buyback-split event are
deleted.

Swap-to-repay, which shares the same intent-dispatch plumbing, is unaffected.

Closes #710. Part of #687.
