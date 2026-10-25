## Thread — A tier push never blocks staking, unstaking or a loan start (PR #2853)

On Base, every action that changes a user's VPFI standing also sends their new discount tier to the mirror chains. That includes stake, unstake, loan start, the fee paths at settlement, consolidation and the tier poke. Until now that send was all or nothing, and it ran inside the user's own transaction. So the action failed whenever the send could not go out: the protocol's broadcast budget was empty, one destination lane was down or paused, or no destination was configured. Anyone could drain the budget cheaply by switching their discount consent off and on and poking their tier. Once it was empty, every unstake that lowered a tier failed until an operator topped it up. A single dead lane froze tier-changing actions for everyone.

A tier push now never makes the user's action fail. Base's own tier is current at once. Each mirror lane is delivered on its own and is owed the new tier until it gets it. A lane that cannot be reached right now stays owed and is announced on-chain with the reason. Reasons include an empty budget, a lane that cannot be quoted or sent, and a paused messenger. The user's next tier-pushing action retries it, and so does anyone who calls the new delivery entry point.

The protocol budget pays at once for a lowered tier and for a lane's first push. It pays for any other change, such as a raised tier, at most once per lane per spacing window: one day by default, settable by the admin between one hour and seven days. That limit bounds what the consent-toggle loop can drain. Anyone who wants an owed push delivered sooner can pay its fee themselves. Caller-paid delivery has no spacing limit, and any unspent value goes back to the caller.

A transaction cannot skip a push by withholding gas. Base attempts each lane only with a fixed amount of gas in hand, well above what the delivery needs, and reverts the whole action otherwise. A lane that fails has therefore failed on its own.

Each user's per-lane delivery state is publicly readable. A budget-paid send debits only what actually left the contract. The messenger's tier send is now one lane at a time, and it refuses a chain that is not on its destination list.

The trade-off is stated in the design: a mirror can lag Base. A lowered tier reaches a mirror as soon as its lane works and the budget can pay, or sooner if someone pays. A lane that never recovers is still bounded by the mirror's 60-day maximum age. Fresh deploy only, like the rest of the pre-live work.

Closes #898. Closes #911. Part of #1277: its reward-batch finding belongs to the reward remittance work. Follow-up #2849 retires the separate broadcast-free restamp, which this change makes unnecessary.
