## Keeper — skips a mirror day whose delivery parts disagree, and recycles what landed (#2961)

A new keeper pass, the delivery-conflict pass, carries out the skip the contracts added for a mirror day whose delivered parts disagree on the day's whole. It runs every 15 minutes on mirror chains, behind its own switch (`REWARD_DELIVERY_CONFLICT_ENABLED`), and ships switched off.

- The keeper finds such days in the indexer's record of the delivery events, and looks at a day again whenever a later part lands on it, since that part may add value to move.
- Operators are alerted as soon as such a day is recorded. The alert says what landed against what the first part stated, and when the skip becomes allowed, which the keeper reads from the contract itself. If the skip waits for Base's broadcast for the day instead, the alert says so. If the keeper could not send the skip (no key, or its sends stopped), the alert says why.
- Once the contract allows it, the keeper skips the day. The day closes unpaid on that mirror, and every later day there moves again. It then moves the value that landed for the day into that mirror's recycling pool, call after call, until the contract reports nothing left.
- What was given up (each half the day would have priced, and the recycled commitment released) and what was moved are posted from the transactions' own events, not from the keeper's estimate.
- A day where a side whose claims may already have paid carries recycled funding cannot be skipped. That is reported as an incident for a person and the skip is never retried. The day stays in the keeper's work until that report has been delivered, so a failed post goes out again on the next run. The same holds for a day that opened before its parts disagreed, which stays paid and is reported as the source fault it is.
- Every call is simulated first, at most four a chain a run, and pays no fee. Every read stops at its stage cutoff, so the sends keep their time.

> Caveat: ships disarmed. Arming it is a separate owner decision.
> Caveat: it needs the contract change, so it reaches a chain with the fresh deploy, together with #2828.

(PR #2999)
