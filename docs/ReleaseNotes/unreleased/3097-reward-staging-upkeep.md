## Keeper — moves held reward claim days on to payment

A reward claim day that one call could not settle is held in a staging record, alone or inside a claimant's claim domain, and from then on only permissionless calls move it: preparing it, reserving what it pays once its day is covered, resolving it page by page, and stepping a legacy slice until it is consumed. Nothing made those calls, so a claimant waited for whoever happened to make them, a record that had started resolving (which has no deadline) never paid out, and a contested batch's priority window lapsed with nobody registered. The record of what backs each permissionless step listed these seven steps as gaps.

A new keeper duty, the reward staging upkeep, backs them, as the owner decided on #3097: every permissionless step gets a keeper backstop, and each ships switched off. Every hour, on every chain, it finds the open records, domains and legacy slices from the indexer's record of staging events and decides each from its own state on chain. It takes at most three pages per subject and a bounded number of subjects per run. A page that changes nothing the keeper reads leaves that subject alone for a day, since coverage depends on sources outside the record. It registers a record for a contested batch's priority window only when that makes it the oldest registrant, and uses the priority only when the next preparation would stage something.

Unwinding a record or domain that is past its deadline and cannot be covered, or that the protocol finds stale, has its own switch. An unwind returns exactly what the record held to where it came from; it is never a payout, and a record that has started resolving is never unwound. While the unwind switch is off, the duty names each unwind it left.

The keeper moves nothing of its own and receives nothing: every payout is the record's own, made by the protocol from storage. A claim payout the sanctions screen would hold is left to the sanctions-hold duty. Both switches ship unset.

Advances #3097: this is the group of its seven reward-staging steps.

> Caveat: the duty measures progress by re-reading each subject's state, because the staging entries return no progress flag on the live Diamonds.
