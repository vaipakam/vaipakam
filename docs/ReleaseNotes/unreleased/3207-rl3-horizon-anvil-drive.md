## Thread — the RL-3 claim-horizon safeguards are proven on Anvil before arming (PR #3211)

The governance runbook required both ratified claim-horizon safeguards to be "verified live first", before the horizon knob is set: the free pre-expiry notice in the in-app notification centre, and the Claim Center countdown. Neither can appear on a chain while the knob is zero, so the step could not be met as written.

A new connected-app e2e spec now drives both on the suite's local Anvil chain. It uses the repository's current contracts, configured as a canonical reward deployment by the same script the keeper's Anvil scenarios use. A real loan produces real interaction-reward entries, and the admin sets a 180-day horizon. The keeper-style touch starts each entry's clock. The Claim Center then states the contract's earliest-removal estimate, and switches to its final-notice wording once the notice period begins. When a touch arms the final notice, the bell shows the final-notice row, and when removal begins it shows the removal row. The whole drive runs inside a chain snapshot that is reverted afterwards, so later specs see the chain and its clock as they were.

The bell rows in that drive are not written by the test. The e2e indexer stub derives them from the chain's real horizon logs with the indexer's own planner. That planner now lives in the shared library, and the indexer re-exports it unchanged, so the drive tests the rule the indexer runs rather than a copy of it. Every other wallet still gets the stub's fixed synthetic feed.

Runbook Step 6 now says what can be checked when. Before arming, the safeguards are proven by this spec, which must be green on the commit the deployed app was built from. Right after arming, in the same ceremony, the countdown is re-verified live on the first entry the keeper touches. The notice cannot be seen live then, because a fresh entry reaches its final notice only a full horizon later. So the ceremony confirms the indexer release and records a follow-up to check the bell when the first notice lands. The notice period is what makes checking after arming safe: nothing can be removed before the owner has had the whole 90 days, and a failed check is answered by resetting the knob to zero.

Closes #3207.

> Caveat: the live bell check is deferred until the first final notice actually lands on the deployed chain, at least one full horizon after arming; it is recorded as a ceremony follow-up rather than performed in the ceremony itself.
