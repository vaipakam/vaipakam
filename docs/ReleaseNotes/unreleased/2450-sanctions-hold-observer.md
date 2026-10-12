## Thread — the keeper keeps every held reward claimant observed, and settles the hold once its verdict is final (#2450)

**Problem.** The reward sanctions rule forfeits a flagged owner's undelivered interaction reward only once the flag is confirmed: a chain of authoritative flagged readings spanning three days, with no gap between readings longer than one day. Until then a first-flagged claimant's staged payout is held, and its staging record keeps the staging encumbrance raised. That encumbrance blocks custody activation and every reward-role change. Nothing observed held owners by itself, so a hold lasted three days only if someone happened to observe the owner at least daily. A longer gap restarted the window, and the block went on with it.

**What changed.** The keeper has a new pass, armed by its own flag, that runs hourly on every reward chain.
- **Who it watches.** It reads the chain's own sanctions-evidence events from the indexer. That covers every wallet with a live observation chain, plus every wallet whose chain cleared in the last thirty days, since such a wallet may still have a record held from before.
- **How it decides.** It classifies each wallet through the contract's one sanctions classifier, the same read the sweep and the claim use.
- **Held wallets.** It records a fresh observation once the latest is six hours old. That leaves three more chances before the one-day gap could break the chain.
- **Confirmed wallets.** It runs the owner forfeit sweep page by page. It then resolves the claimant's held staging records and domains, which forfeits the held share into the recycle bucket and closes the record.
- **Cleared wallets.** It resolves the same records, which now pay the claimant.
- **Cost.** Every write is simulated first and sent only if it would change something, so a settled owner costs reads, not gas. Every call is permissionless and moves value only into protocol custody or to the claimant's own venue, never to the keeper.

**Operator alerts.** The pass alerts the operator chat in three cases:
- a held claimant's next observation is due within one keeper interval, meaning the keeper's own observations are not landing;
- a hold outlasts its confirmation by more than the maximum gap, meaning an outage or a wedged record is holding the custody block;
- a wallet is held with no observation chain at all, meaning the sanctions oracle is not answering.

Alerts go through the ops bot, never the user-facing one, and each condition repeats at most every six hours. A new keeper table records which alerts were sent; it is disposable state.

**Operator steps.** Apply indexer migration 0057, then arm the pass on every reward chain before reward staging is live there. Set the ops bot token and chat id on the keeper with secret put; without them, alerts reach only the Worker log, and each attempt says so. The restore runbook now captures the new flag and the ops channel.

Closes #2450. Refs #1566, #1349.
