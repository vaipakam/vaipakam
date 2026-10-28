## Thread — keeper backstop for expired buyback intents and the tier LTV cache

Two permissionless housekeeping steps outside the reward system had nothing calling them on a schedule.

The first is a buyback intent that passes its expiry unfilled. It stays pending until someone rolls it back. Until then, the unfilled part of its reservation is kept out of the spendable buyback budget, its allowance to the limit-order protocol stays live, and it keeps one of the intent dispatcher's commitment slots.

The second is the per-tier loan-to-value cache. It only refreshes when someone calls for it, and a cached tier stops counting fourteen days after its last refresh. Loan initiation then falls back to the governance tier caps.

A new keeper duty, protocol upkeep, now makes both calls every hour on every chain it serves. It ships switched off, behind its own arming flag.

For buybacks, the keeper finds intents in the indexer's record of commitments. It decides each one from the intent's own on-chain record, using the chain's own clock, and rolls back only an intent that is past expiry and still pending.

For the tier cache, the keeper first previews the refresh and reads what it would write. It sends the refresh only when a tier's value would change, or when a tier was cached a week or more ago, which leaves a week of margin before the cache lapses. A chain whose peers give no reading therefore costs nothing. The run's report names each tier the refresh rejects, with the protocol's own reason. Nothing is refreshed while peer readings are paused.

Neither step pays a fee or moves value to the keeper. The keeper works a chain only when its connection answers for that chain. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision.
> Caveat: the commitments are read two hundred a run. Each run resumes where the previous run stopped, above a floor of intents that are no longer pending. That floor moves only on what the chain's finalized block shows, so a rollback that a reorg undoes is sent again.
> Caveat: the tier cache preview needs an RPC that supports `eth_simulateV1`. Without it the refresh is reported as unread and is not sent.
> Caveat: the week before an unchanged tier is refreshed is the default of a plain variable, `TIER_LTV_REFRESH_AFTER_SEC`.
